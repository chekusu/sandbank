import { describe, expect, it, vi } from 'vitest'
import {
  parseHarnessSse,
  runHarnessBenchmarkSuite,
  scoreHarnessRun,
  type HarnessBenchmarkEvent,
} from './harness-benchmark.js'

describe('parseHarnessSse', () => {
  it('parses harness SSE events across chunk boundaries and skips malformed frames', () => {
    const parsed = parseHarnessSse([
      'data: {"type":"harness.started","harnessId":"h1"}\n\n',
      'data: {"type":"text.delta","messageId":"m1","text":"hel',
      'lo"}\n\n',
      'event: ping\n\n',
      'data: not-json\n\n',
      'data: {"type":"run.done","messageId":"m1","status":"completed"}\n\n',
    ])

    expect(parsed.events.map(event => event.type)).toEqual(['harness.started', 'text.delta', 'run.done'])
    expect(parsed.events[1]).toMatchObject({ text: 'hello' })
    expect(parsed.malformedFrames).toBe(1)
  })

  it('parses a final SSE frame even when the stream omits the closing blank line', () => {
    const parsed = parseHarnessSse([
      'data: {"type":"harness.started","harnessId":"h1"}\n\n',
      'data: {"type":"run.done","status":"completed"}',
    ])

    expect(parsed.events.map(event => event.type)).toEqual(['harness.started', 'run.done'])
    expect(parsed.malformedFrames).toBe(0)
  })
})

describe('scoreHarnessRun', () => {
  it('scores lifecycle, dynamic worker, model, workspace, expectations, and latency separately', () => {
    const events: HarnessBenchmarkEvent[] = [
      { type: 'harness.started', harnessId: 'h1', title: 'DB-native Sandbank harness', provider: 'custom' },
      { type: 'message.created', message: { id: 'm1', role: 'assistant', content: '' } },
      { type: 'harness.event', harnessId: 'h1', label: 'checkpoint.created', detail: 'checkpoint_1' },
      { type: 'harness.event', harnessId: 'h1', label: 'workspace.persisted', detail: '/runs/r1/request.json' },
      { type: 'tool.use', toolCallId: 'tool_dw', name: 'dynamic_worker_capsule', input: {} },
      { type: 'harness.event', harnessId: 'h1', label: 'dynamic-worker.artifact', detail: '/runs/r1/artifacts/a.json' },
      { type: 'tool.result', toolCallId: 'tool_dw', name: 'dynamic_worker_capsule', status: 'completed', result: {} },
      { type: 'tool.use', toolCallId: 'tool_model', name: 'deepseek_v4_pro', input: {} },
      { type: 'text.delta', messageId: 'm1', text: 'ok from agent' },
      { type: 'tool.result', toolCallId: 'tool_model', name: 'deepseek_v4_pro', status: 'completed', result: {} },
      { type: 'run.done', messageId: 'm1', status: 'completed', metadata: {} },
    ]

    const score = scoreHarnessRun({
      caseId: 'basic',
      events,
      finalText: 'ok from agent',
      httpStatus: 200,
      malformedFrames: 0,
      timings: { firstEventMs: 50, totalMs: 600 },
    }, {
      requireDynamicWorker: true,
      requiredTextIncludes: ['ok'],
      maxFirstEventMs: 100,
      maxTotalMs: 1000,
    })

    expect(score.score).toBe(100)
    expect(score.passed).toBe(true)
    expect(score.breakdown.map(item => [item.id, item.earned, item.max])).toEqual([
      ['transport', 10, 10],
      ['lifecycle', 15, 15],
      ['workspace', 15, 15],
      ['dynamic_worker', 20, 20],
      ['model', 15, 15],
      ['expectations', 15, 15],
      ['latency', 10, 10],
    ])
  })

  it('returns actionable feedback when the agent never reaches the dynamic worker', () => {
    const score = scoreHarnessRun({
      caseId: 'missing-dw',
      events: [
        { type: 'harness.started', harnessId: 'h1', title: 'DB-native Sandbank harness', provider: 'custom' },
        { type: 'error', code: 'missing_db9_configuration', message: 'DB9_DATABASE_ID and DB9_TOKEN are required' },
        { type: 'run.done', messageId: 'm1', status: 'failed', metadata: {} },
      ],
      finalText: '',
      httpStatus: 200,
      malformedFrames: 0,
      timings: { totalMs: 200 },
    }, {
      requireDynamicWorker: true,
      requiredTextIncludes: ['ok'],
    })

    expect(score.passed).toBe(false)
    expect(score.score).toBeLessThan(60)
    expect(score.feedback.join('\n')).toContain('dynamic_worker_capsule')
    expect(score.feedback.join('\n')).toContain('missing_db9_configuration')
  })
})

describe('runHarnessBenchmarkSuite', () => {
  it('posts each question to the harness stream endpoint and scores each case', async () => {
    const fetchImpl = vi.fn(async (_input: string | URL | Request, init?: RequestInit) => {
      const body = JSON.parse(String(init?.body))
      const encoder = new TextEncoder()
      return new Response(new ReadableStream({
        start(controller) {
          const send = (event: unknown) => controller.enqueue(encoder.encode(`data: ${JSON.stringify(event)}\n\n`))
          send({ type: 'harness.started', harnessId: `h_${body.metadata.benchmark.caseId}`, title: 'DB-native Sandbank harness', provider: 'custom' })
          send({ type: 'message.created', message: { id: 'm1', role: 'assistant', content: '' } })
          send({ type: 'harness.event', harnessId: 'h1', label: 'checkpoint.created', detail: 'checkpoint_1' })
          send({ type: 'harness.event', harnessId: 'h1', label: 'workspace.persisted', detail: '/runs/r1/request.json' })
          send({ type: 'tool.use', toolCallId: 'dw1', name: 'dynamic_worker_capsule', input: {} })
          send({ type: 'tool.result', toolCallId: 'dw1', name: 'dynamic_worker_capsule', status: 'completed', result: {} })
          send({ type: 'tool.use', toolCallId: 'model1', name: 'deepseek_v4_pro', input: {} })
          send({ type: 'text.delta', messageId: 'm1', text: `answer:${body.message}` })
          send({ type: 'tool.result', toolCallId: 'model1', name: 'deepseek_v4_pro', status: 'completed', result: {} })
          send({ type: 'run.done', messageId: 'm1', status: 'completed', metadata: {} })
          controller.close()
        },
      }), { headers: { 'content-type': 'text/event-stream' } })
    })

    const report = await runHarnessBenchmarkSuite({
      baseUrl: 'https://harness.example',
      apiKey: 'secret-token',
      fetchImpl,
      now: (() => {
        let t = 1_000
        return () => {
          t += 100
          return t
        }
      })(),
      cases: [
        { id: 'q1', question: '@agent first', expect: { requiredTextIncludes: ['answer:@agent first'] } },
        { id: 'q2', question: '@agent second', expect: { requiredTextIncludes: ['answer:@agent second'] } },
      ],
    })

    expect(fetchImpl).toHaveBeenCalledTimes(2)
    expect(fetchImpl.mock.calls[0]?.[0]).toBe('https://harness.example/api/db-native-agent-harness/stream')
    expect(fetchImpl.mock.calls[0]?.[1]?.headers).toMatchObject({
      Accept: 'text/event-stream',
      Authorization: 'Bearer secret-token',
      'Content-Type': 'application/json',
    })
    expect(report.summary).toMatchObject({ total: 2, passed: 2, failed: 0, averageScore: 100 })
    expect(report.cases.map(item => item.caseId)).toEqual(['q1', 'q2'])
    expect(report.cases[0]?.observations.finalText).toBe('answer:@agent first')
    expect(report.cases[0]?.timeline.map(item => item.type)).toContain('tool.result')
  })

  it('keeps scoring later cases when a harness request cannot connect', async () => {
    const report = await runHarnessBenchmarkSuite({
      baseUrl: 'https://harness.example',
      fetchImpl: vi.fn(async () => {
        throw new Error('connection refused')
      }),
      now: (() => {
        let t = 2_000
        return () => {
          t += 50
          return t
        }
      })(),
      cases: [
        { id: 'network-failure', question: '@agent unavailable' },
      ],
    })

    expect(report.summary).toMatchObject({ total: 1, passed: 0, failed: 1 })
    expect(report.cases[0]).toMatchObject({
      caseId: 'network-failure',
      httpStatus: 0,
      observations: {
        finalStatus: 'failed',
        errors: [{ code: 'network_error', message: 'connection refused' }],
      },
    })
    expect(report.cases[0]?.score.feedback.join('\n')).toContain('HTTP status was 0')
    expect(report.cases[0]?.score.feedback.join('\n')).toContain('network_error')
  })
})
