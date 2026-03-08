/// <reference types="@cloudflare/workers-types" />

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
import { getSandbox, type Sandbox as CloudflareSandbox, type DirectoryBackup } from '@cloudflare/sandbox'

// --- Configuration ---

export interface CloudflareAdapterConfig {
  /** DurableObjectNamespace<Sandbox> binding */
  namespace: DurableObjectNamespace<CloudflareSandbox>
  /** Hostname for port exposure, e.g. 'myapp.dev' */
  hostname: string
  /** Auto-sleep duration, e.g. '30m' (optional) */
  sleepAfter?: string
  /** R2/S3 storage config (enables 'volumes' capability) */
  storage?: {
    endpoint: string
    credentials?: { accessKeyId: string; secretAccessKey: string }
    provider?: 'r2' | 's3' | 'gcs'
  }
}

// --- Internal tracking types ---

interface SandboxRecord {
  externalId: string
  sandboxRef: CloudflareSandbox
  state: SandboxState
  createdAt: string
}

interface VolumeRecord {
  id: string
  name: string
}

// --- Retry helper ---

const CONTAINER_NOT_READY_RETRIES = 3
const CONTAINER_NOT_READY_DELAY = 2000

function isContainerNotReady(err: unknown): boolean {
  const msg = err instanceof Error ? err.message : String(err)
  return msg.includes('CONTAINER_NOT_READY') || msg.includes('container not ready')
}

async function withRetry<T>(fn: () => Promise<T>): Promise<T> {
  let lastError: unknown
  for (let i = 0; i < CONTAINER_NOT_READY_RETRIES; i++) {
    try {
      return await fn()
    } catch (err) {
      lastError = err
      if (!isContainerNotReady(err) || i === CONTAINER_NOT_READY_RETRIES - 1) throw err
      await new Promise(r => setTimeout(r, CONTAINER_NOT_READY_DELAY))
    }
  }
  throw lastError
}

// --- Sandbox wrapper ---

function wrapCloudflareSandbox(
  id: string,
  sandbox: CloudflareSandbox,
  state: SandboxState,
  createdAt: string,
  hostname: string,
  sandboxSnapshots: Map<string, DirectoryBackup>,
): AdapterSandbox {
  return {
    id,
    state,
    createdAt,

    async exec(command: string, options?: ExecOptions): Promise<ExecResult> {
      const result = await withRetry(() =>
        sandbox.exec(command, {
          timeout: options?.timeout,
          cwd: options?.cwd,
        }),
      )
      return {
        exitCode: result.exitCode ?? (result.success ? 0 : 1),
        stdout: result.stdout ?? '',
        stderr: result.stderr ?? '',
      }
    },

    async writeFile(path: string, content: string | Uint8Array): Promise<void> {
      if (typeof content === 'string') {
        await sandbox.writeFile(path, content, { encoding: 'utf-8' })
      } else {
        // CF SDK writeFile only accepts string; encode binary as base64
        let binary = ''
        for (let i = 0; i < content.length; i++) {
          binary += String.fromCharCode(content[i]!)
        }
        await sandbox.writeFile(path, btoa(binary), { encoding: 'base64' })
      }
    },

    async readFile(path: string): Promise<Uint8Array> {
      const result = await sandbox.readFile(path, { encoding: 'base64' })
      const b64 = typeof result === 'string' ? result : (result as { content: string }).content
      const binary = atob(b64)
      const bytes = new Uint8Array(binary.length)
      for (let i = 0; i < binary.length; i++) {
        bytes[i] = binary.charCodeAt(i)
      }
      return bytes
    },

    async execStream(command: string): Promise<ReadableStream<Uint8Array>> {
      return sandbox.execStream(command)
    },

    async exposePort(port: number): Promise<{ url: string }> {
      if (port === 3000) {
        throw new Error(
          'Port 3000 is reserved by the Cloudflare sandbox control plane. Use a different port (1024-65535, excluding 3000).',
        )
      }
      const result = await sandbox.exposePort(port, { hostname })
      return { url: result.url }
    },

    async createSnapshot(name?: string): Promise<{ snapshotId: string }> {
      const backup = await sandbox.createBackup({ dir: '/', name: name ?? undefined })
      const snapshotId = name ?? `snap-${crypto.randomUUID().slice(0, 8)}`
      sandboxSnapshots.set(snapshotId, backup)
      return { snapshotId }
    },

    async restoreSnapshot(snapshotId: string): Promise<void> {
      const backup = sandboxSnapshots.get(snapshotId)
      if (!backup) {
        throw new SandboxNotFoundError('cloudflare', snapshotId)
      }
      await sandbox.restoreBackup(backup)
    },

    async startTerminal(options?: TerminalOptions): Promise<TerminalInfo> {
      const port = 7681
      const shell = options?.shell ?? '/bin/bash'
      const ttydUrl = 'https://github.com/tsl0922/ttyd/releases/download/1.7.7/ttyd.x86_64'

      // 1. Ensure ttyd is available (use wget fallback since curl may not be installed)
      const check = await withRetry(() => sandbox.exec('which ttyd'))
      if ((check.exitCode ?? (check.success ? 0 : 1)) !== 0) {
        await withRetry(() => sandbox.exec(
          `command -v curl > /dev/null && curl -sL ${ttydUrl} -o /usr/local/bin/ttyd`
          + ` || { command -v wget > /dev/null && wget -qO /usr/local/bin/ttyd ${ttydUrl}; }`
          + ` || { apt-get update -qq && apt-get install -y -qq wget > /dev/null && wget -qO /usr/local/bin/ttyd ${ttydUrl}; }`,
        ))
        await withRetry(() => sandbox.exec('chmod +x /usr/local/bin/ttyd'))
      }

      // 2. Start ttyd in background (-W enables write)
      await withRetry(() => sandbox.exec(`nohup ttyd -W -p ${port} '${shell.replace(/'/g, "'\\''")}' > /dev/null 2>&1 &`))

      // 3. Wait for ttyd to be ready (check process is running)
      await withRetry(() => sandbox.exec(
        `for i in $(seq 1 20); do pgrep -x ttyd > /dev/null && break || sleep 0.5; done`,
      ))

      // 4. Expose port and return WebSocket URL
      const exposed = await sandbox.exposePort(port, { hostname })
      const url = exposed.url.replace(/\/$/, '') + '/ws'

      return {
        url,
        port,
      }
    },
  }
}

// --- Adapter ---

export class CloudflareAdapter implements SandboxAdapter {
  readonly name = 'cloudflare'
  readonly capabilities: ReadonlySet<Capability>

  private readonly config: CloudflareAdapterConfig
  private readonly sandboxes = new Map<string, SandboxRecord>()
  private readonly volumes = new Map<string, VolumeRecord>()
  private readonly snapshots = new Map<string, Map<string, DirectoryBackup>>()

  constructor(config: CloudflareAdapterConfig) {
    this.config = config

    const caps: Capability[] = ['exec.stream', 'terminal', 'port.expose', 'snapshot']
    if (config.storage) {
      caps.push('volumes')
    }
    this.capabilities = new Set(caps)
  }

  private getSnapshotsFor(sandboxId: string): Map<string, DirectoryBackup> {
    let map = this.snapshots.get(sandboxId)
    if (!map) {
      map = new Map()
      this.snapshots.set(sandboxId, map)
    }
    return map
  }

  async createSandbox(config: CreateConfig): Promise<AdapterSandbox> {
    const id = `cf-${crypto.randomUUID().slice(0, 8)}`
    const externalId = crypto.randomUUID().slice(0, 8)
    const createdAt = new Date().toISOString()

    try {
      const opts: Record<string, unknown> = {}
      if (this.config.sleepAfter) {
        opts['sleepAfter'] = this.config.sleepAfter
      }

      const sandbox = getSandbox(this.config.namespace, externalId, opts)

      // Set environment variables if provided
      if (config.env && Object.keys(config.env).length > 0) {
        await withRetry(() => sandbox.setEnvVars(config.env!))
      }

      // Mount volumes if configured
      if (config.volumes && config.volumes.length > 0 && this.config.storage) {
        for (const vol of config.volumes) {
          await withRetry(() =>
            sandbox.mountBucket(vol.id, vol.mountPath, {
              endpoint: this.config.storage!.endpoint,
              provider: this.config.storage!.provider ?? 'r2',
              credentials: this.config.storage!.credentials,
            }),
          )
        }
      }

      const record: SandboxRecord = {
        externalId,
        sandboxRef: sandbox,
        state: 'running',
        createdAt,
      }
      this.sandboxes.set(id, record)

      return wrapCloudflareSandbox(id, sandbox, 'running', createdAt, this.config.hostname, this.getSnapshotsFor(id))
    } catch (err) {
      throw new ProviderError('cloudflare', err)
    }
  }

  async getSandbox(id: string): Promise<AdapterSandbox> {
    const record = this.sandboxes.get(id)
    if (!record || record.state === 'terminated') {
      throw new SandboxNotFoundError('cloudflare', id)
    }

    // Reconnect lazily via getSandbox
    const sandbox = getSandbox(this.config.namespace, record.externalId, {
      sleepAfter: this.config.sleepAfter,
    })
    record.sandboxRef = sandbox

    return wrapCloudflareSandbox(id, sandbox, record.state, record.createdAt, this.config.hostname, this.getSnapshotsFor(id))
  }

  async listSandboxes(filter?: ListFilter): Promise<SandboxInfo[]> {
    let infos: SandboxInfo[] = []

    for (const [id, record] of this.sandboxes) {
      infos.push({
        id,
        state: record.state,
        createdAt: record.createdAt,
        image: '', // CF container image is defined in wrangler.toml, not at runtime
      })
    }

    // Apply state filter
    if (filter?.state) {
      const states = Array.isArray(filter.state) ? filter.state : [filter.state]
      infos = infos.filter(s => states.includes(s.state))
    }

    // Apply limit
    if (filter?.limit && filter.limit > 0) {
      infos = infos.slice(0, filter.limit)
    }

    return infos
  }

  async destroySandbox(id: string): Promise<void> {
    const record = this.sandboxes.get(id)
    if (!record) return // idempotent

    if (record.state === 'terminated') return // already destroyed

    try {
      const sandbox = getSandbox(this.config.namespace, record.externalId)
      await sandbox.destroy()
    } catch {
      // Idempotent: ignore errors during destroy
    }

    record.state = 'terminated'
  }

  // --- Volume operations ---

  async createVolume(config: VolumeConfig): Promise<VolumeInfo> {
    // Lightweight registration: trust that the R2 bucket already exists
    const id = config.name
    this.volumes.set(id, { id, name: config.name })
    return {
      id,
      name: config.name,
      sizeGB: config.sizeGB ?? 0,
      attachedTo: null,
    }
  }

  async deleteVolume(id: string): Promise<void> {
    // Just remove from internal tracking; R2 bucket lifecycle is managed by the user
    this.volumes.delete(id)
  }

  async listVolumes(): Promise<VolumeInfo[]> {
    return Array.from(this.volumes.values()).map(v => ({
      id: v.id,
      name: v.name,
      sizeGB: 0,
      attachedTo: null,
    }))
  }
}
