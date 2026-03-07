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
  TerminalInfo,
  TerminalOptions,
  VolumeConfig,
  VolumeInfo,
  VolumeProvider,
} from './types.js'
import { CapabilityNotSupportedError, ProviderError } from './errors.js'
import { injectSkills } from './skill-inject.js'
import { readFileViaExec, writeFileViaExec, uploadArchiveViaExec, downloadArchiveViaExec } from './file-helpers.js'

/**
 * 将 AdapterSandbox 包装为完整的 Sandbox 接口。
 * 自动补充缺失的 writeFile/readFile 默认实现。
 */
function wrapSandbox(raw: AdapterSandbox, providerName: string): Sandbox {
  const sandbox: Sandbox & Record<string, unknown> = {
    get id() { return raw.id },
    get state() { return raw.state },
    get createdAt() { return raw.createdAt },

    exec(command: string, options?: ExecOptions): Promise<ExecResult> {
      return raw.exec(command, options)
    },

    writeFile(path: string, content: string | Uint8Array): Promise<void> {
      if (raw.writeFile) return raw.writeFile(path, content)
      return writeFileViaExec(raw, path, content)
    },

    readFile(path: string): Promise<Uint8Array> {
      if (raw.readFile) return raw.readFile(path)
      return readFileViaExec(raw, path)
    },

    uploadArchive(archive: Uint8Array | ReadableStream, destDir?: string): Promise<void> {
      if (raw.uploadArchive) return raw.uploadArchive(archive, destDir)
      return uploadArchiveViaExec(raw, archive, destDir)
    },

    downloadArchive(srcDir?: string): Promise<ReadableStream> {
      if (raw.downloadArchive) return raw.downloadArchive(srcDir)
      return downloadArchiveViaExec(raw, srcDir)
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

/** 能力到 AdapterSandbox 方法的映射 */
const CAPABILITY_METHOD_MAP: Record<Capability, string> = {
  'exec.stream': 'execStream',
  'terminal': 'startTerminal',
  'sleep': 'sleep',
  'volumes': '',       // checked at adapter level, not sandbox level
  'snapshot': 'createSnapshot',
  'port.expose': 'exposePort',
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
    } else {
      // sandbox 级别能力，信任 adapter 声明
      validated.add(cap)
    }
  }

  return validated
}

/** 创建一个 SandboxProvider */
export function createProvider(adapter: SandboxAdapter): SandboxProvider {
  const capabilities = detectCapabilities(adapter)

  const provider: SandboxProvider = {
    get name() { return adapter.name },
    get capabilities() { return capabilities },

    async create(config: CreateConfig): Promise<Sandbox> {
      const raw = await adapter.createSandbox(config)
      const sandbox = wrapSandbox(raw, adapter.name)

      if (config.skills?.length) {
        await injectSkills(sandbox, config.skills)
      }

      return sandbox
    },

    async get(id: string): Promise<Sandbox> {
      const raw = await adapter.getSandbox(id)
      return wrapSandbox(raw, adapter.name)
    },

    async list(filter?: ListFilter): Promise<SandboxInfo[]> {
      return adapter.listSandboxes(filter)
    },

    async destroy(id: string): Promise<void> {
      return adapter.destroySandbox(id)
    },
  }

  // 如果 adapter 支持 volume 操作，扩展为 VolumeProvider
  if (capabilities.has('volumes') && adapter.createVolume && adapter.deleteVolume && adapter.listVolumes) {
    const volumeProvider = provider as SandboxProvider & {
      createVolume: (config: VolumeConfig) => Promise<VolumeInfo>
      deleteVolume: (id: string) => Promise<void>
      listVolumes: () => Promise<VolumeInfo[]>
    }
    volumeProvider.createVolume = (config: VolumeConfig) => adapter.createVolume!(config)
    volumeProvider.deleteVolume = (id: string) => adapter.deleteVolume!(id)
    volumeProvider.listVolumes = () => adapter.listVolumes!()
    return volumeProvider as VolumeProvider
  }

  return provider
}
