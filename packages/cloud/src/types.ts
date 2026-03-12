/** Configuration for SandbankCloudAdapter */
export interface SandbankCloudConfig {
  /** Sandbank Cloud API URL (default: 'https://cloud.sandbank.dev') */
  url?: string
  /**
   * EVM wallet private key for x402 payments (hex string with 0x prefix).
   * Required for x402 payment — if omitted, paid endpoints will fail with 402.
   */
  walletPrivateKey?: string
  /**
   * Bearer API token for authenticated (internal) access.
   * When set, x402 payment is bypassed.
   */
  apiToken?: string
}

/** Sandbank Cloud box response */
export interface CloudBox {
  id: string
  name: string | null
  status: string
  created_at: string
  image: string
  cpu: number
  memory_mb: number
  disk_size_gb?: number
  ports?: Record<string, number>
}

/** Exec response */
export interface CloudExecResult {
  id: string
  box_id: string
  cmd: string[]
  status: string
  exit_code: number
  stdout: string
  stderr: string
}
