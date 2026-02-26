/**
 * CloudflareHttpAdapter — test-only adapter that proxies SandboxAdapter
 * calls to the deployed CF e2e Worker over HTTP.
 *
 * This lets us run the same conformance tests against Cloudflare without
 * needing `DurableObjectNamespace` bindings (which require the Workers runtime).
 */
import type {
  SandboxAdapter,
  AdapterSandbox,
  Capability,
  CreateConfig,
  ExecOptions,
  ExecResult,
  ListFilter,
  SandboxInfo,
  SandboxState,
} from '@sandbank/core'

export interface CloudflareHttpAdapterConfig {
  workerUrl: string
}

interface TrackedSandbox {
  id: string
  state: SandboxState
  createdAt: string
}

export class CloudflareHttpAdapter implements SandboxAdapter {
  readonly name = 'cloudflare'
  readonly capabilities: ReadonlySet<Capability> = new Set<Capability>([
    'exec.stream',
    'port.expose',
  ])

  private readonly workerUrl: string
  private readonly sandboxes = new Map<string, TrackedSandbox>()

  constructor(config: CloudflareHttpAdapterConfig) {
    this.workerUrl = config.workerUrl.replace(/\/$/, '')
  }

  async createSandbox(_config: CreateConfig): Promise<AdapterSandbox> {
    const res = await this.post<{ id: string }>('/create', {})
    const id = res.id

    // Poll until the sandbox is ready (CF containers can take 30-90s to cold-start)
    await this.waitForReady(id)

    const now = new Date().toISOString()
    const tracked: TrackedSandbox = { id, state: 'running', createdAt: now }
    this.sandboxes.set(id, tracked)

    return this.buildAdapterSandbox(tracked)
  }

  async getSandbox(id: string): Promise<AdapterSandbox> {
    const tracked = this.sandboxes.get(id)
    if (!tracked) {
      throw new Error(`Sandbox ${id} not found in local tracking`)
    }
    return this.buildAdapterSandbox(tracked)
  }

  async listSandboxes(_filter?: ListFilter): Promise<SandboxInfo[]> {
    return Array.from(this.sandboxes.values()).map((s) => ({
      id: s.id,
      state: s.state,
      createdAt: s.createdAt,
      image: 'cloudflare-sandbox',
    }))
  }

  async destroySandbox(id: string): Promise<void> {
    try {
      await this.post('/destroy', { id })
    } catch {
      // Idempotent: ignore errors
    }
    this.sandboxes.delete(id)
  }

  // --- Private helpers ---

  private async waitForReady(id: string): Promise<void> {
    const maxAttempts = 30
    const intervalMs = 3_000
    const controller = new AbortController()
    const timeout = setTimeout(() => controller.abort(), 90_000)

    try {
      for (let i = 0; i < maxAttempts; i++) {
        if (controller.signal.aborted) break
        try {
          const res = await this.post<{ exitCode: number; stdout: string; stderr: string }>(
            '/exec',
            { id, command: 'echo ready' },
          )
          if (res.exitCode === 0 && res.stdout.includes('ready')) {
            return
          }
        } catch {
          // Container not ready yet
        }
        await new Promise((resolve) => setTimeout(resolve, intervalMs))
      }
      throw new Error(`Sandbox ${id} did not become ready within 90s`)
    } finally {
      clearTimeout(timeout)
    }
  }

  private buildAdapterSandbox(tracked: TrackedSandbox): AdapterSandbox {
    const adapter = this
    return {
      id: tracked.id,
      get state() {
        return tracked.state
      },
      createdAt: tracked.createdAt,

      async exec(command: string, options?: ExecOptions): Promise<ExecResult> {
        return adapter.post<ExecResult>('/exec', {
          id: tracked.id,
          command,
          timeout: options?.timeout,
          cwd: options?.cwd,
        })
      },

      async writeFile(path: string, content: string | Uint8Array): Promise<void> {
        if (content instanceof Uint8Array) {
          const b64 = uint8ArrayToBase64(content)
          await adapter.post('/write-file', {
            id: tracked.id,
            path,
            content: b64,
            binary: true,
          })
        } else {
          await adapter.post('/write-file', {
            id: tracked.id,
            path,
            content,
            binary: false,
          })
        }
      },

      async readFile(path: string): Promise<Uint8Array> {
        const res = await adapter.post<{ content: string }>('/read-file', {
          id: tracked.id,
          path,
        })
        return base64ToUint8Array(res.content)
      },

      async execStream(command: string): Promise<ReadableStream<Uint8Array>> {
        const res = await fetch(`${adapter.workerUrl}/exec-stream`, {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ id: tracked.id, command }),
        })
        if (!res.ok) {
          const text = await res.text()
          throw new Error(`exec-stream failed (${res.status}): ${text}`)
        }
        return res.body as ReadableStream<Uint8Array>
      },

      async exposePort(port: number): Promise<{ url: string }> {
        return adapter.post<{ url: string }>('/expose-port', {
          id: tracked.id,
          port,
        })
      },
    }
  }

  private async post<T>(path: string, body: unknown): Promise<T> {
    const res = await fetch(`${this.workerUrl}${path}`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(body),
    })
    const data = (await res.json()) as T & { error?: string }
    if (!res.ok || data.error) {
      throw new Error(data.error ?? `HTTP ${res.status}`)
    }
    return data
  }
}

function uint8ArrayToBase64(bytes: Uint8Array): string {
  let binary = ''
  for (let i = 0; i < bytes.length; i++) {
    binary += String.fromCharCode(bytes[i])
  }
  return btoa(binary)
}

function base64ToUint8Array(b64: string): Uint8Array {
  const binary = atob(b64)
  const bytes = new Uint8Array(binary.length)
  for (let i = 0; i < binary.length; i++) {
    bytes[i] = binary.charCodeAt(i)
  }
  return bytes
}
