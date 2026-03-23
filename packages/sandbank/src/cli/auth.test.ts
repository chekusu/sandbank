import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest'

vi.mock('./config.js', () => ({
  loadCredentials: vi.fn(() => ({})),
}))

import { resolveCloudConfig, currentBoxId } from './auth.js'
import { loadCredentials } from './config.js'

describe('resolveCloudConfig', () => {
  const origEnv = { ...process.env }

  beforeEach(() => {
    vi.mocked(loadCredentials).mockReturnValue({})
    delete process.env['SANDBANK_API_KEY']
    delete process.env['SANDBANK_AGENT_TOKEN']
    delete process.env['SANDBANK_WALLET_KEY']
    delete process.env['SANDBANK_API_URL']
  })

  afterEach(() => {
    Object.assign(process.env, origEnv)
  })

  it('uses default URL when nothing configured', () => {
    const config = resolveCloudConfig({})
    expect(config.url).toBe('https://cloud.sandbank.dev')
    expect(config.apiToken).toBeUndefined()
    expect(config.walletPrivateKey).toBeUndefined()
  })

  it('prioritizes --api-key flag over env', () => {
    process.env['SANDBANK_API_KEY'] = 'env-key'
    const config = resolveCloudConfig({ apiKey: 'flag-key' })
    expect(config.apiToken).toBe('flag-key')
  })

  it('uses SANDBANK_API_KEY env var', () => {
    process.env['SANDBANK_API_KEY'] = 'env-key'
    const config = resolveCloudConfig({})
    expect(config.apiToken).toBe('env-key')
  })

  it('uses SANDBANK_AGENT_TOKEN as fallback', () => {
    process.env['SANDBANK_AGENT_TOKEN'] = 'agent-token'
    const config = resolveCloudConfig({})
    expect(config.apiToken).toBe('agent-token')
  })

  it('prefers SANDBANK_API_KEY over SANDBANK_AGENT_TOKEN', () => {
    process.env['SANDBANK_API_KEY'] = 'api-key'
    process.env['SANDBANK_AGENT_TOKEN'] = 'agent-token'
    const config = resolveCloudConfig({})
    expect(config.apiToken).toBe('api-key')
  })

  it('falls back to saved credentials', () => {
    vi.mocked(loadCredentials).mockReturnValue({ apiKey: 'saved-key', url: 'https://custom.dev' })
    const config = resolveCloudConfig({})
    expect(config.apiToken).toBe('saved-key')
    expect(config.url).toBe('https://custom.dev')
  })

  it('resolves wallet key from flag', () => {
    const config = resolveCloudConfig({ walletKey: '0xabc' })
    expect(config.walletPrivateKey).toBe('0xabc')
  })

  it('resolves wallet key from env', () => {
    process.env['SANDBANK_WALLET_KEY'] = '0xdef'
    const config = resolveCloudConfig({})
    expect(config.walletPrivateKey).toBe('0xdef')
  })

  it('resolves wallet key from saved credentials', () => {
    vi.mocked(loadCredentials).mockReturnValue({ walletKey: '0x123' })
    const config = resolveCloudConfig({})
    expect(config.walletPrivateKey).toBe('0x123')
  })

  it('uses --url flag', () => {
    const config = resolveCloudConfig({ url: 'http://localhost:3000' })
    expect(config.url).toBe('http://localhost:3000')
  })

  it('uses SANDBANK_API_URL env', () => {
    process.env['SANDBANK_API_URL'] = 'http://local:4000'
    const config = resolveCloudConfig({})
    expect(config.url).toBe('http://local:4000')
  })
})

describe('currentBoxId', () => {
  const origEnv = { ...process.env }

  afterEach(() => {
    Object.assign(process.env, origEnv)
  })

  it('returns SANDBANK_BOX_ID when set', () => {
    process.env['SANDBANK_BOX_ID'] = 'box-123'
    expect(currentBoxId()).toBe('box-123')
  })

  it('returns undefined when not set', () => {
    delete process.env['SANDBANK_BOX_ID']
    expect(currentBoxId()).toBeUndefined()
  })
})
