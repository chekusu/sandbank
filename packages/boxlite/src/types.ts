// --- Adapter configuration (discriminated union) ---

/** Remote mode: connect to a BoxRun REST API */
export interface BoxLiteRemoteConfig {
  mode?: 'remote'
  /** BoxRun REST API base URL, e.g. 'http://localhost:8090' */
  apiUrl: string
  /** Multi-tenant prefix (e.g. 'default') */
  prefix?: string
  /** Bearer token (if already obtained) */
  apiToken?: string
  /** OAuth2 client ID (for automatic token acquisition) */
  clientId?: string
  /** OAuth2 client secret (for automatic token acquisition) */
  clientSecret?: string
}

/** Local mode: use boxlite Python SDK directly on this machine */
export interface BoxLiteLocalConfig {
  mode: 'local'
  /** Path to Python 3.10+ interpreter (default: 'python3') */
  pythonPath?: string
  /** BoxLite home directory (default: '~/.boxlite') */
  boxliteHome?: string
}

/** BoxLite adapter configuration — remote (BoxRun REST API) or local (Python SDK) */
export type BoxLiteAdapterConfig = BoxLiteRemoteConfig | BoxLiteLocalConfig

// --- Unified client interface ---

export interface BoxLiteClient {
  createBox(params: BoxLiteCreateParams): Promise<BoxLiteBox>
  getBox(boxId: string): Promise<BoxLiteBox>
  listBoxes(status?: string, pageSize?: number): Promise<BoxLiteBox[]>
  deleteBox(boxId: string, force?: boolean): Promise<void>
  startBox(boxId: string): Promise<void>
  stopBox(boxId: string): Promise<void>
  exec(boxId: string, req: BoxLiteExecRequest): Promise<{ stdout: string; stderr: string; exitCode: number }>
  execStream(boxId: string, req: BoxLiteExecRequest): Promise<ReadableStream<Uint8Array>>
  uploadFiles(boxId: string, path: string, tarData: Uint8Array): Promise<void>
  downloadFiles(boxId: string, path: string): Promise<ReadableStream<Uint8Array>>
  createSnapshot(boxId: string, name: string): Promise<BoxLiteSnapshot>
  restoreSnapshot(boxId: string, name: string): Promise<void>
  listSnapshots(boxId: string): Promise<BoxLiteSnapshot[]>
  deleteSnapshot(boxId: string, name: string): Promise<void>
  cloneBox(boxId: string, name?: string): Promise<BoxLiteBox>
  exportBox?(boxId: string): Promise<ReadableStream<Uint8Array>>
  importBox?(data: Uint8Array): Promise<BoxLiteBox>
  execAsync?(boxId: string, req: BoxLiteExecRequest): Promise<BoxLiteExecution>
  getExecOutput?(boxId: string, execId: string): Promise<ReadableStream<Uint8Array>>
  sendExecInput?(boxId: string, execId: string, data: string): Promise<void>
  signalExec?(boxId: string, execId: string, signal: number): Promise<void>
  resizeExec?(boxId: string, execId: string, cols: number, rows: number): Promise<void>
  getMetrics?(): Promise<Record<string, unknown>>
  getBoxMetrics?(boxId: string): Promise<Record<string, unknown>>
  getConfig?(): Promise<Record<string, unknown>>
  /** Dispose of the client (cleanup subprocess, etc.) */
  dispose?(): Promise<void>
}

// --- BoxRun REST API / bridge response types ---

export interface BoxLiteBox {
  id: string
  boxlite_id?: string
  name: string | null
  status: BoxStatus
  created_at: string
  started_at?: string | null
  stopped_at?: string | null
  image: string
  cpu: number
  memory_mb: number
  disk_size_gb?: number
  workdir?: string
  env?: Record<string, string> | null
  network?: boolean | BoxLiteNetworkConfig
  error_code?: string | null
  error_message?: string | null
  volumes?: unknown
}

export type BoxStatus =
  | 'configured'
  | 'running'
  | 'stopping'
  | 'stopped'
  | 'paused'
  | 'unknown'

export interface BoxLiteExecRequest {
  cmd: string[]
  env?: Record<string, string>
  timeout_seconds?: number
  working_dir?: string
  tty?: boolean
}

export interface BoxLiteExecution {
  id: string
  box_id?: string
  cmd?: string[]
  status: string
  exit_code: number | null
  stdout?: string
  stderr?: string
}

export interface BoxLiteSnapshot {
  id: string
  box_id: string
  name: string
  created_at: number
  size_bytes: number
  guest_disk_bytes?: number
  container_disk_bytes?: number
}

export interface BoxLiteNetworkConfig {
  mode: 'enabled' | 'disabled'
  allow_net?: string[]
}

export interface BoxLiteSecretSpec {
  name: string
  value: string
  target?: string
}

export interface BoxLiteCreateParams {
  image?: string
  /** Path to a local OCI layout directory. When set, overrides `image` (no registry pull). */
  rootfs_path?: string
  name?: string
  cpu?: number
  memory_mb?: number
  disk_size_gb?: number
  working_dir?: string
  env?: Record<string, string>
  auto_remove?: boolean
  security?: string
  /** Port mappings [hostPort, guestPort][] for local mode */
  ports?: [number, number][]
  network?: BoxLiteNetworkConfig
  secrets?: BoxLiteSecretSpec[]
  entrypoint?: string
  cmd?: string[]
  user?: string
  labels?: Record<string, string>
}

export interface BoxLiteTokenResponse {
  access_token: string
  token_type: string
  expires_in: number
}
