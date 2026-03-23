import type { CliFlags } from '../auth.js'
import { loadCredentials, saveCredentials, maskSecret } from '../config.js'

export function loginCommand(args: string[], flags: CliFlags): void {
  const creds = loadCredentials()

  if (flags.apiKey) {
    creds.apiKey = flags.apiKey
  }
  if (flags.walletKey) {
    creds.walletKey = flags.walletKey
  }
  if (flags.url) {
    creds.url = flags.url
  }

  if (!flags.apiKey && !flags.walletKey && !flags.url) {
    console.error('Usage: sandbank login --api-key <key> [--wallet-key <0x..>] [--url <url>]')
    process.exit(1)
  }

  saveCredentials(creds)

  console.log('Credentials saved to ~/.sandbank/credentials.json')
  if (creds.apiKey) console.log(`  api-key:    ${maskSecret(creds.apiKey)}`)
  if (creds.walletKey) console.log(`  wallet-key: ${maskSecret(creds.walletKey)}`)
  if (creds.url) console.log(`  url:        ${creds.url}`)
}
