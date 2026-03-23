import { describe, it, expect, beforeEach, afterEach } from 'vitest'
import { mkdtempSync, rmSync, writeFileSync, mkdirSync, statSync } from 'node:fs'
import { join } from 'node:path'
import { tmpdir } from 'node:os'
import { loadCredentials, saveCredentials, maskSecret } from './config.js'

describe('maskSecret', () => {
  it('masks long secrets preserving first/last 4 chars', () => {
    expect(maskSecret('abcdefghijklmnop')).toBe('abcd...mnop')
  })

  it('masks short secrets completely', () => {
    expect(maskSecret('short')).toBe('****')
    expect(maskSecret('12345678')).toBe('****')
  })

  it('masks 9-char secrets', () => {
    expect(maskSecret('123456789')).toBe('1234...6789')
  })
})

describe('loadCredentials / saveCredentials', () => {
  let origHome: string | undefined
  let tempDir: string

  beforeEach(() => {
    origHome = process.env['HOME']
    tempDir = mkdtempSync(join(tmpdir(), 'sandbank-test-'))
    process.env['HOME'] = tempDir
  })

  afterEach(() => {
    if (origHome !== undefined) process.env['HOME'] = origHome
    else delete process.env['HOME']
    rmSync(tempDir, { recursive: true, force: true })
  })

  it('returns empty object when no credentials file exists', () => {
    expect(loadCredentials()).toEqual({})
  })

  it('saves and loads credentials', () => {
    saveCredentials({ apiKey: 'test-key', url: 'https://example.com' })
    const creds = loadCredentials()
    expect(creds.apiKey).toBe('test-key')
    expect(creds.url).toBe('https://example.com')
    expect(creds.walletKey).toBeUndefined()
  })

  it('creates config dir', () => {
    saveCredentials({ apiKey: 'key' })
    const dir = join(tempDir, '.sandbank')
    expect(statSync(dir).isDirectory()).toBe(true)
  })

  it('overwrites existing credentials', () => {
    saveCredentials({ apiKey: 'old' })
    saveCredentials({ apiKey: 'new', walletKey: '0xabc' })
    const creds = loadCredentials()
    expect(creds.apiKey).toBe('new')
    expect(creds.walletKey).toBe('0xabc')
  })

  it('handles corrupted credentials file gracefully', () => {
    mkdirSync(join(tempDir, '.sandbank'), { recursive: true })
    writeFileSync(join(tempDir, '.sandbank', 'credentials.json'), 'not json')
    expect(loadCredentials()).toEqual({})
  })
})
