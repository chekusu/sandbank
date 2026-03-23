import { describe, it, expect, vi } from 'vitest'

vi.mock('@sandbank.dev/cloud', () => ({
  createX402Fetch: vi.fn((config: Record<string, unknown>) => ({
    x402Fetch: vi.fn(),
    x402FetchRaw: vi.fn(),
    baseUrl: config.url || 'https://cloud.sandbank.dev',
  })),
}))

vi.mock('./auth.js', () => ({
  resolveCloudConfig: vi.fn((flags: Record<string, unknown>) => ({
    url: flags.url || 'https://cloud.sandbank.dev',
    apiToken: flags.apiKey,
  })),
}))

import { createApiClient, printJson } from './api.js'

describe('createApiClient', () => {
  it('creates a client with resolved config', () => {
    const client = createApiClient({ apiKey: 'test' })
    expect(client).toHaveProperty('x402Fetch')
    expect(client).toHaveProperty('x402FetchRaw')
    expect(client).toHaveProperty('baseUrl')
  })
})

describe('printJson', () => {
  it('prints JSON to stdout', () => {
    const spy = vi.spyOn(console, 'log').mockImplementation(() => {})
    printJson({ foo: 'bar' })
    expect(spy).toHaveBeenCalledWith(JSON.stringify({ foo: 'bar' }, null, 2))
    spy.mockRestore()
  })
})
