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
import { createBoxLiteClient, type BoxLiteClient } from './client.js'
import type { BoxLiteAdapterConfig, BoxLiteBox } from './types.js'

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

/** Extract host from API URL for port exposure */
function getApiHost(apiUrl: string): string {
  try {
    const url = new URL(apiUrl)
    return url.hostname
  } catch {
    return apiUrl
  }
}

/** Wrap a BoxLite box into an AdapterSandbox */
function wrapBox(
  box: BoxLiteBox,
  client: BoxLiteClient,
  config: BoxLiteAdapterConfig,
  portMappings: Map<number, number>,
): AdapterSandbox {
  return {
    get id() { return box.box_id },
    get state() { return mapState(box.status) },
    get createdAt() { return box.created_at },

    async exec(command: string, options?: ExecOptions): Promise<ExecResult> {
      const result = await client.exec(box.box_id, {
        command: 'bash',
        args: ['-c', command],
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
      return client.execStream(box.box_id, {
        command: 'bash',
        args: ['-c', command],
        working_dir: options?.cwd,
        timeout_seconds: options?.timeout ? Math.ceil(options.timeout / 1000) : undefined,
      })
    },

    async uploadArchive(archive: Uint8Array | ReadableStream, destDir?: string): Promise<void> {
      let data: Uint8Array
      if (archive instanceof Uint8Array) {
        data = archive
      } else {
        // Collect ReadableStream into Uint8Array
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
      await client.uploadFiles(box.box_id, destDir ?? '/', data)
    },

    async downloadArchive(srcDir?: string): Promise<ReadableStream> {
      return client.downloadFiles(box.box_id, srcDir ?? '/')
    },

    async sleep(): Promise<void> {
      await client.stopBox(box.box_id)
    },

    async wake(): Promise<void> {
      await client.startBox(box.box_id)
    },

    async createSnapshot(name?: string): Promise<{ snapshotId: string }> {
      const snapshotName = name ?? `snap-${Date.now()}`
      await client.createSnapshot(box.box_id, snapshotName)
      return { snapshotId: snapshotName }
    },

    async restoreSnapshot(snapshotId: string): Promise<void> {
      await client.restoreSnapshot(box.box_id, snapshotId)
    },

    async exposePort(port: number): Promise<{ url: string }> {
      const hostPort = portMappings.get(port) ?? port
      const host = getApiHost(config.apiUrl)
      return { url: `http://${host}:${hostPort}` }
    },

    async startTerminal(options?: TerminalOptions): Promise<TerminalInfo> {
      const port = 7681
      const shell = options?.shell ?? '/bin/bash'
      const ttydUrl = 'https://github.com/tsl0922/ttyd/releases/download/1.7.7/ttyd.x86_64'

      // 1. Ensure ttyd is available
      const check = await client.exec(box.box_id, { command: 'which', args: ['ttyd'] })
      if (check.exitCode !== 0) {
        await client.exec(box.box_id, {
          command: 'bash',
          args: ['-c',
            `command -v curl > /dev/null && curl -sL ${ttydUrl} -o /usr/local/bin/ttyd`
            + ` || { command -v wget > /dev/null && wget -qO /usr/local/bin/ttyd ${ttydUrl}; }`
            + ` || { apt-get update -qq && apt-get install -y -qq wget > /dev/null && wget -qO /usr/local/bin/ttyd ${ttydUrl}; }`,
          ],
        })
        await client.exec(box.box_id, {
          command: 'chmod',
          args: ['+x', '/usr/local/bin/ttyd'],
        })
      }

      // 2. Start ttyd in background (-W enables write)
      await client.exec(box.box_id, {
        command: 'bash',
        args: ['-c', `nohup ttyd -W -p ${port} '${shell.replace(/'/g, "'\\''")}' > /dev/null 2>&1 &`],
      })

      // 3. Wait for ttyd to be ready
      await client.exec(box.box_id, {
        command: 'bash',
        args: ['-c', `for i in $(seq 1 20); do pgrep -x ttyd > /dev/null && break || sleep 0.5; done`],
      })

      const hostPort = portMappings.get(port) ?? port
      const host = getApiHost(config.apiUrl)

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

export class BoxLiteAdapter implements SandboxAdapter {
  readonly name = 'boxlite'
  readonly capabilities: ReadonlySet<Capability> = new Set<Capability>([
    'exec.stream',
    'terminal',
    'sleep',
    'snapshot',
    'port.expose',
  ])

  private readonly client: BoxLiteClient
  private readonly config: BoxLiteAdapterConfig
  /** Track port mappings per box: boxId → Map<guestPort, hostPort> */
  private readonly portMaps = new Map<string, Map<number, number>>()

  constructor(config: BoxLiteAdapterConfig) {
    this.config = config
    this.client = createBoxLiteClient(config)
  }

  async createSandbox(config: CreateConfig): Promise<AdapterSandbox> {
    try {
      const box = await this.client.createBox({
        image: config.image,
        cpus: config.resources?.cpu,
        memory_mib: config.resources?.memory,
        env: config.env,
        auto_remove: false,
      })

      // Store port mappings if they were specified at creation
      const portMap = new Map<number, number>()
      this.portMaps.set(box.box_id, portMap)

      // Start the box if it was created in configured state
      if (box.status === 'configured' || box.status === 'stopped') {
        await this.client.startBox(box.box_id)
      }

      // Wait for box to be running (timeout is in seconds per CreateConfig docs)
      const timeoutSec = config.timeout ?? 30
      const maxAttempts = Math.max(1, timeoutSec)
      let current = box
      for (let i = 0; i < maxAttempts; i++) {
        current = await this.client.getBox(box.box_id)
        if (current.status === 'running') break
        await new Promise(r => setTimeout(r, 1000))
      }

      if (current.status !== 'running') {
        await this.client.deleteBox(box.box_id, true).catch(() => {})
        this.portMaps.delete(box.box_id)
        throw new ProviderError('boxlite', new Error(`Sandbox failed to start within ${timeoutSec}s (status: ${current.status})`))
      }

      return wrapBox(current, this.client, this.config, portMap)
    } catch (err) {
      if (err instanceof ProviderError) throw err
      throw new ProviderError('boxlite', err)
    }
  }

  async getSandbox(id: string): Promise<AdapterSandbox> {
    try {
      const box = await this.client.getBox(id)
      const portMap = this.portMaps.get(id) ?? new Map()
      return wrapBox(box, this.client, this.config, portMap)
    } catch (err) {
      if (isNotFound(err)) throw new SandboxNotFoundError('boxlite', id)
      throw new ProviderError('boxlite', err, id)
    }
  }

  async listSandboxes(filter?: ListFilter): Promise<SandboxInfo[]> {
    try {
      const boxes = await this.client.listBoxes()

      let infos: SandboxInfo[] = boxes.map((b) => ({
        id: b.box_id,
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
}
