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

export interface SkillDefinition {
  /** Skill 名称，用作文件名（不含 .md 后缀） */
  name: string
  /** Skill 内容（markdown 文本） */
  content: string
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

  /** 创建超时（秒）。默认由 provider 决定（Daytona 默认 60s） */
  timeout?: number

  /**
   * 注入到沙箱的 skill 文件列表。
   * 每个 skill 会被写入沙箱的 `~/.claude/skills/` 目录。
   */
  skills?: SkillDefinition[]

  /** 绑定的服务。凭证自动注入为环境变量（需 provider 支持 'services' 能力） */
  services?: ServiceBinding[]

  /** 端口映射 [hostPort, guestPort][]。本地模式使用，将容器端口转发到宿主机端口 */
  ports?: [number, number][]
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
  | 'services'

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

export interface Disposable {
  dispose(): void
}

export interface TerminalSession {
  /** 向 PTY 发送输入 */
  write(data: string): void
  /** 监听 PTY 输出 */
  onData(cb: (data: string) => void): Disposable
  /** 调整终端尺寸 */
  resize(cols: number, rows: number): void
  /** 关闭连接 */
  close(): void
  /** 连接状态 */
  readonly state: 'connecting' | 'open' | 'closed'
  /** 连接打开时 resolve */
  readonly ready: Promise<void>
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

// --- Service（数据服务层） ---

export type ServiceType = 'postgres'

export interface ServiceConfig {
  /** 服务类型 */
  type: ServiceType
  /** 服务名称 */
  name: string
  /** 区域偏好（provider 可忽略） */
  region?: string
}

export interface ServiceCredentials {
  /** 主连接 URL（如 postgres://...） */
  url: string
  /** 注入到 sandbox 的环境变量映射 */
  env: Record<string, string>
}

export interface ServiceInfo {
  id: string
  type: ServiceType
  name: string
  state: 'creating' | 'ready' | 'error' | 'terminated'
  credentials: ServiceCredentials
}

export interface ServiceProvider extends SandboxProvider {
  createService(config: ServiceConfig): Promise<ServiceInfo>
  getService(id: string): Promise<ServiceInfo>
  listServices(): Promise<ServiceInfo[]>
  destroyService(id: string): Promise<void>
}

export interface ServiceBinding {
  /** Service ID */
  id: string
  /** 环境变量前缀。默认无前缀（直接用 DATABASE_URL 等）。
   *  设为 'BRAIN' 则注入 BRAIN_DATABASE_URL 等 */
  envPrefix?: string
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

  // Service 操作（可选）
  createService?(config: ServiceConfig): Promise<ServiceInfo>
  getService?(id: string): Promise<ServiceInfo>
  listServices?(): Promise<ServiceInfo[]>
  destroyService?(id: string): Promise<void>
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
