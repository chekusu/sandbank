import type {
  BoxLiteBox,
  BoxLiteClient,
  BoxLiteCreateParams,
  BoxLiteExecRequest,
  BoxLiteExecution,
  BoxLiteRemoteConfig,
  BoxLiteSnapshot,
  BoxLiteTokenResponse,
} from './types.js'

/**
 * Create a BoxLite REST client for communicating with a BoxRun REST API.
 * Used in remote mode.
 */
export function createBoxLiteRestClient(config: BoxLiteRemoteConfig): BoxLiteClient {
  const { apiUrl } = config
  const prefix = config.prefix ?? ''
  const baseUrl = apiUrl.replace(/\/$/, '') + '/v1'

  // --- Token management ---
  let token = config.apiToken ?? ''
  let tokenExpiresAt = 0

  async function ensureToken(): Promise<string> {
    if (config.apiToken) return config.apiToken
    if (!config.clientId || !config.clientSecret) return ''
    if (token && Date.now() < tokenExpiresAt) return token

    const response = await fetch(`${baseUrl}/oauth/tokens`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
      body: new URLSearchParams({
        grant_type: 'client_credentials',
        client_id: config.clientId,
        client_secret: config.clientSecret,
      }),
    })

    if (!response.ok) {
      const body = await response.text()
      throw new Error(`BoxLite OAuth2 error ${response.status}: ${body}`)
    }

    const data = await response.json() as BoxLiteTokenResponse
    token = data.access_token
    tokenExpiresAt = Date.now() + (data.expires_in - 60) * 1000
    return token
  }

  async function request<T>(path: string, options?: RequestInit, rawResponse?: false): Promise<T>
  async function request(path: string, options: RequestInit, rawResponse: true): Promise<Response>
  async function request<T>(
    path: string,
    options: RequestInit = {},
    rawResponse = false,
  ): Promise<T | Response> {
    const bearerToken = await ensureToken()
    const url = prefix ? `${baseUrl}/${prefix}${path}` : `${baseUrl}${path}`
    const headers: Record<string, string> = {
      'Content-Type': 'application/json',
      ...options.headers as Record<string, string>,
    }
    if (bearerToken) {
      headers['Authorization'] = `Bearer ${bearerToken}`
    }
    const response = await fetch(url, { ...options, headers })

    if (rawResponse) return response

    if (!response.ok) {
      const body = await response.text()
      throw new Error(`BoxLite API error ${response.status}: ${body}`)
    }

    const text = await response.text()
    if (!text) return {} as T
    return JSON.parse(text) as T
  }

  return {
    async createBox(params: BoxLiteCreateParams): Promise<BoxLiteBox> {
      return request<BoxLiteBox>('/boxes', {
        method: 'POST',
        body: JSON.stringify(params),
      })
    },

    async getBox(boxId: string): Promise<BoxLiteBox> {
      return request<BoxLiteBox>(`/boxes/${boxId}`)
    },

    async listBoxes(status?: string, pageSize?: number): Promise<BoxLiteBox[]> {
      const params = new URLSearchParams()
      if (status) params.set('status', status)
      if (pageSize) params.set('page_size', String(pageSize))
      const qs = params.toString()
      const data = await request<BoxLiteBox[] | { boxes?: BoxLiteBox[] }>(`/boxes${qs ? `?${qs}` : ''}`)
      if (Array.isArray(data)) return data
      return (data as { boxes?: BoxLiteBox[] }).boxes ?? []
    },

    async deleteBox(boxId: string, force = false): Promise<void> {
      await request(`/boxes/${boxId}${force ? '?force=true' : ''}`, {
        method: 'DELETE',
      })
    },

    async startBox(boxId: string): Promise<void> {
      await request(`/boxes/${boxId}/start`, { method: 'POST' })
    },

    async stopBox(boxId: string): Promise<void> {
      await request(`/boxes/${boxId}/stop`, { method: 'POST' })
    },

    async exec(
      boxId: string,
      req: BoxLiteExecRequest,
    ): Promise<{ stdout: string; stderr: string; exitCode: number }> {
      const execution = await request<BoxLiteExecution>(`/boxes/${boxId}/exec`, {
        method: 'POST',
        body: JSON.stringify(req),
      })

      if (execution.exit_code !== null && execution.exit_code !== undefined) {
        return {
          stdout: execution.stdout ?? '',
          stderr: execution.stderr ?? '',
          exitCode: execution.exit_code,
        }
      }

      const timeoutMs = (req.timeout_seconds ?? 300) * 1000
      const startTime = Date.now()
      let pollInterval = 100

      while (Date.now() - startTime < timeoutMs) {
        await new Promise(r => setTimeout(r, pollInterval))
        pollInterval = Math.min(pollInterval * 2, 2000)

        const result = await request<BoxLiteExecution>(
          `/boxes/${boxId}/exec/${execution.id}`,
        )

        if (result.exit_code !== null && result.exit_code !== undefined) {
          return {
            stdout: result.stdout ?? '',
            stderr: result.stderr ?? '',
            exitCode: result.exit_code,
          }
        }
      }

      throw new Error('BoxLite exec timed out waiting for completion')
    },

    async execStream(
      boxId: string,
      req: BoxLiteExecRequest,
    ): Promise<ReadableStream<Uint8Array>> {
      const execution = await request<BoxLiteExecution>(`/boxes/${boxId}/exec`, {
        method: 'POST',
        body: JSON.stringify(req),
      })

      const encoder = new TextEncoder()
      const self = { request }

      return new ReadableStream<Uint8Array>({
        async start(controller) {
          if (execution.exit_code !== null && execution.exit_code !== undefined) {
            if (execution.stdout) controller.enqueue(encoder.encode(execution.stdout))
            if (execution.stderr) controller.enqueue(encoder.encode(execution.stderr))
            controller.close()
            return
          }

          const timeoutMs = (req.timeout_seconds ?? 300) * 1000
          const startTime = Date.now()
          let pollInterval = 100

          while (Date.now() - startTime < timeoutMs) {
            await new Promise(r => setTimeout(r, pollInterval))
            pollInterval = Math.min(pollInterval * 2, 2000)

            try {
              const result = await self.request<BoxLiteExecution>(
                `/boxes/${boxId}/exec/${execution.id}`,
              )

              if (result.exit_code !== null && result.exit_code !== undefined) {
                if (result.stdout) controller.enqueue(encoder.encode(result.stdout))
                if (result.stderr) controller.enqueue(encoder.encode(result.stderr))
                controller.close()
                return
              }
            } catch (err) {
              controller.error(err)
              return
            }
          }

          controller.error(new Error('BoxLite exec stream timed out'))
        },
      })
    },

    async uploadFiles(boxId: string, path: string, tarData: Uint8Array): Promise<void> {
      const bearerToken = await ensureToken()
      const url = `${baseUrl}${prefix ? `/${prefix}` : ''}/boxes/${boxId}/files?path=${encodeURIComponent(path)}`
      const response = await fetch(url, {
        method: 'PUT',
        headers: {
          'Authorization': `Bearer ${bearerToken}`,
          'Content-Type': 'application/x-tar',
        },
        body: tarData.buffer.slice(tarData.byteOffset, tarData.byteOffset + tarData.byteLength) as ArrayBuffer,
      })

      if (!response.ok) {
        const body = await response.text()
        throw new Error(`BoxLite API error ${response.status}: ${body}`)
      }
    },

    async downloadFiles(boxId: string, path: string): Promise<ReadableStream<Uint8Array>> {
      const bearerToken = await ensureToken()
      const url = `${baseUrl}${prefix ? `/${prefix}` : ''}/boxes/${boxId}/files?path=${encodeURIComponent(path)}`
      const response = await fetch(url, {
        headers: {
          'Authorization': `Bearer ${bearerToken}`,
          'Accept': 'application/x-tar',
        },
      })

      if (!response.ok) {
        const body = await response.text()
        throw new Error(`BoxLite API error ${response.status}: ${body}`)
      }

      if (!response.body) {
        throw new Error('BoxLite download: no response body')
      }

      return response.body
    },

    async createSnapshot(boxId: string, name: string): Promise<BoxLiteSnapshot> {
      return request<BoxLiteSnapshot>(`/boxes/${boxId}/snapshots`, {
        method: 'POST',
        body: JSON.stringify({ name }),
      })
    },

    async restoreSnapshot(boxId: string, name: string): Promise<void> {
      await request(`/boxes/${boxId}/snapshots/${encodeURIComponent(name)}/restore`, {
        method: 'POST',
      })
    },

    async listSnapshots(boxId: string): Promise<BoxLiteSnapshot[]> {
      return request<BoxLiteSnapshot[]>(`/boxes/${boxId}/snapshots`)
    },

    async deleteSnapshot(boxId: string, name: string): Promise<void> {
      await request(`/boxes/${boxId}/snapshots/${encodeURIComponent(name)}`, {
        method: 'DELETE',
      })
    },

    async cloneBox(boxId: string, name?: string): Promise<BoxLiteBox> {
      return request<BoxLiteBox>(`/boxes/${boxId}/clone`, {
        method: 'POST',
        body: JSON.stringify(name ? { name } : {}),
      })
    },

    async exportBox(boxId: string): Promise<ReadableStream<Uint8Array>> {
      const response = await request(`/boxes/${boxId}/export`, { method: 'POST' }, true)
      if (!response.ok) {
        const body = await response.text()
        throw new Error(`BoxLite API error ${response.status}: ${body}`)
      }
      if (!response.body) throw new Error('BoxLite export: no response body')
      return response.body
    },

    async importBox(data: Uint8Array): Promise<BoxLiteBox> {
      const bearerToken = await ensureToken()
      const url = `${baseUrl}${prefix ? `/${prefix}` : ''}/boxes/import`
      const response = await fetch(url, {
        method: 'POST',
        headers: {
          'Authorization': `Bearer ${bearerToken}`,
          'Content-Type': 'application/octet-stream',
        },
        body: data.buffer.slice(data.byteOffset, data.byteOffset + data.byteLength) as ArrayBuffer,
      })
      if (!response.ok) {
        const body = await response.text()
        throw new Error(`BoxLite API error ${response.status}: ${body}`)
      }
      return response.json() as Promise<BoxLiteBox>
    },

    async execAsync(
      boxId: string,
      req: BoxLiteExecRequest,
    ): Promise<BoxLiteExecution> {
      return request<BoxLiteExecution>(`/boxes/${boxId}/exec`, {
        method: 'POST',
        body: JSON.stringify(req),
      })
    },

    async getExecOutput(boxId: string, execId: string): Promise<ReadableStream<Uint8Array>> {
      const response = await request(
        `/boxes/${boxId}/exec/${execId}/output`,
        { headers: { 'Accept': 'text/event-stream' } as Record<string, string> },
        true,
      )
      if (!response.ok) {
        const body = await response.text()
        throw new Error(`BoxLite API error ${response.status}: ${body}`)
      }
      if (!response.body) throw new Error('BoxLite SSE: no response body')
      return response.body
    },

    async sendExecInput(boxId: string, execId: string, data: string): Promise<void> {
      await request(`/boxes/${boxId}/exec/${execId}/input`, {
        method: 'POST',
        body: JSON.stringify({ data }),
      })
    },

    async signalExec(boxId: string, execId: string, signal: number): Promise<void> {
      await request(`/boxes/${boxId}/exec/${execId}/signal`, {
        method: 'POST',
        body: JSON.stringify({ signal }),
      })
    },

    async resizeExec(boxId: string, execId: string, cols: number, rows: number): Promise<void> {
      await request(`/boxes/${boxId}/exec/${execId}/resize`, {
        method: 'POST',
        body: JSON.stringify({ cols, rows }),
      })
    },

    async getMetrics(): Promise<Record<string, unknown>> {
      return request<Record<string, unknown>>('/metrics')
    },

    async getBoxMetrics(boxId: string): Promise<Record<string, unknown>> {
      return request<Record<string, unknown>>(`/boxes/${boxId}/metrics`)
    },

    async getConfig(): Promise<Record<string, unknown>> {
      return request<Record<string, unknown>>('/config')
    },
  }
}
