// --- Adapter configuration (discriminated union) ---

/** SDK mode: uses @daytonaio/sdk (requires Node.js) */
export interface DaytonaSDKConfig {
  mode?: 'sdk'
  apiKey: string
  apiUrl?: string
  target?: string
}

/** REST mode: pure fetch, works in Workers/Edge */
export interface DaytonaRestConfig {
  mode: 'rest'
  apiKey: string
  apiUrl?: string // Control Plane, default: 'https://app.daytona.io/api'
}

/** Daytona adapter configuration — SDK (Node.js) or REST (universal) */
export type DaytonaAdapterConfig = DaytonaSDKConfig | DaytonaRestConfig

// --- Unified client interface ---

export interface DaytonaClient {
  createSandbox(config: DaytonaCreateParams): Promise<DaytonaSandboxData>
  getSandbox(id: string): Promise<DaytonaSandboxData>
  listSandboxes(limit?: number): Promise<DaytonaSandboxData[]>
  deleteSandbox(id: string): Promise<void>

  exec(sandboxId: string, command: string, cwd?: string, timeout?: number): Promise<DaytonaExecResult>
  writeFile(sandboxId: string, path: string, content: string | Uint8Array): Promise<void>
  readFile(sandboxId: string, path: string): Promise<Uint8Array>
  getPreviewUrl(sandboxId: string, port: number): Promise<string>

  createVolume(name: string): Promise<DaytonaVolumeData>
  deleteVolume(id: string): Promise<void>
  listVolumes(): Promise<DaytonaVolumeData[]>
}

// --- API types ---

export interface DaytonaCreateParams {
  image?: string
  envVars?: Record<string, string>
  resources?: { cpu?: number; memory?: number; disk?: number }
  volumes?: Array<{ volumeId: string; mountPath: string }>
  autoDeleteInterval?: number
  target?: string
  timeout?: number
}

export interface DaytonaSandboxData {
  id: string
  state: string
  createdAt: string
  image: string
  volumes?: Array<{ volumeId: string; mountPath?: string }>
}

export interface DaytonaExecResult {
  exitCode: number
  stdout: string
}

export interface DaytonaVolumeData {
  id: string
  name: string
  state?: string
}
