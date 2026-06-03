import { describe, expect, it } from 'vitest'

const DEFAULT_LIVE_URL = 'https://sandbank-harness-dynamic-test.o-u-turing.workers.dev'
const LIVE_URL = (process.env['SANDBANK_CODE_MODE_E2E_URL'] ?? DEFAULT_LIVE_URL).replace(/\/$/, '')
const RUN_LIVE = process.env['SANDBANK_RUN_LIVE_DYNAMIC_WORKER_E2E'] === '1'

const describeLive = RUN_LIVE ? describe : describe.skip

describeLive('Sandbank code mode live Dynamic Worker e2e', () => {
  it('runs the search code mode example through the deployed Cloudflare Dynamic Worker', async () => {
    const response = await fetch(`${LIVE_URL}/__sandbank/e2e/search-code`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ query: 'tokyo french restaurants' }),
    })
    const body = await response.json().catch(async () => ({ raw: await response.text() })) as {
      ok?: boolean
      service?: string
      tool?: {
        result?: { query?: string; count?: number; top?: string }
        artifacts?: Array<{ name: string; path: string }>
      }
      artifacts?: Record<string, unknown>
      raw?: string
    }

    expect(response.status, JSON.stringify(body)).toBe(200)
    expect(body.ok).toBe(true)
    expect(body.service).toBe('sandbank-code-mode-e2e')
    expect(body.tool?.result).toMatchObject({
      query: 'tokyo french restaurants',
      count: 3,
      top: 'Lature',
    })
    expect(body.tool?.artifacts?.map(artifact => artifact.name).sort()).toEqual(['restaurants.json', 'summary.json'])
    expect(body.artifacts?.['restaurants.json']).toMatchObject({
      query: 'tokyo french restaurants',
      ranked: expect.arrayContaining([
        expect.objectContaining({ title: 'Lature' }),
      ]),
    })
  }, 60_000)
})
