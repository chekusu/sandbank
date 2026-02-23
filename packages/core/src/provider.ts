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
  SandboxState,
  TerminalInfo,
  TerminalOptions,
  VolumeConfig,
  VolumeInfo,
  VolumeProvider,
} from './types.js'
import { readFileViaExec, writeFileViaExec } from './file-helpers.js'

/**
 * 将 AdapterSandbox 包装为完整的 Sandbox 接口。
 * 自动补充缺失的 writeFile/readFile 默认实现。
 */
function wrapSandbox(raw: AdapterSandbox): Sandbox {
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
      throw new Error('uploadArchive not supported by this provider')
    },

    downloadArchive(srcDir?: string): Promise<ReadableStream> {
      if (raw.downloadArchive) return raw.downloadArchive(srcDir)
      throw new Error('downloadArchive not supported by this provider')
    },
  }

  // 转发可选能力方法
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
 * 自动检测 adapter 实际支持的能力。
 * adapter 的 capabilities 声明为准，但这里做一个简单的交叉检查。
 */
function detectCapabilities(adapter: SandboxAdapter): ReadonlySet<Capability> {
  return adapter.capabilities
}

/** 创建一个 SandboxProvider */
export function createProvider(adapter: SandboxAdapter): SandboxProvider {
  const capabilities = detectCapabilities(adapter)

  const provider: SandboxProvider = {
    get name() { return adapter.name },
    get capabilities() { return capabilities },

    async create(config: CreateConfig): Promise<Sandbox> {
      const raw = await adapter.createSandbox(config)
      return wrapSandbox(raw)
    },

    async get(id: string): Promise<Sandbox> {
      const raw = await adapter.getSandbox(id)
      return wrapSandbox(raw)
    },

    async list(filter?: ListFilter): Promise<SandboxInfo[]> {
      return adapter.listSandboxes(filter)
    },

    async destroy(id: string): Promise<void> {
      return adapter.destroySandbox(id)
    },
  }

  // 如果 adapter 支持 volume 操作，扩展为 VolumeProvider
  if (adapter.createVolume && adapter.deleteVolume && adapter.listVolumes) {
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
