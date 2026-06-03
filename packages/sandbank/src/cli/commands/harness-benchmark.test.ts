import { beforeEach, describe, expect, it, vi } from 'vitest'

const mocks = vi.hoisted(() => ({
  runHarnessBenchmarkSuite: vi.fn(),
}))

vi.mock('../../harness-benchmark.js', async importOriginal => {
  const actual = await importOriginal<typeof import('../../harness-benchmark.js')>()
  return {
    ...actual,
    runHarnessBenchmarkSuite: mocks.runHarnessBenchmarkSuite,
  }
})

const { harnessBenchmarkCommand } = await import('./harness-benchmark.js')

describe('harnessBenchmarkCommand', () => {
  beforeEach(() => {
    vi.restoreAllMocks()
    mocks.runHarnessBenchmarkSuite.mockReset()
  })

  it('runs a one-question benchmark and prints JSON', async () => {
    const log = vi.spyOn(console, 'log').mockImplementation(() => {})
    mocks.runHarnessBenchmarkSuite.mockResolvedValue({
      generatedAt: '2026-06-03T00:00:00.000Z',
      baseUrl: 'https://harness.example',
      summary: { total: 1, passed: 1, failed: 0, averageScore: 93 },
      cases: [],
    })

    await harnessBenchmarkCommand([
      '--base-url', 'https://harness.example',
      '--question', '@agent inspect this',
      '--case-id', 'manual',
      '--json',
    ], {})

    expect(mocks.runHarnessBenchmarkSuite).toHaveBeenCalledWith(expect.objectContaining({
      baseUrl: 'https://harness.example',
      cases: [expect.objectContaining({ id: 'manual', question: '@agent inspect this' })],
    }))
    expect(JSON.parse(String(log.mock.calls[0]?.[0]))).toMatchObject({
      summary: { averageScore: 93 },
    })
  })

  it('prints concise text output for scored cases', async () => {
    const log = vi.spyOn(console, 'log').mockImplementation(() => {})
    mocks.runHarnessBenchmarkSuite.mockResolvedValue({
      generatedAt: '2026-06-03T00:00:00.000Z',
      baseUrl: 'https://harness.example',
      summary: { total: 1, passed: 0, failed: 1, averageScore: 45 },
      cases: [{
        caseId: 'case-1',
        question: '@agent broken',
        score: { score: 45, passed: false, feedback: ['missing dynamic_worker_capsule'], breakdown: [] },
        observations: { finalText: '', eventCount: 2, errors: [{ code: 'missing_db9_configuration', message: 'missing' }] },
        timings: { totalMs: 100 },
        timeline: [],
      }],
    })

    await harnessBenchmarkCommand([
      '--base-url', 'https://harness.example',
      '--question', '@agent broken',
    ], {})

    const output = log.mock.calls.map(call => String(call[0])).join('\n')
    expect(output).toContain('Harness benchmark: 45/100 average')
    expect(output).toContain('case-1: 45/100 failed')
    expect(output).toContain('missing dynamic_worker_capsule')
  })
})
