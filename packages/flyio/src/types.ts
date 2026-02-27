/** Fly.io Machines API response types */

export interface FlyioMachine {
  id: string
  name: string
  state: string
  region: string
  instance_id: string
  private_ip: string
  image_ref: {
    registry: string
    repository: string
    tag: string
    digest: string
  }
  created_at: string
  config: FlyioMachineConfig
}

export interface FlyioMachineConfig {
  image: string
  env?: Record<string, string>
  guest?: {
    cpu_kind?: string
    cpus?: number
    memory_mb?: number
  }
  services?: FlyioService[]
  mounts?: Array<{ volume: string; path: string }>
  auto_destroy?: boolean
  restart?: { policy: string }
}

export interface FlyioService {
  internal_port: number
  protocol?: string
  ports: Array<{
    port: number
    handlers: string[]
    tls_options?: { alpn: string[] }
  }>
  autostop?: string
  autostart?: boolean
}

export interface FlyioVolume {
  id: string
  name: string
  region: string
  size_gb: number
  state: string
  attached_machine_id: string | null
  created_at: string
}

export interface FlyioExecResult {
  stdout: string
  stderr: string
  exit_code: number
}

/** Adapter configuration */
export interface FlyioAdapterConfig {
  /** Fly.io API token (from `fly tokens create`) */
  apiToken: string
  /** Fly.io app name (the machine pool's app) */
  appName: string
  /** Default region for machine/volume creation (e.g. 'nrt', 'iad') */
  region?: string
}
