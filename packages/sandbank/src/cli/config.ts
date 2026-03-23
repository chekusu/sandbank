import { existsSync, readFileSync, writeFileSync, mkdirSync } from 'node:fs'
import { join } from 'node:path'
import { homedir } from 'node:os'

function configDir(): string { return join(homedir(), '.sandbank') }
function credentialsFile(): string { return join(configDir(), 'credentials.json') }

export interface SandbankCredentials {
  url?: string
  apiKey?: string
  walletKey?: string
}

export function loadCredentials(): SandbankCredentials {
  try {
    const file = credentialsFile()
    if (existsSync(file)) {
      return JSON.parse(readFileSync(file, 'utf-8'))
    }
  } catch {}
  return {}
}

export function saveCredentials(creds: SandbankCredentials): void {
  const dir = configDir()
  const file = credentialsFile()
  if (!existsSync(dir)) mkdirSync(dir, { recursive: true, mode: 0o700 })
  writeFileSync(file, JSON.stringify(creds, null, 2) + '\n', { mode: 0o600 })
}

export function maskSecret(value: string): string {
  if (value.length <= 8) return '****'
  return value.slice(0, 4) + '...' + value.slice(-4)
}
