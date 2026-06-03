export interface HarnessBenchmarkEvent {
  type: string
  [key: string]: unknown
}

export interface HarnessBenchmarkCase {
  id: string
  question: string
  history?: Array<{ role?: string; content?: string; metadata?: Record<string, unknown> }>
  model?: { id?: string; label?: string; provider?: string; model?: string }
  uiVariant?: { id?: string; label?: string }
  mentions?: { cleanedMessage?: string; agent?: string }
  attachments?: Array<{ id?: string; name?: string; mediaType?: string; size?: number; metadata?: Record<string, unknown> }>
  metadata?: Record<string, unknown>
  expect?: HarnessBenchmarkExpectations
}

export interface HarnessBenchmarkExpectations {
  forbiddenTextIncludes?: string[]
  maxFirstEventMs?: number
  maxTotalMs?: number
  minScore?: number
  requireDynamicWorker?: boolean
  requiredEventLabels?: string[]
  requiredTextIncludes?: string[]
  requiredToolResults?: string[]
}

export interface HarnessBenchmarkSuiteOptions {
  apiKey?: string
  baseUrl: string
  cases: HarnessBenchmarkCase[]
  fetchImpl?: (input: string | URL | Request, init?: RequestInit) => Promise<Response>
  now?: () => number
}

export interface HarnessBenchmarkTimelineEntry {
  atMs: number
  type: string
  label?: string
  name?: string
  status?: string
  detail?: string
}

export interface HarnessBenchmarkObservations {
  dynamicWorkerCompleted: boolean
  errors: Array<{ code?: string; message?: string }>
  eventCount: number
  finalStatus?: string
  finalText: string
  harnessEventLabels: string[]
  modelCompleted: boolean
  toolResults: Array<{ name?: string; status?: string }>
  toolUses: string[]
  workspacePersisted: boolean
  checkpointCreated: boolean
}

export interface HarnessBenchmarkScore {
  breakdown: Array<{
    id: string
    label: string
    earned: number
    max: number
    feedback: string[]
  }>
  feedback: string[]
  passed: boolean
  score: number
}

export interface HarnessBenchmarkCaseReport {
  caseId: string
  question: string
  httpStatus: number
  malformedFrames: number
  observations: HarnessBenchmarkObservations
  score: HarnessBenchmarkScore
  timeline: HarnessBenchmarkTimelineEntry[]
  timings: {
    firstEventMs?: number
    totalMs: number
  }
}

export interface HarnessBenchmarkReport {
  baseUrl: string
  cases: HarnessBenchmarkCaseReport[]
  generatedAt: string
  summary: {
    averageScore: number
    failed: number
    passed: number
    total: number
  }
}

export function parseHarnessSse(chunks: Iterable<string | Uint8Array>): {
  events: HarnessBenchmarkEvent[]
  malformedFrames: number
} {
  const decoder = new TextDecoder()
  let buffer = ''
  const events: HarnessBenchmarkEvent[] = []
  let malformedFrames = 0

  for (const chunk of chunks) {
    buffer += typeof chunk === 'string' ? chunk : decoder.decode(chunk, { stream: true })
    const consumed = consumeCompleteSseFrames(buffer, event => events.push(event))
    buffer = consumed.buffer
    malformedFrames += consumed.malformedFrames
  }
  buffer += decoder.decode()
  malformedFrames += consumeFinalSseFrame(buffer, event => events.push(event))

  return { events, malformedFrames }
}

export function scoreHarnessRun(run: {
  caseId: string
  events: HarnessBenchmarkEvent[]
  finalText: string
  httpStatus: number
  malformedFrames: number
  timings: { firstEventMs?: number; totalMs: number }
}, expectations: HarnessBenchmarkExpectations = {}): HarnessBenchmarkScore {
  const observations = observeHarnessRun(run.events, run.finalText)
  const requireDynamicWorker = expectations.requireDynamicWorker ?? true
  const breakdown: HarnessBenchmarkScore['breakdown'] = []
  const add = (id: string, label: string, max: number, earned: number, feedback: string[]) => {
    breakdown.push({ id, label, max, earned: Math.max(0, Math.min(max, earned)), feedback })
  }

  add('transport', 'HTTP/SSE transport', 10, run.httpStatus >= 200 && run.httpStatus < 300 && run.malformedFrames === 0 ? 10 : 0, [
    ...(run.httpStatus >= 200 && run.httpStatus < 300 ? [] : [`HTTP status was ${run.httpStatus}.`]),
    ...(run.malformedFrames === 0 ? [] : [`${run.malformedFrames} malformed SSE frame(s).`]),
  ])

  const lifecycleHits = [
    run.events.some(event => event.type === 'harness.started'),
    run.events.some(event => event.type === 'message.created'),
    run.events.some(event => event.type === 'run.done'),
  ].filter(Boolean).length
  add('lifecycle', 'Harness event lifecycle', 15, lifecycleHits * 5, lifecycleHits === 3 ? [] : [
    'Expected harness.started, message.created, and run.done events.',
  ])

  const workspaceHits = Number(observations.checkpointCreated) + Number(observations.workspacePersisted)
  add('workspace', 'Workspace persistence and checkpoint', 15, workspaceHits === 2 ? 15 : workspaceHits * 6, workspaceHits === 2 ? [] : [
    'Expected checkpoint.created and workspace.persisted harness events.',
  ])

  const dynamicWorkerUsed = observations.toolUses.includes('dynamic_worker_capsule')
  const dynamicWorkerCompleted = observations.dynamicWorkerCompleted
  add('dynamic_worker', 'Dynamic Worker capsule', 20, !requireDynamicWorker
    ? 20
    : dynamicWorkerUsed && dynamicWorkerCompleted
      ? 20
      : dynamicWorkerUsed
        ? 10
        : 0, !requireDynamicWorker || dynamicWorkerCompleted ? [] : [
    'Expected dynamic_worker_capsule tool.use and completed tool.result.',
  ])

  const modelUsed = observations.toolUses.some(name => /deepseek|model|openai/i.test(name))
  add('model', 'Model stream and result', 15, modelUsed && observations.modelCompleted && run.finalText.trim() ? 15 : modelUsed || run.finalText.trim() ? 8 : 0, modelUsed && observations.modelCompleted && run.finalText.trim() ? [] : [
    'Expected model tool events and non-empty text.delta output.',
  ])

  const expectationFeedback: string[] = []
  for (const text of expectations.requiredTextIncludes ?? []) {
    if (!run.finalText.includes(text)) expectationFeedback.push(`Final text did not include "${text}".`)
  }
  for (const text of expectations.forbiddenTextIncludes ?? []) {
    if (run.finalText.includes(text)) expectationFeedback.push(`Final text included forbidden text "${text}".`)
  }
  for (const label of expectations.requiredEventLabels ?? []) {
    if (!observations.harnessEventLabels.includes(label)) expectationFeedback.push(`Missing harness.event label "${label}".`)
  }
  for (const tool of expectations.requiredToolResults ?? []) {
    if (!observations.toolResults.some(result => result.name === tool && result.status === 'completed')) {
      expectationFeedback.push(`Missing completed tool.result for "${tool}".`)
    }
  }
  if (observations.errors.length > 0) {
    expectationFeedback.push(...observations.errors.map(error => `${error.code ?? 'error'}: ${error.message ?? ''}`.trim()))
  }
  if (observations.finalStatus && observations.finalStatus !== 'completed') {
    expectationFeedback.push(`Final run status was ${observations.finalStatus}.`)
  }
  add('expectations', 'Case expectations and errors', 15, expectationFeedback.length === 0 ? 15 : Math.max(0, 15 - expectationFeedback.length * 5), expectationFeedback)

  const latencyFeedback: string[] = []
  let latencyEarned = 10
  if (expectations.maxFirstEventMs !== undefined && (run.timings.firstEventMs === undefined || run.timings.firstEventMs > expectations.maxFirstEventMs)) {
    latencyEarned -= 5
    latencyFeedback.push(`First event latency ${run.timings.firstEventMs ?? 'n/a'}ms exceeded ${expectations.maxFirstEventMs}ms.`)
  }
  if (expectations.maxTotalMs !== undefined && run.timings.totalMs > expectations.maxTotalMs) {
    latencyEarned -= 5
    latencyFeedback.push(`Total latency ${run.timings.totalMs}ms exceeded ${expectations.maxTotalMs}ms.`)
  }
  add('latency', 'Latency budget', 10, latencyEarned, latencyFeedback)

  const score = Math.round(breakdown.reduce((sum, item) => sum + item.earned, 0))
  const feedback = breakdown.flatMap(item => item.feedback)
  const minScore = expectations.minScore ?? 80
  return {
    breakdown,
    feedback,
    passed: score >= minScore && feedback.length === 0,
    score,
  }
}

export async function runHarnessBenchmarkSuite(options: HarnessBenchmarkSuiteOptions): Promise<HarnessBenchmarkReport> {
  const fetchImpl = options.fetchImpl ?? ((input, init) => fetch(input, init))
  const now = options.now ?? (() => Date.now())
  const cases: HarnessBenchmarkCaseReport[] = []

  for (const benchmarkCase of options.cases) {
    cases.push(await runHarnessBenchmarkCase(benchmarkCase, {
      apiKey: options.apiKey,
      baseUrl: options.baseUrl,
      fetchImpl,
      now,
    }))
  }

  const totalScore = cases.reduce((sum, item) => sum + item.score.score, 0)
  const passed = cases.filter(item => item.score.passed).length
  return {
    baseUrl: options.baseUrl,
    cases,
    generatedAt: new Date().toISOString(),
    summary: {
      averageScore: cases.length ? Math.round(totalScore / cases.length) : 0,
      failed: cases.length - passed,
      passed,
      total: cases.length,
    },
  }
}

async function runHarnessBenchmarkCase(
  benchmarkCase: HarnessBenchmarkCase,
  options: {
    apiKey?: string
    baseUrl: string
    fetchImpl: (input: string | URL | Request, init?: RequestInit) => Promise<Response>
    now: () => number
  },
): Promise<HarnessBenchmarkCaseReport> {
  const startedAt = options.now()
  let response: Response
  try {
    response = await options.fetchImpl(`${options.baseUrl.replace(/\/$/, '')}/api/db-native-agent-harness/stream`, {
      method: 'POST',
      headers: {
        Accept: 'text/event-stream',
        'Content-Type': 'application/json',
        ...(options.apiKey ? { Authorization: `Bearer ${options.apiKey}` } : {}),
      },
      body: JSON.stringify({
        message: benchmarkCase.question,
        history: benchmarkCase.history,
        model: benchmarkCase.model,
        uiVariant: benchmarkCase.uiVariant,
        mentions: benchmarkCase.mentions ?? { agent: 'agent', cleanedMessage: benchmarkCase.question },
        attachments: benchmarkCase.attachments,
        metadata: {
          ...benchmarkCase.metadata,
          benchmark: {
            caseId: benchmarkCase.id,
          },
        },
      }),
    })
  } catch (err) {
    const totalMs = options.now() - startedAt
    const message = err instanceof Error ? err.message : String(err)
    const events: HarnessBenchmarkEvent[] = [
      { type: 'error', code: 'network_error', message },
      { type: 'run.done', status: 'failed', messageId: `benchmark_${benchmarkCase.id}` },
    ]
    const score = scoreHarnessRun({
      caseId: benchmarkCase.id,
      events,
      finalText: message,
      httpStatus: 0,
      malformedFrames: 0,
      timings: { totalMs },
    }, benchmarkCase.expect)
    return {
      caseId: benchmarkCase.id,
      question: benchmarkCase.question,
      httpStatus: 0,
      malformedFrames: 0,
      observations: observeHarnessRun(events, message),
      score,
      timeline: events.map(event => toTimelineEntry(event, totalMs)),
      timings: { totalMs },
    }
  }

  const stream = response.body
  const events: HarnessBenchmarkEvent[] = []
  const timeline: HarnessBenchmarkTimelineEntry[] = []
  let malformedFrames = 0
  let firstEventMs: number | undefined
  if (stream) {
    const result = await readEventStream(stream, now => {
      const atMs = now - startedAt
      if (firstEventMs === undefined) firstEventMs = atMs
      return atMs
    }, options.now)
    events.push(...result.events)
    timeline.push(...result.timeline)
    malformedFrames = result.malformedFrames
  }

  const totalMs = options.now() - startedAt
  const finalText = events
    .filter(event => event.type === 'text.delta' && typeof event.text === 'string')
    .map(event => event.text as string)
    .join('')
  const score = scoreHarnessRun({
    caseId: benchmarkCase.id,
    events,
    finalText,
    httpStatus: response.status,
    malformedFrames,
    timings: { firstEventMs, totalMs },
  }, benchmarkCase.expect)

  return {
    caseId: benchmarkCase.id,
    question: benchmarkCase.question,
    httpStatus: response.status,
    malformedFrames,
    observations: observeHarnessRun(events, finalText),
    score,
    timeline,
    timings: { firstEventMs, totalMs },
  }
}

async function readEventStream(
  stream: ReadableStream<Uint8Array>,
  relativeTime: (now: number) => number,
  now: () => number,
): Promise<{
  events: HarnessBenchmarkEvent[]
  malformedFrames: number
  timeline: HarnessBenchmarkTimelineEntry[]
}> {
  const reader = stream.getReader()
  const decoder = new TextDecoder()
  let buffer = ''
  let malformedFrames = 0
  const events: HarnessBenchmarkEvent[] = []
  const timeline: HarnessBenchmarkTimelineEntry[] = []

  while (true) {
    const { done, value } = await reader.read()
    if (value) buffer += decoder.decode(value, { stream: !done })
    let boundary = buffer.indexOf('\n\n')
    while (boundary !== -1) {
      const frame = buffer.slice(0, boundary)
      buffer = buffer.slice(boundary + 2)
      const event = parseSseFrame(frame)
      if (event === 'malformed') malformedFrames += 1
      else if (event) {
        events.push(event)
        timeline.push(toTimelineEntry(event, relativeTime(now())))
      }
      boundary = buffer.indexOf('\n\n')
    }
    if (done) {
      buffer += decoder.decode()
      malformedFrames += consumeFinalSseFrame(buffer, event => {
        events.push(event)
        timeline.push(toTimelineEntry(event, relativeTime(now())))
      })
      break
    }
  }

  return { events, malformedFrames, timeline }
}

function consumeCompleteSseFrames(buffer: string, onEvent: (event: HarnessBenchmarkEvent) => void): {
  buffer: string
  malformedFrames: number
} {
  let malformedFrames = 0
  let boundary = buffer.indexOf('\n\n')
  while (boundary !== -1) {
    const frame = buffer.slice(0, boundary)
    buffer = buffer.slice(boundary + 2)
    const event = parseSseFrame(frame)
    if (event === 'malformed') malformedFrames += 1
    else if (event) onEvent(event)
    boundary = buffer.indexOf('\n\n')
  }
  return { buffer, malformedFrames }
}

function consumeFinalSseFrame(buffer: string, onEvent: (event: HarnessBenchmarkEvent) => void): number {
  if (!buffer.trim()) return 0
  const event = parseSseFrame(buffer)
  if (event === 'malformed') return 1
  if (event) onEvent(event)
  return 0
}

function parseSseFrame(frame: string): HarnessBenchmarkEvent | 'malformed' | undefined {
  const data = frame
    .split('\n')
    .filter(line => line.startsWith('data:'))
    .map(line => line.slice(5).trimStart())
    .join('\n')
  if (!data) return undefined
  try {
    const parsed = JSON.parse(data) as HarnessBenchmarkEvent
    return typeof parsed.type === 'string' ? parsed : 'malformed'
  } catch {
    return 'malformed'
  }
}

function observeHarnessRun(events: HarnessBenchmarkEvent[], finalText: string): HarnessBenchmarkObservations {
  const harnessEventLabels = events
    .filter(event => event.type === 'harness.event' && typeof event.label === 'string')
    .map(event => event.label as string)
  const toolResults = events
    .filter(event => event.type === 'tool.result')
    .map(event => ({ name: typeof event.name === 'string' ? event.name : undefined, status: typeof event.status === 'string' ? event.status : undefined }))
  const toolUses = events
    .filter(event => event.type === 'tool.use' && typeof event.name === 'string')
    .map(event => event.name as string)
  const runDone = findLast(events, event => event.type === 'run.done')
  return {
    checkpointCreated: harnessEventLabels.includes('checkpoint.created'),
    dynamicWorkerCompleted: toolResults.some(result => result.name === 'dynamic_worker_capsule' && result.status === 'completed'),
    errors: events
      .filter(event => event.type === 'error')
      .map(event => ({
        code: typeof event.code === 'string' ? event.code : undefined,
        message: typeof event.message === 'string' ? event.message : undefined,
      })),
    eventCount: events.length,
    finalStatus: typeof runDone?.status === 'string' ? runDone.status : undefined,
    finalText,
    harnessEventLabels,
    modelCompleted: toolResults.some(result => result.status === 'completed' && result.name !== 'dynamic_worker_capsule'),
    toolResults,
    toolUses,
    workspacePersisted: harnessEventLabels.includes('workspace.persisted'),
  }
}

function findLast<T>(items: T[], predicate: (item: T) => boolean): T | undefined {
  for (let index = items.length - 1; index >= 0; index -= 1) {
    const item = items[index]
    if (item !== undefined && predicate(item)) return item
  }
  return undefined
}

function toTimelineEntry(event: HarnessBenchmarkEvent, atMs: number): HarnessBenchmarkTimelineEntry {
  return {
    atMs,
    type: event.type,
    label: typeof event.label === 'string' ? event.label : undefined,
    name: typeof event.name === 'string' ? event.name : undefined,
    status: typeof event.status === 'string' ? event.status : undefined,
    detail: typeof event.detail === 'string' ? event.detail : undefined,
  }
}
