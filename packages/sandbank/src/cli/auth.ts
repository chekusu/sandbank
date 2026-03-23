import type { SandbankCloudConfig } from '@sandbank.dev/cloud'
import { loadCredentials } from './config.js'

export interface CliFlags {
  apiKey?: string
  walletKey?: string
  url?: string
  json?: boolean
}

/**
 * Resolve SandbankCloudConfig from CLI flags, env vars, and saved credentials.
 *
 * Priority for API token:
 *   1. --api-key flag
 *   2. SANDBANK_API_KEY env
 *   3. SANDBANK_AGENT_TOKEN env (inside sandbox)
 *   4. ~/.sandbank/credentials.json
 *
 * Priority for wallet key:
 *   1. --wallet-key flag
 *   2. SANDBANK_WALLET_KEY env
 *   3. ~/.sandbank/credentials.json
 */
export function resolveCloudConfig(flags: CliFlags): SandbankCloudConfig {
  const creds = loadCredentials()

  const apiToken = flags.apiKey
    || process.env['SANDBANK_API_KEY']
    || process.env['SANDBANK_AGENT_TOKEN']
    || creds.apiKey

  const walletPrivateKey = flags.walletKey
    || process.env['SANDBANK_WALLET_KEY']
    || creds.walletKey

  const url = flags.url
    || process.env['SANDBANK_API_URL']
    || creds.url
    || 'https://cloud.sandbank.dev'

  return { url, apiToken, walletPrivateKey }
}

/** Get current box ID (only available inside a sandbox) */
export function currentBoxId(): string | undefined {
  return process.env['SANDBANK_BOX_ID']
}
