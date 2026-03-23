import { homedir } from 'node:os'
import { join } from 'node:path'
import type { CliFlags } from '../auth.js'
import { loadCredentials, saveCredentials, maskSecret } from '../config.js'

const SENSITIVE_KEYS = new Set(['apiKey', 'walletKey'])

export function configCommand(args: string[], flags: CliFlags): void {
  const sub = args[0]

  if (sub === 'set') {
    const key = args[1] as string | undefined
    const value = args[2] as string | undefined
    if (!key || value === undefined) {
      console.error('Usage: sandbank config set <key> <value>')
      process.exit(1)
    }
    const creds = loadCredentials()
    ;(creds as Record<string, string>)[key] = value
    saveCredentials(creds)
    console.log(`${key} = ${SENSITIVE_KEYS.has(key) ? maskSecret(value) : value}`)
    return
  }

  if (sub === 'get') {
    const key = args[1] as string | undefined
    if (!key) {
      console.error('Usage: sandbank config get <key>')
      process.exit(1)
    }
    const creds = loadCredentials()
    const value = (creds as Record<string, string | undefined>)[key]
    if (value !== undefined) {
      console.log(value)
    }
    return
  }

  if (sub === 'path') {
    console.log(join(homedir(), '.sandbank', 'credentials.json'))
    return
  }

  // Default: show all config
  const creds = loadCredentials()
  if (flags.json) {
    const masked = { ...creds } as Record<string, string | undefined>
    for (const key of SENSITIVE_KEYS) {
      if (masked[key]) masked[key] = maskSecret(masked[key]!)
    }
    console.log(JSON.stringify(masked, null, 2))
    return
  }

  const entries = Object.entries(creds).filter(([, v]) => v !== undefined)
  if (entries.length === 0) {
    console.log('No configuration. Run: sandbank login --api-key <key>')
    return
  }
  for (const [key, value] of entries) {
    const display = SENSITIVE_KEYS.has(key) ? maskSecret(value as string) : value
    console.log(`${key}: ${display}`)
  }
}
