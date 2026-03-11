import type {
  DaytonaClient,
  DaytonaCreateParams,
  DaytonaExecResult,
  DaytonaSandboxData,
  DaytonaVolumeData,
} from './types.js'

const DEFAULT_API_URL = 'https://app.daytona.io/api'

export function createDaytonaRestClient(apiKey: string, apiUrl?: string): DaytonaClient {
  const baseUrl = (apiUrl ?? DEFAULT_API_URL).replace(/\/$/, '')

  async function request<T>(path: string, options?: RequestInit): Promise<T> {
    const res = await fetch(`${baseUrl}${path}`, {
      ...options,
      headers: {
        'Authorization': `Bearer ${apiKey}`,
        ...options?.headers,
      },
    })
    if (!res.ok) {
      const text = await res.text().catch(() => '')
      throw new Error(`Daytona API ${res.status}: ${text || res.statusText}`)
    }
    if (res.status === 204) return undefined as T
    return res.json() as Promise<T>
  }

  /** Resolve the per-sandbox toolbox proxy URL */
  async function getToolboxUrl(sandboxId: string): Promise<string> {
    const data = await request<{ url: string }>(`/sandbox/${sandboxId}/toolbox-proxy-url`)
    return data.url.replace(/\/$/, '')
  }

  async function toolboxFetch(sandboxId: string, path: string, options?: RequestInit): Promise<Response> {
    const toolboxUrl = await getToolboxUrl(sandboxId)
    const res = await fetch(`${toolboxUrl}/${sandboxId}${path}`, {
      ...options,
      headers: {
        'Authorization': `Bearer ${apiKey}`,
        ...options?.headers,
      },
    })
    if (!res.ok) {
      const text = await res.text().catch(() => '')
      throw new Error(`Daytona Toolbox ${res.status}: ${text || res.statusText}`)
    }
    return res
  }

  return {
    async createSandbox(config: DaytonaCreateParams): Promise<DaytonaSandboxData> {
      return request<DaytonaSandboxData>('/sandbox', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(config),
      })
    },

    async getSandbox(id: string): Promise<DaytonaSandboxData> {
      return request<DaytonaSandboxData>(`/sandbox/${id}`)
    },

    async listSandboxes(limit?: number): Promise<DaytonaSandboxData[]> {
      const params = limit != null ? `?limit=${limit}` : ''
      return request<DaytonaSandboxData[]>(`/sandbox${params}`)
    },

    async deleteSandbox(id: string): Promise<void> {
      await request<void>(`/sandbox/${id}`, { method: 'DELETE' })
    },

    async exec(sandboxId: string, command: string, cwd?: string, timeout?: number): Promise<DaytonaExecResult> {
      const res = await toolboxFetch(sandboxId, '/process/execute', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ command, cwd, timeout }),
      })
      const data = await res.json() as { exitCode: number; result?: string }
      return { exitCode: data.exitCode, stdout: data.result ?? '' }
    },

    async writeFile(sandboxId: string, path: string, content: string | Uint8Array): Promise<void> {
      const bytes = typeof content === 'string' ? new TextEncoder().encode(content) : content
      const blob = new Blob([bytes.buffer as ArrayBuffer], { type: 'application/octet-stream' })
      const formData = new FormData()
      formData.append('file', blob, path.split('/').pop() ?? 'file')
      formData.append('path', path)

      await toolboxFetch(sandboxId, '/files/upload', {
        method: 'POST',
        body: formData,
      })
    },

    async readFile(sandboxId: string, path: string): Promise<Uint8Array> {
      const res = await toolboxFetch(
        sandboxId,
        `/files/download?path=${encodeURIComponent(path)}`,
      )
      return new Uint8Array(await res.arrayBuffer())
    },

    async getPreviewUrl(sandboxId: string, port: number): Promise<string> {
      const data = await request<{ url: string }>(`/sandbox/${sandboxId}/ports/${port}/preview-url`)
      return data.url
    },

    async createVolume(name: string): Promise<DaytonaVolumeData> {
      return request<DaytonaVolumeData>('/volume', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ name }),
      })
    },

    async deleteVolume(id: string): Promise<void> {
      await request<void>(`/volume/${id}`, { method: 'DELETE' })
    },

    async listVolumes(): Promise<DaytonaVolumeData[]> {
      return request<DaytonaVolumeData[]>('/volume')
    },
  }
}
