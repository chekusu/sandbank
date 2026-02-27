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
  VolumeConfig,
  VolumeInfo,
} from '@sandbank/core'
import { SandboxNotFoundError, ProviderError } from '@sandbank/core'
import type { Daytona as DaytonaClient, Sandbox as DaytonaSandbox } from '@daytonaio/sdk'

export interface DaytonaAdapterConfig {
  apiKey: string
  apiUrl?: string
  target?: string
}

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

/** Wrap a Daytona SDK sandbox into an AdapterSandbox */
function wrapDaytonaSandbox(sandbox: DaytonaSandbox): AdapterSandbox {
  return {
    get id() { return sandbox.id as string },
    get state() { return mapState(sandbox.state as string) },
    get createdAt() { return ((sandbox as unknown as Record<string, unknown>)['createdAt'] ?? new Date().toISOString()) as string },

    async exec(command: string, options?: ExecOptions): Promise<ExecResult> {
      const response = await sandbox.process.executeCommand(
        command,
        options?.cwd,
        undefined, // env
        options?.timeout,
      )
      return {
        exitCode: response.exitCode as number,
        stdout: (response.artifacts?.stdout ?? response.result ?? '') as string,
        stderr: '', // Daytona SDK does not separate stderr
      }
    },

    async writeFile(path: string, content: string | Uint8Array): Promise<void> {
      // Daytona SDK requires Node.js Buffer
      const buffer = typeof content === 'string'
        ? Buffer.from(content, 'utf-8')
        : Buffer.from(content)
      await sandbox.fs.uploadFile(buffer, path)
    },

    async readFile(path: string): Promise<Uint8Array> {
      const buffer: Buffer = await sandbox.fs.downloadFile(path)
      return new Uint8Array(buffer.buffer, buffer.byteOffset, buffer.byteLength)
    },

    async exposePort(port: number): Promise<{ url: string }> {
      const preview = await sandbox.getPreviewLink(port)
      return { url: preview.url as string }
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

/** Poll until a condition returns true, or timeout */
async function waitFor(fn: () => Promise<boolean>, intervalMs = 2000, maxAttempts = 15): Promise<void> {
  for (let i = 0; i < maxAttempts; i++) {
    if (await fn()) return
    await new Promise(r => setTimeout(r, intervalMs))
  }
}

export class DaytonaAdapter implements SandboxAdapter {
  readonly name = 'daytona'
  readonly capabilities: ReadonlySet<Capability> = new Set<Capability>([
    'volumes',
    'port.expose',
  ])

  private clientPromise: Promise<DaytonaClient> | null = null
  private readonly config: DaytonaAdapterConfig

  constructor(config: DaytonaAdapterConfig) {
    this.config = config
  }

  /** Lazy-init Daytona client (cached Promise pattern) */
  private getClient(): Promise<DaytonaClient> {
    if (!this.clientPromise) {
      this.clientPromise = import('@daytonaio/sdk').then(({ Daytona }) =>
        new Daytona({
          apiKey: this.config.apiKey,
          apiUrl: this.config.apiUrl,
          target: this.config.target as never,
        }),
      )
    }
    return this.clientPromise
  }

  async createSandbox(config: CreateConfig): Promise<AdapterSandbox> {
    const daytona = await this.getClient()
    try {
      const sandbox = await daytona.create(
        {
          image: config.image,
          envVars: config.env,
          resources: config.resources
            ? { cpu: config.resources.cpu, memory: config.resources.memory, disk: config.resources.disk }
            : undefined,
          volumes: config.volumes?.map((v: { id: string; mountPath: string }) => ({ volumeId: v.id, mountPath: v.mountPath })),
          autoDeleteInterval: config.autoDestroyMinutes,
        },
        config.timeout ? { timeout: config.timeout } : undefined,
      )
      return wrapDaytonaSandbox(sandbox)
    } catch (err) {
      throw new ProviderError('daytona', err)
    }
  }

  async getSandbox(id: string): Promise<AdapterSandbox> {
    const daytona = await this.getClient()
    try {
      const sandbox = await daytona.get(id)
      return wrapDaytonaSandbox(sandbox)
    } catch (err) {
      if (isNotFound(err)) throw new SandboxNotFoundError('daytona', id)
      throw new ProviderError('daytona', err, id)
    }
  }

  async listSandboxes(filter?: ListFilter): Promise<SandboxInfo[]> {
    const daytona = await this.getClient()
    try {
      const result = await daytona.list(undefined, undefined, filter?.limit)
      const items = result.items as DaytonaSandbox[]

      let infos: SandboxInfo[] = items.map((s) => ({
        id: s.id as string,
        state: mapState(s.state as string),
        createdAt: ((s as unknown as Record<string, unknown>)['createdAt'] ?? '') as string,
        image: ((s as unknown as Record<string, unknown>)['image'] ?? '') as string,
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
    const daytona = await this.getClient()
    try {
      const sandbox = await daytona.get(id)
      await daytona.delete(sandbox)
    } catch (err) {
      // Idempotent: already destroyed or currently being destroyed is fine
      if (isNotFound(err) || isStateTransition(err)) return
      throw new ProviderError('daytona', err, id)
    }
  }

  // --- Volume operations ---

  async createVolume(config: VolumeConfig): Promise<VolumeInfo> {
    const daytona = await this.getClient()
    try {
      const vol = await daytona.volume.create(config.name)
      const volId = vol.id as string

      // Wait for volume to become 'ready' (starts as 'pending_create')
      await waitFor(async () => {
        const volumes = await daytona.volume.list()
        const current = volumes.find((v: { id: string }) => v.id === volId) as { state?: string } | undefined
        return current?.state === 'ready'
      })

      return {
        id: volId,
        name: vol.name as string,
        sizeGB: config.sizeGB ?? 1,
        attachedTo: null,
      }
    } catch (err) {
      throw new ProviderError('daytona', err)
    }
  }

  async deleteVolume(id: string): Promise<void> {
    const daytona = await this.getClient()
    try {
      const volumes = await daytona.volume.list()
      const vol = volumes.find((v: { id: string }) => v.id === id)
      if (!vol) return

      // Volume may not be in 'ready' state yet — wait up to 30s
      const volState = (vol as { state?: string }).state
      if (volState && volState !== 'ready') {
        for (let i = 0; i < 15; i++) {
          await new Promise(r => setTimeout(r, 2000))
          const refreshed = await daytona.volume.list()
          const current = refreshed.find((v: { id: string }) => v.id === id) as { id: string; state?: string } | undefined
          if (!current) return // already gone
          if (current.state === 'ready') break
        }
      }

      // 重新获取最新 volume 对象传给 delete
      const refreshed = await daytona.volume.list()
      const latest = refreshed.find((v: { id: string }) => v.id === id)
      if (!latest) return // 已消失
      await daytona.volume.delete(latest)
    } catch (err) {
      if (isNotFound(err)) return
      throw new ProviderError('daytona', err)
    }
  }

  async listVolumes(): Promise<VolumeInfo[]> {
    const daytona = await this.getClient()
    try {
      const [volumes, sandboxResult] = await Promise.all([
        daytona.volume.list(),
        daytona.list(),
      ])

      // Reverse lookup: volumeId → sandboxId
      const volumeToSandbox = new Map<string, string>()
      for (const sandbox of sandboxResult.items as DaytonaSandbox[]) {
        for (const vol of (sandbox.volumes ?? []) as Array<{ volumeId: string }>) {
          volumeToSandbox.set(vol.volumeId, sandbox.id as string)
        }
      }

      return (volumes as Array<{ id: string; name: string }>).map(v => ({
        id: v.id,
        name: v.name,
        sizeGB: 1, // Daytona SDK doesn't expose volume size
        attachedTo: volumeToSandbox.get(v.id) ?? null,
      }))
    } catch (err) {
      throw new ProviderError('daytona', err)
    }
  }
}
