// --- Provider（工厂） ---

export interface SandboxProvider {
  /** Provider 标识，如 'daytona', 'flyio', 'cloudflare' */
  readonly name: string

  /** 该 provider 支持的能力集 */
  readonly capabilities: ReadonlySet<Capability>

  /** 创建一个新的沙箱 */
  create(config: CreateConfig): Promise<Sandbox>

  /** 获取已存在的沙箱（不存在则抛 SandboxNotFoundError） */
  get(id: string): Promise<Sandbox>

  /** 列出当前所有沙箱 */
  list(filter?: ListFilter): Promise<SandboxInfo[]>

  /** 销毁沙箱（幂等：已销毁的不报错） */
  destroy(id: string): Promise<void>
}

export interface CreateConfig {
  /** 容器镜像（如 'node:22-slim', 'ubuntu:24.04'） */
  image: string

  /** 环境变量注入 */
  env?: Record<string, string>

  /** 资源配置（provider 会映射到最接近的规格） */
  resources?: {
    cpu?: number
    memory?: number
    disk?: number
  }

  /** 区域偏好（provider 可忽略） */
  region?: string

  /** 自动销毁时间（分钟）。0 或不设 = 不自动销毁 */
  autoDestroyMinutes?: number

  /** 挂载的持久卷（需 provider 支持 'volumes' 能力） */
  volumes?: Array<{
    id: string
    mountPath: string
  }>
}

export interface ListFilter {
  state?: SandboxState | SandboxState[]
  limit?: number
}

// --- Sandbox（实例） ---

export interface Sandbox {
  /** 沙箱唯一 ID */
  readonly id: string

  /** 当前状态 */
  readonly state: SandboxState

  /** 创建时间 */
  readonly createdAt: string

  /** 执行命令，等待完成 */
  exec(command: string, options?: ExecOptions): Promise<ExecResult>

  /** 写入单个文件 */
  writeFile(path: string, content: string | Uint8Array): Promise<void>

  /** 读取单个文件 */
  readFile(path: string): Promise<Uint8Array>

  /** 上传 tar.gz 归档并解压到指定目录 */
  uploadArchive(archive: Uint8Array | ReadableStream, destDir?: string): Promise<void>

  /** 将指定目录打包为 tar.gz 下载 */
  downloadArchive(srcDir?: string): Promise<ReadableStream>
}

export type SandboxState = 'creating' | 'running' | 'stopped' | 'error' | 'terminated'

export interface ExecOptions {
  /** 超时时间（毫秒），默认 120_000 */
  timeout?: number
  /** 工作目录 */
  cwd?: string
}

export interface ExecResult {
  stdout: string
  stderr: string
  exitCode: number
}

export interface SandboxInfo {
  id: string
  state: SandboxState
  createdAt: string
  image: string
  region?: string
}

// --- Capability Extensions ---

export type Capability =
  | 'exec.stream'
  | 'terminal'
  | 'sleep'
  | 'volumes'
  | 'snapshot'
  | 'port.expose'

// --- Capability Interfaces ---

export interface StreamableSandbox extends Sandbox {
  execStream(command: string, options?: ExecOptions): Promise<ReadableStream<Uint8Array>>
}

export interface TerminalSandbox extends Sandbox {
  startTerminal(options?: TerminalOptions): Promise<TerminalInfo>
}

export interface TerminalOptions {
  shell?: string
  hostname?: string
}

export interface TerminalInfo {
  url: string
  port: number
}

export interface SleepableSandbox extends Sandbox {
  sleep(): Promise<void>
  wake(): Promise<void>
}

export interface PortExposeSandbox extends Sandbox {
  exposePort(port: number, options?: { hostname?: string }): Promise<{ url: string }>
}

export interface SnapshotSandbox extends Sandbox {
  createSnapshot(name?: string): Promise<{ snapshotId: string }>
  restoreSnapshot(snapshotId: string): Promise<void>
}

export interface VolumeProvider extends SandboxProvider {
  createVolume(config: VolumeConfig): Promise<VolumeInfo>
  deleteVolume(id: string): Promise<void>
  listVolumes(): Promise<VolumeInfo[]>
}

export interface VolumeConfig {
  name: string
  region?: string
  sizeGB?: number
}

export interface VolumeInfo {
  id: string
  name: string
  sizeGB: number
  attachedTo: string | null
}

// --- Adapter（provider 作者实现的对接层） ---

export interface SandboxAdapter {
  readonly name: string
  readonly capabilities: ReadonlySet<Capability>

  createSandbox(config: CreateConfig): Promise<AdapterSandbox>
  getSandbox(id: string): Promise<AdapterSandbox>
  listSandboxes(filter?: ListFilter): Promise<SandboxInfo[]>
  destroySandbox(id: string): Promise<void>

  // Volume 操作（可选）
  createVolume?(config: VolumeConfig): Promise<VolumeInfo>
  deleteVolume?(id: string): Promise<void>
  listVolumes?(): Promise<VolumeInfo[]>
}

export interface AdapterSandbox {
  id: string
  state: SandboxState
  createdAt: string

  exec(command: string, options?: ExecOptions): Promise<ExecResult>

  // 文件操作：provider 可以提供原生实现，也可以不实现（SDK 会用 exec fallback）
  writeFile?(path: string, content: string | Uint8Array): Promise<void>
  readFile?(path: string): Promise<Uint8Array>
  uploadArchive?(archive: Uint8Array | ReadableStream, destDir?: string): Promise<void>
  downloadArchive?(srcDir?: string): Promise<ReadableStream>

  // 可选能力
  execStream?(command: string, options?: ExecOptions): Promise<ReadableStream<Uint8Array>>
  sleep?(): Promise<void>
  wake?(): Promise<void>
  startTerminal?(options?: TerminalOptions): Promise<TerminalInfo>
  exposePort?(port: number, options?: { hostname?: string }): Promise<{ url: string }>
  createSnapshot?(name?: string): Promise<{ snapshotId: string }>
  restoreSnapshot?(snapshotId: string): Promise<void>
}
