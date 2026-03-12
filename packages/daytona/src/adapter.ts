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
  VolumeConfig,
  VolumeInfo,
} from '@sandbank.dev/core'
import { SandboxNotFoundError, ProviderError } from '@sandbank.dev/core'
import type {
  DaytonaAdapterConfig,
  DaytonaClient,
  DaytonaRestConfig,
  DaytonaSandboxData,
  DaytonaSDKConfig,
} from './types.js'
import { createDaytonaRestClient } from './rest-client.js'

export type { DaytonaAdapterConfig }

/** Map Daytona's SandboxState to our SandboxState */
function mapState(daytonaState: string): SandboxState {
  switch (daytonaState) {
    case 'creating':
    case 'restoring':
    case 'starting':
    case 'pending_build':
    case 'building_snapshot':
    case 'pulling_snapshot':
      return 'creating'
    case 'started':
      return 'running'
    case 'stopped':
    case 'stopping':
    case 'archived':
    case 'archiving':
    case 'resizing':
      return 'stopped'
    case 'error':
    case 'build_failed':
      return 'error'
    case 'destroyed':
    case 'destroying':
      return 'terminated'
    default:
      return 'error'
  }
}

/** Wrap sandbox data + client into an AdapterSandbox */
function wrapSandboxData(client: DaytonaClient, data: DaytonaSandboxData): AdapterSandbox {
  return {
    get id() { return data.id },
    get state() { return mapState(data.state) },
    get createdAt() { return data.createdAt },

    async exec(command: string, options?: ExecOptions): Promise<ExecResult> {
      const result = await client.exec(data.id, command, options?.cwd, options?.timeout)
      return {
        exitCode: result.exitCode,
        stdout: result.stdout,
        stderr: '', // Daytona does not separate stderr
      }
    },

    async writeFile(path: string, content: string | Uint8Array): Promise<void> {
      await client.writeFile(data.id, path, content)
    },

    async readFile(path: string): Promise<Uint8Array> {
      return client.readFile(data.id, path)
    },

    async exposePort(port: number): Promise<{ url: string }> {
      const url = await client.getPreviewUrl(data.id, port)
      return { url }
    },

    async startTerminal(options?: TerminalOptions): Promise<TerminalInfo> {
      const port = 7681
      const shell = options?.shell ?? '/bin/bash'

      // 1. Ensure ttyd is available
      const check = await client.exec(data.id, 'which ttyd')
      if (check.exitCode !== 0) {
        const ttydBase = 'https://github.com/tsl0922/ttyd/releases/download/1.7.7/ttyd'
        await client.exec(
          data.id,
          `ARCH=$(uname -m); case "$ARCH" in aarch64|arm64) ARCH=aarch64;; x86_64) ARCH=x86_64;; *) echo "Unsupported arch: $ARCH" >&2; exit 1;; esac; `
          + `TTYD_URL="${ttydBase}.$ARCH"; `
          + `command -v curl > /dev/null && curl -sL "$TTYD_URL" -o /usr/local/bin/ttyd`
          + ` || { command -v wget > /dev/null && wget -qO /usr/local/bin/ttyd "$TTYD_URL"; }`
          + ` || { apt-get update -qq && apt-get install -y -qq wget > /dev/null && wget -qO /usr/local/bin/ttyd "$TTYD_URL"; }`,
        )
        await client.exec(data.id, 'chmod +x /usr/local/bin/ttyd')
      }

      // 2. Start ttyd in background
      await client.exec(data.id, `nohup ttyd -W -p ${port} '${shell.replace(/'/g, "'\\''")}' > /dev/null 2>&1 &`)

      // 3. Wait for ttyd to be ready
      await client.exec(data.id, `for i in $(seq 1 20); do pgrep -x ttyd > /dev/null && break || sleep 0.5; done`)

      // 4. Get the public URL
      const url = await client.getPreviewUrl(data.id, port)
      const wsUrl = url.replace(/^https?/, (p) => p === 'https' ? 'wss' : 'ws').replace(/\/$/, '') + '/ws'

      return { url: wsUrl, port }
    },
  }
}

/** Check if an error is a 404 "not found" or a transient state issue (idempotent) */
function isNotFound(err: unknown): boolean {
  const msg = err instanceof Error ? err.message : String(err)
  return msg.includes('404') || msg.includes('not found') || msg.includes('Not Found')
}

function isStateTransition(err: unknown): boolean {
  const msg = err instanceof Error ? err.message : String(err)
  return msg.includes('state change in progress') || msg.includes('destroying')
}

/** Poll until a condition returns true, or throw on timeout */
async function waitFor(fn: () => Promise<boolean>, intervalMs = 2000, maxAttempts = 15): Promise<void> {
  for (let i = 0; i < maxAttempts; i++) {
    if (await fn()) return
    await new Promise(r => setTimeout(r, intervalMs))
  }
  throw new Error(`Timed out after ${maxAttempts * intervalMs}ms waiting for condition`)
}

export class DaytonaAdapter implements SandboxAdapter {
  readonly name = 'daytona'
  readonly capabilities: ReadonlySet<Capability> = new Set<Capability>([
    'terminal',
    'volumes',
    'port.expose',
  ])

  private clientPromise: Promise<DaytonaClient> | null = null
  private readonly config: DaytonaAdapterConfig

  constructor(config: DaytonaAdapterConfig) {
    this.config = config
  }

  /** Lazy-init client — REST or SDK based on config.mode */
  private getClient(): Promise<DaytonaClient> {
    if (!this.clientPromise) {
      const mode = this.config.mode ?? 'sdk'
      if (mode === 'rest') {
        this.clientPromise = Promise.resolve(
          createDaytonaRestClient(this.config.apiKey, this.config.apiUrl),
        )
      } else {
        // SDK mode: lazy dynamic import so @daytonaio/sdk is optional
        this.clientPromise = import('./sdk-client.js').then(({ createDaytonaSDKClient }) =>
          createDaytonaSDKClient(
            this.config.apiKey,
            this.config.apiUrl,
            (this.config as DaytonaSDKConfig).target,
          ),
        )
      }
    }
    return this.clientPromise
  }

  async createSandbox(config: CreateConfig): Promise<AdapterSandbox> {
    const client = await this.getClient()
    try {
      const data = await client.createSandbox({
        image: config.image,
        envVars: config.env,
        resources: config.resources
          ? { cpu: config.resources.cpu, memory: config.resources.memory, disk: config.resources.disk }
          : undefined,
        volumes: config.volumes?.map((v: { id: string; mountPath: string }) => ({ volumeId: v.id, mountPath: v.mountPath })),
        autoDeleteInterval: config.autoDestroyMinutes,
        target: (this.config as DaytonaSDKConfig).target,
        timeout: config.timeout,
        public: true, // Ports must be publicly accessible (terminal WS + preview iframe)
        class: (this.config as DaytonaRestConfig).sandboxClass,
        snapshot: (this.config as DaytonaRestConfig).snapshot,
      })
      return wrapSandboxData(client, data)
    } catch (err) {
      throw new ProviderError('daytona', err)
    }
  }

  async getSandbox(id: string): Promise<AdapterSandbox> {
    const client = await this.getClient()
    try {
      const data = await client.getSandbox(id)
      return wrapSandboxData(client, data)
    } catch (err) {
      if (isNotFound(err)) throw new SandboxNotFoundError('daytona', id)
      throw new ProviderError('daytona', err, id)
    }
  }

  async listSandboxes(filter?: ListFilter): Promise<SandboxInfo[]> {
    const client = await this.getClient()
    try {
      const items = await client.listSandboxes(filter?.limit)

      let infos: SandboxInfo[] = items.map((s) => ({
        id: s.id,
        state: mapState(s.state),
        createdAt: s.createdAt,
        image: s.image,
      }))

      // Apply state filter
      if (filter?.state) {
        const states = Array.isArray(filter.state) ? filter.state : [filter.state]
        infos = infos.filter(s => states.includes(s.state))
      }

      return infos
    } catch (err) {
      throw new ProviderError('daytona', err)
    }
  }

  async destroySandbox(id: string): Promise<void> {
    const client = await this.getClient()
    try {
      await client.deleteSandbox(id)
    } catch (err) {
      // Idempotent: already destroyed or currently being destroyed is fine
      if (isNotFound(err) || isStateTransition(err)) return
      throw new ProviderError('daytona', err, id)
    }
  }

  // --- Volume operations ---

  async createVolume(config: VolumeConfig): Promise<VolumeInfo> {
    const client = await this.getClient()
    try {
      const vol = await client.createVolume(config.name)

      // Wait for volume to become 'ready' (starts as 'pending_create')
      await waitFor(async () => {
        const volumes = await client.listVolumes()
        const current = volumes.find(v => v.id === vol.id)
        return current?.state === 'ready'
      })

      return {
        id: vol.id,
        name: vol.name,
        sizeGB: config.sizeGB ?? 1,
        attachedTo: null,
      }
    } catch (err) {
      throw new ProviderError('daytona', err)
    }
  }

  async deleteVolume(id: string): Promise<void> {
    const client = await this.getClient()
    try {
      const volumes = await client.listVolumes()
      const vol = volumes.find(v => v.id === id)
      if (!vol) return

      // Volume may not be in 'ready' state yet — wait up to 30s
      if (vol.state && vol.state !== 'ready') {
        for (let i = 0; i < 15; i++) {
          await new Promise(r => setTimeout(r, 2000))
          const refreshed = await client.listVolumes()
          const current = refreshed.find(v => v.id === id)
          if (!current) return // already gone
          if (current.state === 'ready') break
        }
      }

      await client.deleteVolume(id)
    } catch (err) {
      if (isNotFound(err)) return
      throw new ProviderError('daytona', err)
    }
  }

  async listVolumes(): Promise<VolumeInfo[]> {
    const client = await this.getClient()
    try {
      const [volumes, sandboxes] = await Promise.all([
        client.listVolumes(),
        client.listSandboxes(),
      ])

      // Reverse lookup: volumeId → sandboxId
      const volumeToSandbox = new Map<string, string>()
      for (const sandbox of sandboxes) {
        for (const vol of sandbox.volumes ?? []) {
          volumeToSandbox.set(vol.volumeId, sandbox.id)
        }
      }

      return volumes.map(v => ({
        id: v.id,
        name: v.name,
        sizeGB: 1, // Daytona doesn't expose volume size
        attachedTo: volumeToSandbox.get(v.id) ?? null,
      }))
    } catch (err) {
      throw new ProviderError('daytona', err)
    }
  }
}
