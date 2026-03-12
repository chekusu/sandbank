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
  TerminalInfo,
  TerminalOptions,
} from '@sandbank.dev/core'
import { SandboxNotFoundError, ProviderError } from '@sandbank.dev/core'
import { createBoxLiteRestClient } from './client.js'
import { createBoxLiteLocalClient } from './local-client.js'
import type { BoxLiteAdapterConfig, BoxLiteBox, BoxLiteClient } from './types.js'

/** Map BoxLite box status to Sandbank SandboxState */
function mapState(status: string): SandboxState {
  switch (status) {
    case 'configured':
      return 'creating'
    case 'running':
      return 'running'
    case 'stopping':
    case 'stopped':
    case 'paused':
      return 'stopped'
    default:
      return 'error'
  }
}

/** Resolve the host used for port exposure and terminal URLs */
function resolveHost(config: BoxLiteAdapterConfig): string {
  if (config.mode === 'local') return '127.0.0.1'
  try {
    return new URL(config.apiUrl).hostname
  } catch {
    return config.apiUrl
  }
}

/** Wrap a BoxLite box into an AdapterSandbox */
function wrapBox(
  box: BoxLiteBox,
  client: BoxLiteClient,
  host: string,
  portMappings: Map<number, number>,
): AdapterSandbox {
  return {
    get id() { return box.id },
    get state() { return mapState(box.status) },
    get createdAt() { return box.created_at },

    async exec(command: string, options?: ExecOptions): Promise<ExecResult> {
      const result = await client.exec(box.id, {
        cmd: ['bash', '-c', command],
        working_dir: options?.cwd,
        timeout_seconds: options?.timeout ? Math.ceil(options.timeout / 1000) : undefined,
      })
      return {
        exitCode: result.exitCode,
        stdout: result.stdout,
        stderr: result.stderr,
      }
    },

    async execStream(command: string, options?: ExecOptions): Promise<ReadableStream<Uint8Array>> {
      return client.execStream(box.id, {
        cmd: ['bash', '-c', command],
        working_dir: options?.cwd,
        timeout_seconds: options?.timeout ? Math.ceil(options.timeout / 1000) : undefined,
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
      await client.uploadFiles(box.id, destDir ?? '/', data)
    },

    async downloadArchive(srcDir?: string): Promise<ReadableStream> {
      return client.downloadFiles(box.id, srcDir ?? '/')
    },

    async sleep(): Promise<void> {
      await client.stopBox(box.id)
    },

    async wake(): Promise<void> {
      await client.startBox(box.id)
    },

    async createSnapshot(name?: string): Promise<{ snapshotId: string }> {
      const snapshotName = name ?? `snap-${Date.now()}`
      await client.createSnapshot(box.id, snapshotName)
      return { snapshotId: snapshotName }
    },

    async restoreSnapshot(snapshotId: string): Promise<void> {
      await client.restoreSnapshot(box.id, snapshotId)
    },

    async exposePort(port: number): Promise<{ url: string }> {
      const hostPort = portMappings.get(port) ?? port
      return { url: `http://${host}:${hostPort}` }
    },

    async startTerminal(options?: TerminalOptions): Promise<TerminalInfo> {
      const port = 7681
      const shell = options?.shell ?? '/bin/bash'
      const ttydBase = 'https://github.com/tsl0922/ttyd/releases/download/1.7.7/ttyd'

      const check = await client.exec(box.id, { cmd: ['which', 'ttyd'] })
      if (check.exitCode !== 0) {
        await client.exec(box.id, {
          cmd: ['bash', '-c',
            `ARCH=$(uname -m); case "$ARCH" in aarch64|arm64) ARCH=aarch64;; x86_64) ARCH=x86_64;; *) echo "Unsupported arch: $ARCH" >&2; exit 1;; esac; `
            + `TTYD_URL="${ttydBase}.$ARCH"; `
            + `command -v curl > /dev/null && curl -sL "$TTYD_URL" -o /usr/local/bin/ttyd`
            + ` || { command -v wget > /dev/null && wget -qO /usr/local/bin/ttyd "$TTYD_URL"; }`
            + ` || { apt-get update -qq && apt-get install -y -qq wget > /dev/null && wget -qO /usr/local/bin/ttyd "$TTYD_URL"; }`,
          ],
        })
        await client.exec(box.id, {
          cmd: ['chmod', '+x', '/usr/local/bin/ttyd'],
        })
      }

      await client.exec(box.id, {
        cmd: ['bash', '-c', `nohup ttyd -W -p ${port} '${shell.replace(/'/g, "'\\''")}' > /dev/null 2>&1 &`],
      })

      await client.exec(box.id, {
        cmd: ['bash', '-c', `for i in $(seq 1 20); do pgrep -x ttyd > /dev/null && break || sleep 0.5; done`],
      })

      const hostPort = portMappings.get(port) ?? port

      return {
        url: `ws://${host}:${hostPort}/ws`,
        port,
      }
    },
  }
}

/** Check if an error is a 404 "not found" */
function isNotFound(err: unknown): boolean {
  const msg = err instanceof Error ? err.message : String(err)
  return msg.includes('404') || msg.includes('not found') || msg.includes('Not Found')
}

/** Create the appropriate client based on config mode */
function createClient(config: BoxLiteAdapterConfig): BoxLiteClient {
  if (config.mode === 'local') {
    return createBoxLiteLocalClient(config)
  }
  return createBoxLiteRestClient(config)
}

export class BoxLiteAdapter implements SandboxAdapter {
  readonly name = 'boxlite'
  readonly capabilities: ReadonlySet<Capability>

  private readonly client: BoxLiteClient
  private readonly config: BoxLiteAdapterConfig
  private readonly host: string
  private readonly portMaps = new Map<string, Map<number, number>>()

  constructor(config: BoxLiteAdapterConfig) {
    this.config = config
    this.host = resolveHost(config)
    this.client = createClient(config)

    // Local mode: snapshots not supported yet
    const caps: Capability[] = ['exec.stream', 'terminal', 'sleep', 'port.expose']
    if (config.mode !== 'local') {
      caps.push('snapshot')
    }
    this.capabilities = new Set(caps)
  }

  async createSandbox(config: CreateConfig): Promise<AdapterSandbox> {
    try {
      // If image looks like an absolute path, treat it as a local OCI rootfs
      const image = config.image ?? 'ubuntu:24.04'
      const isLocalPath = image.startsWith('/')
      const box = await this.client.createBox({
        ...(isLocalPath ? { rootfs_path: image } : { image }),
        cpu: config.resources?.cpu,
        memory_mb: config.resources?.memory,
        disk_size_gb: config.resources?.disk,
        env: config.env,
        auto_remove: false,
        ports: config.ports,
      })

      const portMap = new Map<number, number>()
      if (config.ports) {
        for (const [hostPort, guestPort] of config.ports) {
          portMap.set(guestPort, hostPort)
        }
      }
      this.portMaps.set(box.id, portMap)

      if (box.status === 'configured' || box.status === 'stopped') {
        await this.client.startBox(box.id)
      }

      const timeoutSec = config.timeout ?? 30
      const maxAttempts = Math.max(1, timeoutSec)
      let current = box
      for (let i = 0; i < maxAttempts; i++) {
        current = await this.client.getBox(box.id)
        if (current.status === 'running') break
        await new Promise(r => setTimeout(r, 1000))
      }

      if (current.status !== 'running') {
        await this.client.deleteBox(box.id, true).catch(() => {})
        this.portMaps.delete(box.id)
        throw new ProviderError('boxlite', new Error(`Sandbox failed to start within ${timeoutSec}s (status: ${current.status})`))
      }

      return wrapBox(current, this.client, this.host, portMap)
    } catch (err) {
      if (err instanceof ProviderError) throw err
      throw new ProviderError('boxlite', err)
    }
  }

  async getSandbox(id: string): Promise<AdapterSandbox> {
    try {
      const box = await this.client.getBox(id)
      const portMap = this.portMaps.get(id) ?? new Map()
      return wrapBox(box, this.client, this.host, portMap)
    } catch (err) {
      if (isNotFound(err)) throw new SandboxNotFoundError('boxlite', id)
      throw new ProviderError('boxlite', err, id)
    }
  }

  async listSandboxes(filter?: ListFilter): Promise<SandboxInfo[]> {
    try {
      const boxes = await this.client.listBoxes()

      let infos: SandboxInfo[] = boxes.map((b) => ({
        id: b.id,
        state: mapState(b.status),
        createdAt: b.created_at,
        image: b.image,
      }))

      if (filter?.state) {
        const states = Array.isArray(filter.state) ? filter.state : [filter.state]
        infos = infos.filter(s => states.includes(s.state))
      }

      if (filter?.limit) {
        infos = infos.slice(0, filter.limit)
      }

      return infos
    } catch (err) {
      throw new ProviderError('boxlite', err)
    }
  }

  async destroySandbox(id: string): Promise<void> {
    try {
      await this.client.deleteBox(id, true)
      this.portMaps.delete(id)
    } catch (err) {
      if (isNotFound(err)) return
      throw new ProviderError('boxlite', err, id)
    }
  }

  /** Dispose the adapter and clean up resources (e.g. Python bridge process) */
  async dispose(): Promise<void> {
    await this.client.dispose?.()
  }
}
