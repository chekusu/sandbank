import type {
  AdapterSandbox,
  Capability,
  CreateConfig,
  ExecOptions,
  ExecResult,
  ListFilter,
  Sandbox,
  SandboxAdapter,
  SandboxInfo,
  SandboxProvider,
  ServiceConfig,
  ServiceInfo,
  ServiceProvider,
  TerminalInfo,
  TerminalOptions,
  VolumeConfig,
  VolumeInfo,
  VolumeProvider,
} from './types.js'
import type { SandboxObserver, SandboxEventType } from './observer.js'
import { emitEvent } from './observer.js'
import { CapabilityNotSupportedError, ProviderError } from './errors.js'
import { injectSkills } from './skill-inject.js'
import { readFileViaExec, writeFileViaExec, uploadArchiveViaExec, downloadArchiveViaExec } from './file-helpers.js'
import { setupSandboxUser, wrapAsUser } from './sandbox-user.js'
import type { SandboxUserInfo } from './types.js'

/**
 * 将 AdapterSandbox 包装为完整的 Sandbox 接口。
 * 自动补充缺失的 writeFile/readFile 默认实现。
 * 若传入 observer，自动对所有操作发射事件。
 */
function wrapSandbox(
  raw: AdapterSandbox,
  providerName: string,
  observer?: SandboxObserver,
  taskId?: string,
  userInfo?: SandboxUserInfo,
): Sandbox {
  function emit(type: SandboxEventType, data: Record<string, unknown>): void {
    if (!observer) return
    emitEvent(observer, { type, sandboxId: raw.id, taskId, timestamp: Date.now(), data })
  }

  const sandbox: Sandbox & Record<string, unknown> = {
    get id() { return raw.id },
    get state() { return raw.state },
    get createdAt() { return raw.createdAt },
    get user() { return userInfo },

    async exec(command: string, options?: ExecOptions): Promise<ExecResult> {
      let cmd = command
      let opts = options

      // 非 root 用户包装: 默认以该用户执行，asRoot 跳过
      if (userInfo && !options?.asRoot) {
        cmd = wrapAsUser(command, userInfo.name, options?.cwd)
        // cwd 已包含在 wrapped command 中，不再传给 adapter
        opts = options ? { ...options, cwd: undefined, asRoot: undefined } : undefined
      }

      const start = Date.now()
      try {
        const result = await raw.exec(cmd, opts)
        emit('sandbox:exec', { command, exitCode: result.exitCode, duration: Date.now() - start })
        return result
      } catch (err) {
        emit('sandbox:exec', { command, error: (err as Error).message, duration: Date.now() - start })
        throw err
      }
    },

    async writeFile(path: string, content: string | Uint8Array): Promise<void> {
      const size = typeof content === 'string' ? content.length : content.byteLength
      const fn = raw.writeFile ? raw.writeFile.bind(raw) : (p: string, c: string | Uint8Array) => writeFileViaExec(raw, p, c)
      await fn(path, content)
      emit('sandbox:writeFile', { path, size })
    },

    async readFile(path: string): Promise<Uint8Array> {
      const fn = raw.readFile ? raw.readFile.bind(raw) : (p: string) => readFileViaExec(raw, p)
      const result = await fn(path)
      emit('sandbox:readFile', { path, size: result.byteLength })
      return result
    },

    async uploadArchive(archive: Uint8Array | ReadableStream, destDir?: string): Promise<void> {
      const fn = raw.uploadArchive ? raw.uploadArchive.bind(raw) : (a: Uint8Array | ReadableStream, d?: string) => uploadArchiveViaExec(raw, a, d)
      await fn(archive, destDir)
      emit('sandbox:uploadArchive', { destDir: destDir ?? '/' })
    },

    async downloadArchive(srcDir?: string): Promise<ReadableStream> {
      const fn = raw.downloadArchive ? raw.downloadArchive.bind(raw) : (s?: string) => downloadArchiveViaExec(raw, s)
      const result = await fn(srcDir)
      emit('sandbox:downloadArchive', { srcDir: srcDir ?? '/' })
      return result
    },
  }

  // 转发可选能力方法（只有 adapter 真正实现的才转发）
  if (raw.execStream) {
    sandbox['execStream'] = raw.execStream.bind(raw)
  }
  if (raw.sleep) {
    sandbox['sleep'] = raw.sleep.bind(raw)
  }
  if (raw.wake) {
    sandbox['wake'] = raw.wake.bind(raw)
  }
  if (raw.startTerminal) {
    sandbox['startTerminal'] = (options?: TerminalOptions): Promise<TerminalInfo> =>
      raw.startTerminal!(options)
  }
  if (raw.exposePort) {
    sandbox['exposePort'] = (port: number, options?: { hostname?: string }): Promise<{ url: string }> =>
      raw.exposePort!(port, options)
  }
  if (raw.createSnapshot) {
    sandbox['createSnapshot'] = (name?: string): Promise<{ snapshotId: string }> =>
      raw.createSnapshot!(name)
  }
  if (raw.restoreSnapshot) {
    sandbox['restoreSnapshot'] = (snapshotId: string): Promise<void> =>
      raw.restoreSnapshot!(snapshotId)
  }

  return sandbox
}

/**
 * 交叉验证 adapter 声明的能力。
 *
 * 对于 sandbox 级别的能力（exec.stream, terminal, sleep, snapshot, port.expose），
 * 我们无法在不创建沙箱的情况下验证方法是否存在，所以信任 adapter 的声明。
 *
 * 对于 provider 级别的能力（volumes），直接检查 adapter 上的方法。
 */
function detectCapabilities(adapter: SandboxAdapter): ReadonlySet<Capability> {
  const validated = new Set<Capability>()

  for (const cap of adapter.capabilities) {
    if (cap === 'volumes') {
      // volumes 是 provider 级别能力，可以直接验证
      if (adapter.createVolume && adapter.deleteVolume && adapter.listVolumes) {
        validated.add(cap)
      }
    } else if (cap === 'services') {
      // services 是 provider 级别能力，可以直接验证
      if (adapter.createService && adapter.getService && adapter.listServices && adapter.destroyService) {
        validated.add(cap)
      }
    } else {
      // sandbox 级别能力，信任 adapter 声明
      validated.add(cap)
    }
  }

  return validated
}

/** 创建一个 SandboxProvider */
export function createProvider(
  adapter: SandboxAdapter,
  options?: { observer?: SandboxObserver; taskId?: string },
): SandboxProvider {
  const capabilities = detectCapabilities(adapter)
  const observer = options?.observer
  const taskId = options?.taskId

  const provider: SandboxProvider = {
    get name() { return adapter.name },
    get capabilities() { return capabilities },

    async create(config: CreateConfig): Promise<Sandbox> {
      // 如果绑定了 services，解析凭证注入 env
      if (config.services?.length) {
        if (!capabilities.has('services') || !adapter.getService) {
          throw new CapabilityNotSupportedError(adapter.name, 'services')
        }
        const getService = adapter.getService.bind(adapter)
        const mergedEnv = { ...config.env }
        for (const binding of config.services) {
          const svc = await getService(binding.id)
          if (svc.state !== 'ready') {
            throw new ProviderError(adapter.name, new Error(`Service ${binding.id} is not ready (state: ${svc.state})`))
          }
          for (const [key, value] of Object.entries(svc.credentials.env)) {
            const envKey = binding.envPrefix ? `${binding.envPrefix}_${key}` : key
            mergedEnv[envKey] = value
          }
        }
        config = { ...config, env: mergedEnv }
      }

      const raw = await adapter.createSandbox(config)

      // 创建非 root 用户（如果配置了）
      let userInfo: SandboxUserInfo | undefined
      if (config.user) {
        userInfo = await setupSandboxUser(raw, config.user)
      }

      const sandbox = wrapSandbox(raw, adapter.name, observer, taskId, userInfo)

      if (config.skills?.length) {
        try {
          await injectSkills(sandbox, config.skills)
        } catch (err) {
          await adapter.destroySandbox(raw.id).catch(() => {})
          throw err
        }
      }

      return sandbox
    },

    async get(id: string): Promise<Sandbox> {
      const raw = await adapter.getSandbox(id)
      return wrapSandbox(raw, adapter.name, observer, taskId)
    },

    async list(filter?: ListFilter): Promise<SandboxInfo[]> {
      return adapter.listSandboxes(filter)
    },

    async destroy(id: string): Promise<void> {
      return adapter.destroySandbox(id)
    },
  }

  // 累积式挂载可选能力方法（volumes 和 services 可以共存）
  const extended = provider as SandboxProvider & Record<string, unknown>

  if (capabilities.has('volumes') && adapter.createVolume && adapter.deleteVolume && adapter.listVolumes) {
    extended.createVolume = (config: VolumeConfig) => adapter.createVolume!(config)
    extended.deleteVolume = (id: string) => adapter.deleteVolume!(id)
    extended.listVolumes = () => adapter.listVolumes!()
  }

  if (capabilities.has('services') && adapter.createService && adapter.getService && adapter.listServices && adapter.destroyService) {
    extended.createService = (config: ServiceConfig) => adapter.createService!(config)
    extended.getService = (id: string) => adapter.getService!(id)
    extended.listServices = () => adapter.listServices!()
    extended.destroyService = (id: string) => adapter.destroyService!(id)
  }

  return extended as SandboxProvider
}
