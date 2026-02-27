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
import { createFlyioClient, type FlyioClient } from './client.js'
import type { FlyioAdapterConfig, FlyioMachine } from './types.js'

/** Map Fly.io machine state to sandbank SandboxState */
function mapState(flyState: string): SandboxState {
  switch (flyState) {
    case 'created':
    case 'starting':
      return 'creating'
    case 'started':
      return 'running'
    case 'stopped':
    case 'stopping':
    case 'suspended':
      return 'stopped'
    case 'failed':
      return 'error'
    case 'destroyed':
    case 'destroying':
      return 'terminated'
    default:
      return 'error'
  }
}

/** Wrap a Fly.io machine into an AdapterSandbox */
function wrapMachine(machine: FlyioMachine, client: FlyioClient, appName: string): AdapterSandbox {
  return {
    get id() { return machine.id },
    get state() { return mapState(machine.state) },
    get createdAt() { return machine.created_at },

    async exec(command: string, options?: ExecOptions): Promise<ExecResult> {
      const cmd = options?.cwd
        ? `cd ${options.cwd} && ${command}`
        : command
      const result = await client.exec(machine.id, cmd)
      return {
        exitCode: result.exit_code,
        stdout: result.stdout,
        stderr: result.stderr,
      }
    },

    async exposePort(_port: number): Promise<{ url: string }> {
      return { url: `https://${appName}.fly.dev` }
    },
  }
}

/** Check if an error is a 404 "not found" */
function isNotFound(err: unknown): boolean {
  const msg = err instanceof Error ? err.message : String(err)
  return msg.includes('404') || msg.includes('not found') || msg.includes('Not Found')
}

export class FlyioAdapter implements SandboxAdapter {
  readonly name = 'flyio'
  readonly capabilities: ReadonlySet<Capability> = new Set<Capability>([
    'volumes',
    'port.expose',
  ])

  private readonly client: FlyioClient
  private readonly appName: string

  constructor(config: FlyioAdapterConfig) {
    this.client = createFlyioClient(config)
    this.appName = config.appName
  }

  async createSandbox(config: CreateConfig): Promise<AdapterSandbox> {
    try {
      const machine = await this.client.createMachine({
        image: config.image,
        env: config.env,
        guest: {
          cpu_kind: 'shared',
          cpus: config.resources?.cpu ?? 1,
          memory_mb: config.resources?.memory ?? 256,
        },
        services: [{
          internal_port: 8080,
          protocol: 'tcp',
          ports: [
            { port: 443, handlers: ['tls', 'http'], tls_options: { alpn: ['h2', 'http/1.1'] } },
            { port: 80, handlers: ['http'] },
          ],
          autostop: 'off',
          autostart: false,
        }],
        mounts: config.volumes?.map(v => ({ volume: v.id, path: v.mountPath })),
        autoDestroy: (config.autoDestroyMinutes ?? 0) > 0,
        restart: { policy: 'no' },
      })

      await this.client.waitForState(machine.id, 'started', config.timeout ?? 60)
      const updated = await this.client.getMachine(machine.id)
      return wrapMachine(updated, this.client, this.appName)
    } catch (err) {
      throw new ProviderError('flyio', err)
    }
  }

  async getSandbox(id: string): Promise<AdapterSandbox> {
    try {
      const machine = await this.client.getMachine(id)
      return wrapMachine(machine, this.client, this.appName)
    } catch (err) {
      if (isNotFound(err)) throw new SandboxNotFoundError('flyio', id)
      throw new ProviderError('flyio', err, id)
    }
  }

  async listSandboxes(filter?: ListFilter): Promise<SandboxInfo[]> {
    try {
      const machines = await this.client.listMachines()

      let infos: SandboxInfo[] = machines.map((m) => ({
        id: m.id,
        state: mapState(m.state),
        createdAt: m.created_at,
        image: m.config.image,
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
      throw new ProviderError('flyio', err)
    }
  }

  async destroySandbox(id: string): Promise<void> {
    try {
      await this.client.destroyMachine(id)
    } catch (err) {
      if (isNotFound(err)) return
      throw new ProviderError('flyio', err, id)
    }
  }

  // --- Volume operations ---

  async createVolume(config: VolumeConfig): Promise<VolumeInfo> {
    try {
      const vol = await this.client.createVolume({
        name: config.name,
        region: config.region,
        sizeGB: config.sizeGB,
      })
      return {
        id: vol.id,
        name: vol.name,
        sizeGB: vol.size_gb,
        attachedTo: vol.attached_machine_id,
      }
    } catch (err) {
      throw new ProviderError('flyio', err)
    }
  }

  async deleteVolume(id: string): Promise<void> {
    try {
      await this.client.deleteVolume(id)
    } catch (err) {
      if (isNotFound(err)) return
      throw new ProviderError('flyio', err)
    }
  }

  async listVolumes(): Promise<VolumeInfo[]> {
    try {
      const volumes = await this.client.listVolumes()
      return volumes.map(v => ({
        id: v.id,
        name: v.name,
        sizeGB: v.size_gb,
        attachedTo: v.attached_machine_id,
      }))
    } catch (err) {
      throw new ProviderError('flyio', err)
    }
  }
}
