/** BoxLite adapter configuration */
export interface BoxLiteAdapterConfig {
  /** BoxLite API base URL, e.g. 'http://localhost:8080' */
  apiUrl: string
  /** Multi-tenant prefix, defaults to 'default' */
  prefix?: string
  /** Bearer token (if already obtained) */
  apiToken?: string
  /** OAuth2 client ID (for automatic token acquisition) */
  clientId?: string
  /** OAuth2 client secret (for automatic token acquisition) */
  clientSecret?: string
}

// --- BoxLite API response types ---

export interface BoxLiteBox {
  box_id: string
  name: string | null
  status: BoxStatus
  created_at: string
  updated_at?: string
  image: string
  cpus: number
  memory_mib: number
}

export type BoxStatus =
  | 'configured'
  | 'running'
  | 'stopping'
  | 'stopped'
  | 'paused'
  | 'unknown'

export interface BoxLiteExecRequest {
  command: string
  args?: string[]
  env?: Record<string, string>
  timeout_seconds?: number
  working_dir?: string
  tty?: boolean
}

export interface BoxLiteExecution {
  execution_id: string
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

export interface BoxLiteCreateParams {
  image: string
  name?: string
  cpus?: number
  memory_mib?: number
  disk_size_gb?: number
  working_dir?: string
  env?: Record<string, string>
  auto_remove?: boolean
  security?: string
}

export interface BoxLiteTokenResponse {
  access_token: string
  token_type: string
  expires_in: number
}
