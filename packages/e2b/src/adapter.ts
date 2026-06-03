import {
  CommandExitError as E2BCommandExitError,
  NotFoundError as E2BNotFoundError,
  Sandbox as E2BSandbox,
  SandboxNotFoundError as E2BSandboxNotFoundError,
  Volume as E2BVolume,
} from 'e2b'
import type {
  CommandResult as E2BCommandResult,
  ConnectionOpts as E2BConnectionOpts,
  SandboxInfo as E2BSandboxInfo,
  SandboxOpts as E2BSandboxOpts,
  SandboxState as E2BSandboxState,
} from 'e2b'
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
import { ProviderError, SandboxNotFoundError } from '@sandbank.dev/core'
import type { E2BAdapterConfig } from './types.js'

type E2BStateFilter = E2BSandboxState[] | null | undefined

function mapState(state: E2BSandboxState): SandboxState {
  return state === 'paused' ? 'stopped' : 'running'
}

function toIsoString(value: Date | string | number): string {
  return value instanceof Date ? value.toISOString() : new Date(value).toISOString()
}

function mapSandboxInfo(info: E2BSandboxInfo): SandboxInfo {
  return {
    id: info.sandboxId,
    state: mapState(info.state),
    createdAt: toIsoString(info.startedAt),
    image: info.templateId,
  }
}

function isNotFound(err: unknown): boolean {
  if (err instanceof E2BSandboxNotFoundError || err instanceof E2BNotFoundError) return true
  const msg = err instanceof Error ? err.message : String(err)
  return msg.includes('404') || msg.includes('not found') || msg.includes('Not Found')
}

function isCommandExitError(err: unknown): err is E2BCommandExitError & E2BCommandResult {
  if (err instanceof E2BCommandExitError) return true
  const maybe = err as Partial<E2BCommandResult> | null
  return !!maybe
    && typeof maybe.exitCode === 'number'
    && typeof maybe.stdout === 'string'
    && typeof maybe.stderr === 'string'
}

function toExecResult(result: E2BCommandResult): ExecResult {
  return {
    exitCode: result.exitCode,
    stdout: result.stdout,
    stderr: result.stderr,
  }
}

async function runCommand(
  sandbox: E2BSandbox,
  command: string,
  options?: ExecOptions,
): Promise<ExecResult> {
  try {
    const result = await sandbox.commands.run(command, {
      cwd: options?.cwd,
      timeoutMs: options?.timeout,
    })
    return toExecResult(result)
  } catch (err) {
    if (isCommandExitError(err)) {
      return toExecResult(err)
    }
    throw err
  }
}

function toArrayBuffer(content: Uint8Array): ArrayBuffer {
  return new Uint8Array(content).buffer
}

function shellQuote(value: string): string {
  return `'${value.replace(/'/g, "'\\''")}'`
}

function assertOk(result: ExecResult, action: string): void {
  if (result.exitCode !== 0) {
    throw new Error(`${action} failed with exit code ${result.exitCode}: ${result.stderr || result.stdout}`)
  }
}

function mapFilterState(state?: ListFilter['state']): E2BStateFilter {
  if (!state) return undefined
  const states = Array.isArray(state) ? state : [state]
  const mapped: E2BSandboxState[] = []
  if (states.includes('running')) mapped.push('running')
  if (states.includes('stopped')) mapped.push('paused')
  return mapped.length ? mapped : null
}

function createVolumeInfo(
  volume: { volumeId: string; name: string },
  sizeGB: number,
  attachedTo: string | null,
): VolumeInfo {
  return {
    id: volume.volumeId,
    name: volume.name,
    sizeGB,
    attachedTo,
  }
}

function wrapE2BSandbox(
  initial: E2BSandbox,
  options: {
    connectionOpts: () => E2BConnectionOpts
    debug: boolean
    state?: SandboxState
    createdAt?: string
  },
): AdapterSandbox {
  let sandbox = initial
  let state: SandboxState = options.state ?? 'running'
  const createdAt = options.createdAt ?? new Date().toISOString()

  function publicUrl(port: number, protocol: 'http' | 'ws'): string {
    const secure = options.debug ? protocol : `${protocol}s`
    return `${secure}://${sandbox.getHost(port)}`
  }

  return {
    get id() { return sandbox.sandboxId },
    get state() { return state },
    get createdAt() { return createdAt },

    async exec(command: string, execOptions?: ExecOptions): Promise<ExecResult> {
      return runCommand(sandbox, command, execOptions)
    },

    async writeFile(path: string, content: string | Uint8Array): Promise<void> {
      await sandbox.files.write(path, typeof content === 'string' ? content : toArrayBuffer(content))
    },

    async readFile(path: string): Promise<Uint8Array> {
      return sandbox.files.read(path, { format: 'bytes' })
    },

    async sleep(): Promise<void> {
      await sandbox.pause(options.connectionOpts())
      state = 'stopped'
    },

    async wake(): Promise<void> {
      sandbox = await E2BSandbox.connect(sandbox.sandboxId, options.connectionOpts())
      state = 'running'
    },

    async exposePort(port: number): Promise<{ url: string }> {
      return { url: publicUrl(port, 'http') }
    },

    async startTerminal(terminalOptions?: TerminalOptions): Promise<TerminalInfo> {
      const port = 7681
      const shell = terminalOptions?.shell ?? '/bin/bash'
      const ttydBase = 'https://github.com/tsl0922/ttyd/releases/download/1.7.7/ttyd'
      const check = await runCommand(sandbox, 'command -v ttyd || test -x "$HOME/.local/bin/ttyd"')

      if (check.exitCode !== 0) {
        const install = await runCommand(
          sandbox,
          `mkdir -p "$HOME/.local/bin"; `
          + `ARCH=$(uname -m); case "$ARCH" in aarch64|arm64) ARCH=aarch64;; x86_64) ARCH=x86_64;; *) echo "Unsupported arch: $ARCH" >&2; exit 1;; esac; `
          + `TTYD_URL="${ttydBase}.$ARCH"; `
          + `(command -v curl > /dev/null && curl -sL "$TTYD_URL" -o "$HOME/.local/bin/ttyd")`
          + ` || (command -v wget > /dev/null && wget -qO "$HOME/.local/bin/ttyd" "$TTYD_URL"); `
          + `chmod +x "$HOME/.local/bin/ttyd"`,
        )
        assertOk(install, 'Installing ttyd')
      }

      const start = await runCommand(
        sandbox,
        `TTYD_BIN=$(command -v ttyd || printf "%s" "$HOME/.local/bin/ttyd"); `
        + `nohup "$TTYD_BIN" -W -p ${port} ${shellQuote(shell)} > /tmp/sandbank-ttyd.log 2>&1 &`,
      )
      assertOk(start, 'Starting ttyd')

      const wait = await runCommand(
        sandbox,
        `for i in $(seq 1 20); do pgrep -f "ttyd.*-p ${port}" > /dev/null && exit 0 || sleep 0.5; done; exit 1`,
      )
      assertOk(wait, 'Waiting for ttyd')

      return {
        url: `${publicUrl(port, 'ws')}/ws`,
        port,
      }
    },
  }
}

export class E2BAdapter implements SandboxAdapter {
  readonly name = 'e2b'
  readonly capabilities: ReadonlySet<Capability> = new Set<Capability>([
    'terminal',
    'volumes',
    'sleep',
    'port.expose',
  ])

  private readonly config: E2BAdapterConfig

  constructor(config: E2BAdapterConfig = {}) {
    this.config = config
  }

  private connectionOpts(requestTimeoutMs?: number): E2BConnectionOpts {
    return {
      apiKey: this.config.apiKey,
      domain: this.config.domain,
      requestTimeoutMs: requestTimeoutMs ?? this.config.requestTimeoutMs,
      debug: this.config.debug,
    }
  }

  private async resolveVolumeMounts(
    volumes: CreateConfig['volumes'],
    opts: E2BConnectionOpts,
  ): Promise<E2BSandboxOpts['volumeMounts']> {
    if (!volumes?.length) return undefined

    const mounts: NonNullable<E2BSandboxOpts['volumeMounts']> = {}
    for (const volume of volumes) {
      mounts[volume.mountPath] = await E2BVolume.connect(volume.id, opts)
    }
    return mounts
  }

  private async getInfo(sandbox: E2BSandbox, requestTimeoutMs?: number): Promise<E2BSandboxInfo> {
    return sandbox.getInfo({ requestTimeoutMs: requestTimeoutMs ?? this.config.requestTimeoutMs })
  }

  async createSandbox(config: CreateConfig): Promise<AdapterSandbox> {
    const requestTimeoutMs = config.timeout ? config.timeout * 1000 : this.config.requestTimeoutMs
    const opts = this.connectionOpts(requestTimeoutMs)

    try {
      const autoDestroyMinutes = config.autoDestroyMinutes ?? 0
      const sandboxOpts: E2BSandboxOpts = {
        ...opts,
        envs: config.env,
        timeoutMs: autoDestroyMinutes > 0
          ? autoDestroyMinutes * 60_000
          : this.config.defaultTimeoutMs,
        volumeMounts: await this.resolveVolumeMounts(config.volumes, opts),
        lifecycle: autoDestroyMinutes > 0
          ? { onTimeout: 'kill' }
          : { onTimeout: 'pause', autoResume: true },
      }

      const template = config.image ?? this.config.template
      const sandbox = template
        ? await E2BSandbox.create(template, sandboxOpts)
        : await E2BSandbox.create(sandboxOpts)
      const info = await this.getInfo(sandbox, requestTimeoutMs)

      return wrapE2BSandbox(sandbox, {
        connectionOpts: () => this.connectionOpts(),
        debug: this.config.debug ?? false,
        state: mapState(info.state),
        createdAt: toIsoString(info.startedAt),
      })
    } catch (err) {
      throw new ProviderError('e2b', err)
    }
  }

  async getSandbox(id: string): Promise<AdapterSandbox> {
    try {
      const sandbox = await E2BSandbox.connect(id, this.connectionOpts())
      const info = await this.getInfo(sandbox)
      return wrapE2BSandbox(sandbox, {
        connectionOpts: () => this.connectionOpts(),
        debug: this.config.debug ?? false,
        state: mapState(info.state),
        createdAt: toIsoString(info.startedAt),
      })
    } catch (err) {
      if (isNotFound(err)) throw new SandboxNotFoundError('e2b', id)
      throw new ProviderError('e2b', err, id)
    }
  }

  async listSandboxes(filter?: ListFilter): Promise<SandboxInfo[]> {
    const state = mapFilterState(filter?.state)
    if (state === null) return []

    try {
      const limit = filter?.limit
      const paginator = E2BSandbox.list({
        ...this.connectionOpts(),
        limit,
        query: state ? { state } : undefined,
      })
      const sandboxes: SandboxInfo[] = []

      while (paginator.hasNext && (!limit || sandboxes.length < limit)) {
        const page = await paginator.nextItems()
        sandboxes.push(...page.map(mapSandboxInfo))
      }

      return limit ? sandboxes.slice(0, limit) : sandboxes
    } catch (err) {
      throw new ProviderError('e2b', err)
    }
  }

  async destroySandbox(id: string): Promise<void> {
    try {
      await E2BSandbox.kill(id, this.connectionOpts())
    } catch (err) {
      if (isNotFound(err)) return
      throw new ProviderError('e2b', err, id)
    }
  }

  async createVolume(config: VolumeConfig): Promise<VolumeInfo> {
    try {
      const volume = await E2BVolume.create(config.name, this.connectionOpts())
      return createVolumeInfo(volume, config.sizeGB ?? 1, null)
    } catch (err) {
      throw new ProviderError('e2b', err)
    }
  }

  async deleteVolume(id: string): Promise<void> {
    try {
      await E2BVolume.destroy(id, this.connectionOpts())
    } catch (err) {
      if (isNotFound(err)) return
      throw new ProviderError('e2b', err)
    }
  }

  async listVolumes(): Promise<VolumeInfo[]> {
    try {
      const [volumes, sandboxes] = await Promise.all([
        E2BVolume.list(this.connectionOpts()),
        this.listSandboxes(),
      ])

      const volumeNameToSandbox = new Map<string, string>()
      for (const sandbox of sandboxes) {
        const info = await E2BSandbox.getInfo(sandbox.id, this.connectionOpts())
        for (const mount of info.volumeMounts ?? []) {
          volumeNameToSandbox.set(mount.name, sandbox.id)
        }
      }

      return volumes.map(volume =>
        createVolumeInfo(volume, 1, volumeNameToSandbox.get(volume.name) ?? null),
      )
    } catch (err) {
      throw new ProviderError('e2b', err)
    }
  }
}
