import type {
  AdapterSandbox,
  Capability,
  CreateConfig,
  ExecOptions,
  ExecResult,
  ListFilter,
  SandboxAdapter,
  SandboxInfo,
  SandboxState,
} from '@sandbank.dev/core'
import { SandboxNotFoundError, ProviderError } from '@sandbank.dev/core'
import { createX402Fetch } from './x402-fetch.js'
import type { SandbankCloudConfig, CloudBox, CloudExecResult } from './types.js'

function mapState(status: string): SandboxState {
  switch (status) {
    case 'running':
      return 'running'
    case 'stopped':
    case 'terminated':
      return 'stopped'
    default:
      return 'error'
  }
}

function isNotFound(err: unknown): boolean {
  const msg = err instanceof Error ? err.message : String(err)
  return msg.includes('404') || msg.includes('Not found')
}

function wrapBox(
  box: CloudBox,
  api: ReturnType<typeof createX402Fetch>,
): AdapterSandbox {
  const portMap = new Map<number, number>()
  if (box.ports) {
    for (const [guest, host] of Object.entries(box.ports)) {
      portMap.set(parseInt(guest), host)
    }
  }

  return {
    get id() { return box.id },
    get state() { return mapState(box.status) },
    get createdAt() { return box.created_at },

    async exec(command: string, options?: ExecOptions): Promise<ExecResult> {
      const result = await api.x402Fetch<CloudExecResult>(`/boxes/${box.id}/exec`, {
        method: 'POST',
        body: JSON.stringify({
          cmd: ['bash', '-c', command],
          working_dir: options?.cwd,
          timeout_seconds: options?.timeout ? Math.ceil(options.timeout / 1000) : undefined,
        }),
      })
      return {
        exitCode: result.exit_code,
        stdout: result.stdout ?? '',
        stderr: result.stderr ?? '',
      }
    },

    async execStream(command: string, options?: ExecOptions): Promise<ReadableStream<Uint8Array>> {
      const result = await api.x402Fetch<CloudExecResult>(`/boxes/${box.id}/exec`, {
        method: 'POST',
        body: JSON.stringify({
          cmd: ['bash', '-c', command],
          working_dir: options?.cwd,
          timeout_seconds: options?.timeout ? Math.ceil(options.timeout / 1000) : undefined,
        }),
      })

      const encoder = new TextEncoder()
      return new ReadableStream<Uint8Array>({
        start(controller) {
          if (result.stdout) controller.enqueue(encoder.encode(result.stdout))
          if (result.stderr) controller.enqueue(encoder.encode(result.stderr))
          controller.close()
        },
      })
    },

    async uploadArchive(archive: Uint8Array | ReadableStream, destDir?: string): Promise<void> {
      let data: Uint8Array
      if (archive instanceof Uint8Array) {
        data = archive
      } else {
        const reader = archive.getReader()
        const chunks: Uint8Array[] = []
        while (true) {
          const { done, value } = await reader.read()
          if (done) break
          chunks.push(value)
        }
        const totalLength = chunks.reduce((sum, c) => sum + c.length, 0)
        data = new Uint8Array(totalLength)
        let offset = 0
        for (const chunk of chunks) {
          data.set(chunk, offset)
          offset += chunk.length
        }
      }

      const path = destDir ?? '/'
      const resp = await api.x402FetchRaw(`/boxes/${box.id}/files?path=${encodeURIComponent(path)}`, {
        method: 'PUT',
        headers: { 'Content-Type': 'application/x-tar' },
        body: data.buffer.slice(data.byteOffset, data.byteOffset + data.byteLength) as ArrayBuffer,
      })
      if (!resp.ok) {
        const body = await resp.text()
        throw new Error(`Upload failed ${resp.status}: ${body}`)
      }
    },

    async downloadArchive(srcDir?: string): Promise<ReadableStream> {
      const path = srcDir ?? '/'
      const resp = await api.x402FetchRaw(`/boxes/${box.id}/files?path=${encodeURIComponent(path)}`, {
        headers: { 'Accept': 'application/x-tar' },
      })
      if (!resp.ok) {
        const body = await resp.text()
        throw new Error(`Download failed ${resp.status}: ${body}`)
      }
      if (!resp.body) throw new Error('No response body')
      return resp.body
    },

    async exposePort(port: number): Promise<{ url: string }> {
      const hostPort = portMap.get(port)
      if (hostPort) {
        try {
          const host = new URL(api.baseUrl).hostname
          return { url: `http://${host}:${hostPort}` }
        } catch {}
      }
      // Fallback to proxy URL
      return { url: `${api.baseUrl}/v1/boxes/${box.id}/proxy/${port}/` }
    },
  }
}

export class SandbankCloudAdapter implements SandboxAdapter {
  readonly name = 'sandbank-cloud'
  readonly capabilities: ReadonlySet<Capability> = new Set([
    'exec.stream',
    'port.expose',
  ])

  private readonly api: ReturnType<typeof createX402Fetch>

  constructor(config: SandbankCloudConfig = {}) {
    this.api = createX402Fetch(config)
  }

  async createSandbox(config: CreateConfig): Promise<AdapterSandbox> {
    try {
      const body: Record<string, unknown> = {
        image: config.image ?? 'codebox',
        cpu: config.resources?.cpu,
        memory_mb: config.resources?.memory,
      }
      if (config.ports) {
        body.ports = config.ports
      }

      const box = await this.api.x402Fetch<CloudBox>('/boxes', {
        method: 'POST',
        body: JSON.stringify(body),
      })

      return wrapBox(box, this.api)
    } catch (err) {
      if (err instanceof ProviderError) throw err
      throw new ProviderError('sandbank-cloud', err)
    }
  }

  async getSandbox(id: string): Promise<AdapterSandbox> {
    try {
      const box = await this.api.x402Fetch<CloudBox>(`/boxes/${id}`)
      return wrapBox(box, this.api)
    } catch (err) {
      if (isNotFound(err)) throw new SandboxNotFoundError('sandbank-cloud', id)
      throw new ProviderError('sandbank-cloud', err, id)
    }
  }

  async listSandboxes(filter?: ListFilter): Promise<SandboxInfo[]> {
    try {
      const qs = filter?.state ? `?status=${filter.state}` : ''
      const boxes = await this.api.x402Fetch<CloudBox[]>(`/boxes${qs}`)

      let infos: SandboxInfo[] = boxes.map((b) => ({
        id: b.id,
        state: mapState(b.status),
        createdAt: b.created_at,
        image: b.image,
      }))

      if (filter?.limit) {
        infos = infos.slice(0, filter.limit)
      }
      return infos
    } catch (err) {
      throw new ProviderError('sandbank-cloud', err)
    }
  }

  async destroySandbox(id: string): Promise<void> {
    try {
      await this.api.x402Fetch(`/boxes/${id}`, { method: 'DELETE' })
    } catch (err) {
      if (isNotFound(err)) return
      throw new ProviderError('sandbank-cloud', err, id)
    }
  }
}
