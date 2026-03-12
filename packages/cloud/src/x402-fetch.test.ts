import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest'
import { createX402Fetch } from './x402-fetch.js'

const mockFetch = vi.fn()

beforeEach(() => {
  mockFetch.mockReset()
  vi.stubGlobal('fetch', mockFetch)
})

afterEach(() => {
  vi.restoreAllMocks()
})

function jsonResponse(data: unknown, status = 200, headers?: Record<string, string>) {
  return new Response(JSON.stringify(data), {
    status,
    headers: { 'Content-Type': 'application/json', ...headers },
  })
}

describe('createX402Fetch', () => {
  describe('apiToken mode', () => {
    it('sends Bearer token on requests', async () => {
      mockFetch.mockResolvedValueOnce(jsonResponse({ id: 'box-1' }))

      const { x402Fetch } = createX402Fetch({ url: 'https://test.dev', apiToken: 'my-token' })
      await x402Fetch('/boxes')

      const [, opts] = mockFetch.mock.calls[0]!
      expect(opts.headers['Authorization']).toBe('Bearer my-token')
    })

    it('parses JSON response', async () => {
      mockFetch.mockResolvedValueOnce(jsonResponse({ id: 'box-1', status: 'running' }))

      const { x402Fetch } = createX402Fetch({ apiToken: 'tok' })
      const result = await x402Fetch<{ id: string }>('/boxes/box-1')

      expect(result.id).toBe('box-1')
    })
  })

  describe('no auth mode', () => {
    it('throws clear error on 402 without wallet', async () => {
      mockFetch.mockResolvedValueOnce(new Response('', { status: 402 }))

      const { x402Fetch } = createX402Fetch({})
      await expect(x402Fetch('/boxes')).rejects.toThrow('402 Payment Required')
    })
  })

  describe('error handling', () => {
    it('throws on non-ok responses', async () => {
      mockFetch.mockResolvedValueOnce(jsonResponse({ error: 'Server error' }, 500))

      const { x402Fetch } = createX402Fetch({ apiToken: 'tok' })
      await expect(x402Fetch('/boxes')).rejects.toThrow('500')
    })

    it('handles empty response bodies', async () => {
      mockFetch.mockResolvedValueOnce(new Response('', { status: 200 }))

      const { x402Fetch } = createX402Fetch({ apiToken: 'tok' })
      const result = await x402Fetch('/boxes/x')
      expect(result).toEqual({})
    })
  })

  describe('x402FetchRaw', () => {
    it('returns raw Response object', async () => {
      mockFetch.mockResolvedValueOnce(new Response('raw-data', { status: 200 }))

      const { x402FetchRaw } = createX402Fetch({ apiToken: 'tok' })
      const resp = await x402FetchRaw('/boxes/x/files?path=/')

      expect(resp.status).toBe(200)
      expect(await resp.text()).toBe('raw-data')
    })

    it('adds auth header', async () => {
      mockFetch.mockResolvedValueOnce(new Response('', { status: 200 }))

      const { x402FetchRaw } = createX402Fetch({ apiToken: 'my-tok' })
      await x402FetchRaw('/boxes/x/files')

      const [, opts] = mockFetch.mock.calls[0]!
      expect(opts.headers['Authorization']).toBe('Bearer my-tok')  // note: exactly 'my-tok' not 'my-token'
    })
  })

  describe('baseUrl', () => {
    it('defaults to cloud.sandbank.dev', () => {
      const { baseUrl } = createX402Fetch({})
      expect(baseUrl).toBe('https://cloud.sandbank.dev')
    })

    it('uses custom URL', () => {
      const { baseUrl } = createX402Fetch({ url: 'http://localhost:3140/' })
      expect(baseUrl).toBe('http://localhost:3140')
    })

    it('strips trailing slash', () => {
      const { baseUrl } = createX402Fetch({ url: 'https://example.com/' })
      expect(baseUrl).toBe('https://example.com')
    })
  })
})
