import type {
  BoxLiteAdapterConfig,
  BoxLiteBox,
  BoxLiteCreateParams,
  BoxLiteExecRequest,
  BoxLiteExecution,
  BoxLiteSnapshot,
  BoxLiteTokenResponse,
} from './types.js'

export function createBoxLiteClient(config: BoxLiteAdapterConfig) {
  const { apiUrl } = config
  const prefix = config.prefix ?? 'default'
  const baseUrl = apiUrl.replace(/\/$/, '') + '/v1'

  // --- Token management ---
  let token = config.apiToken ?? ''
  let tokenExpiresAt = 0

  async function ensureToken(): Promise<string> {
    // If a static token was provided, always use it
    if (config.apiToken) return config.apiToken

    // If we have a valid cached token, use it
    if (token && Date.now() < tokenExpiresAt) return token

    // Acquire token via OAuth2 client credentials
    if (!config.clientId || !config.clientSecret) {
      throw new Error('BoxLite: either apiToken or clientId+clientSecret must be provided')
    }

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
    // Refresh 60s before expiry
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
    const url = `${baseUrl}/${prefix}${path}`
    const response = await fetch(url, {
      ...options,
      headers: {
        'Authorization': `Bearer ${bearerToken}`,
        'Content-Type': 'application/json',
        ...options.headers,
      },
    })

    if (rawResponse) return response

    if (!response.ok) {
      const body = await response.text()
      throw new Error(`BoxLite API error ${response.status}: ${body}`)
    }

    const text = await response.text()
    if (!text) return {} as T
    return JSON.parse(text) as T
  }

  /**
   * Parse SSE data field — may be JSON `{"data":"<base64>"}` or raw base64.
   */
  function decodeSSEData(raw: string): string {
    try {
      const parsed = JSON.parse(raw) as { data: string }
      if (parsed.data) return atob(parsed.data)
    } catch {
      // Fall through to raw base64
    }
    return atob(raw)
  }

  /**
   * Consume an SSE stream from BoxLite exec output.
   * SSE events: stdout/stderr data is base64-encoded, exit event has exit_code.
   */
  function parseSSE(text: string): { stdout: string; stderr: string; exitCode: number } {
    let stdout = ''
    let stderr = ''
    let exitCode = 0

    const lines = text.split('\n')
    let currentEvent = ''

    for (const line of lines) {
      if (line.startsWith('event:')) {
        currentEvent = line.slice(6).trim()
      } else if (line.startsWith('data:')) {
        const data = line.slice(5).trim()
        if (currentEvent === 'stdout') {
          stdout += decodeSSEData(data)
        } else if (currentEvent === 'stderr') {
          stderr += decodeSSEData(data)
        } else if (currentEvent === 'exit') {
          try {
            const parsed = JSON.parse(data) as { exit_code: number }
            exitCode = parsed.exit_code
          } catch {
            exitCode = parseInt(data, 10) || 0
          }
        }
      }
    }

    return { stdout, stderr, exitCode }
  }

  return {
    // --- Box lifecycle ---

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
      const data = await request<{ boxes: BoxLiteBox[] }>(`/boxes${qs ? `?${qs}` : ''}`)
      return data.boxes ?? []
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

    // --- Exec ---

    async exec(
      boxId: string,
      req: BoxLiteExecRequest,
    ): Promise<{ stdout: string; stderr: string; exitCode: number }> {
      // 1. POST /exec to start execution
      const execution = await request<BoxLiteExecution>(`/boxes/${boxId}/exec`, {
        method: 'POST',
        body: JSON.stringify(req),
      })

      // 2. GET /executions/{id}/output — SSE stream
      const response = await request(
        `/boxes/${boxId}/executions/${execution.execution_id}/output`,
        { headers: { 'Accept': 'text/event-stream' } },
        true,
      )

      if (!response.ok) {
        const body = await response.text()
        throw new Error(`BoxLite API error ${response.status}: ${body}`)
      }

      const sseText = await response.text()
      return parseSSE(sseText)
    },

    async execStream(
      boxId: string,
      req: BoxLiteExecRequest,
    ): Promise<ReadableStream<Uint8Array>> {
      // 1. POST /exec to start execution
      const execution = await request<BoxLiteExecution>(`/boxes/${boxId}/exec`, {
        method: 'POST',
        body: JSON.stringify(req),
      })

      // 2. GET /executions/{id}/output — return raw SSE stream
      const response = await request(
        `/boxes/${boxId}/executions/${execution.execution_id}/output`,
        { headers: { 'Accept': 'text/event-stream' } },
        true,
      )

      if (!response.ok) {
        const body = await response.text()
        throw new Error(`BoxLite API error ${response.status}: ${body}`)
      }

      if (!response.body) {
        throw new Error('BoxLite exec stream: no response body')
      }

      // Transform SSE events into decoded data chunks
      const decoder = new TextDecoder()
      let buffer = ''

      return response.body.pipeThrough(
        new TransformStream<Uint8Array, Uint8Array>({
          transform(chunk, controller) {
            buffer += decoder.decode(chunk, { stream: true })
            const lines = buffer.split('\n')
            buffer = lines.pop() ?? ''

            let currentEvent = ''
            for (const line of lines) {
              if (line.startsWith('event:')) {
                currentEvent = line.slice(6).trim()
              } else if (line.startsWith('data:')) {
                const data = line.slice(5).trim()
                if (currentEvent === 'stdout' || currentEvent === 'stderr') {
                  const decoded = decodeSSEData(data)
                  controller.enqueue(new TextEncoder().encode(decoded))
                }
              }
            }
          },
          flush(controller) {
            if (buffer) {
              const lines = buffer.split('\n')
              let currentEvent = ''
              for (const line of lines) {
                if (line.startsWith('event:')) {
                  currentEvent = line.slice(6).trim()
                } else if (line.startsWith('data:')) {
                  const data = line.slice(5).trim()
                  if (currentEvent === 'stdout' || currentEvent === 'stderr') {
                    const decoded = decodeSSEData(data)
                    controller.enqueue(new TextEncoder().encode(decoded))
                  }
                }
              }
            }
            controller.terminate()
          },
        }),
      )
    },

    // --- Files (native tar API) ---

    async uploadFiles(boxId: string, path: string, tarData: Uint8Array): Promise<void> {
      const bearerToken = await ensureToken()
      const url = `${baseUrl}/${prefix}/boxes/${boxId}/files?path=${encodeURIComponent(path)}`
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
      const url = `${baseUrl}/${prefix}/boxes/${boxId}/files?path=${encodeURIComponent(path)}`
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

    // --- Snapshots ---

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
  }
}

export type BoxLiteClient = ReturnType<typeof createBoxLiteClient>
