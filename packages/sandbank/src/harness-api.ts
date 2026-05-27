import { Db9WorkspaceAdapter } from '@sandbank.dev/db9'
import type { WorkspaceAdapter } from '@sandbank.dev/workspace'
import { AgentSupervisor } from './agent-supervisor.js'

export interface DbNativeAgentHarnessEnv {
  CHATW_DEEPSEEK_API_KEY?: string
  CHATW_DEEPSEEK_BASE_URL?: string
  CHATW_DEEPSEEK_MODEL?: string
  CHATW_DEEPSEEK_USE_OPENAI_ENV?: string
  DB9_BASE_URL?: string
  DB9_DATABASE_ID?: string
  DB9_TOKEN?: string
  DEEPSEEK_API_KEY?: string
  DEEPSEEK_BASE_URL?: string
  DEEPSEEK_MODEL?: string
  OPENAI_API_KEY?: string
  OPENAI_BASE_URL?: string
  SANDBANK_HARNESS_API_KEY?: string
  CHATW_HARNESS_API_KEY?: string
}

export interface DbNativeAgentHarnessDeps {
  createWorkspace?: (env: DbNativeAgentHarnessEnv) => Promise<WorkspaceAdapter>
  fetchImpl?: (input: string | URL | Request, init?: RequestInit) => Promise<Response>
  id?: () => string
  now?: () => Date
}

export interface DbNativeAgentHarnessServerOptions extends DbNativeAgentHarnessDeps {
  host?: string
  port?: number
}

interface ChatWWorkerInput {
  message?: string
  history?: Array<{ role?: string; content?: string }>
  model?: { id?: string; label?: string; provider?: string; model?: string }
  uiVariant?: { id?: string; label?: string }
  mentions?: { cleanedMessage?: string; agent?: string }
  attachments?: Array<{ name?: string; mediaType?: string; size?: number }>
  metadata?: Record<string, unknown>
}

type ChatWEvent = Record<string, unknown>

interface OpenAIMessage {
  role: 'system' | 'user' | 'assistant'
  content: string
}

const DEFAULT_DEEPSEEK_BASE_URL = 'https://api.deepseek.com'
const DEFAULT_DEEPSEEK_MODEL = 'deepseek-v4-pro'

export function createDbNativeAgentHarnessHandler(
  env: DbNativeAgentHarnessEnv = {},
  deps: DbNativeAgentHarnessDeps = {},
) {
  return {
    async fetch(request: Request): Promise<Response> {
      const url = new URL(request.url)

      if (request.method === 'OPTIONS') return emptyCors()
      if (request.method === 'GET' && url.pathname.endsWith('/health')) {
        return json({
          ok: true,
          service: 'sandbank-db-native-agent-harness',
          workspace: env.DB9_DATABASE_ID ? 'db9' : 'unconfigured',
          model: resolveModel(env),
          supervisor: true,
        })
      }

      if (request.method === 'GET' && url.pathname.endsWith('/api/db-native-agent-harness/capabilities')) {
        return json(describeHarnessCapabilities(env))
      }

      if (
        request.method === 'POST'
        && (url.pathname.endsWith('/api/db-native-agent-harness/stream') || url.pathname.endsWith('/api/chatw/stream'))
      ) {
        const auth = authorizeHarnessRequest(request, env)
        if (auth) return auth
        return streamHarness(request, env, deps)
      }

      return json({ error: 'not_found' }, 404)
    },
  }
}

async function streamHarness(
  request: Request,
  env: DbNativeAgentHarnessEnv,
  deps: DbNativeAgentHarnessDeps,
): Promise<Response> {
  const input = await request.json().catch(() => ({})) as ChatWWorkerInput
  const encoder = new TextEncoder()
  const { readable, writable } = new TransformStream<Uint8Array>()
  const writer = writable.getWriter()
  const send = (event: ChatWEvent) => writer.write(encoder.encode(`data: ${JSON.stringify(event)}\n\n`))

  void (async () => {
    try {
      await runHarness(input, env, deps, send)
    } finally {
      await writer.close()
    }
  })()

  return new Response(readable, {
    headers: corsHeaders({
      'Cache-Control': 'no-cache, no-transform',
      'Content-Type': 'text/event-stream; charset=utf-8',
      'X-Accel-Buffering': 'no',
    }),
  })
}

async function runHarness(
  input: ChatWWorkerInput,
  env: DbNativeAgentHarnessEnv,
  deps: DbNativeAgentHarnessDeps,
  send: (event: ChatWEvent) => Promise<unknown>,
): Promise<void> {
  const now = deps.now ?? (() => new Date())
  const runId = deps.id?.() ?? createId('run')
  const harnessId = `dbnative_${runId}`
  const assistantId = `msg_${runId}`
  const model = resolveModel(env)
  const createdAt = now().toISOString()
  let assistantText = ''

  await send({
    type: 'harness.started',
    harnessId,
    title: 'DB-native Sandbank harness',
    provider: 'custom',
  })
  await send({
    type: 'message.created',
    message: {
      id: assistantId,
      role: 'assistant',
      content: '',
      modelId: input.model?.id ?? 'codex',
      uiVariantId: input.uiVariant?.id ?? 'terminal',
      createdAt,
      metadata: { provider: 'sandbank-db-native', runId, workspace: 'db9' },
    },
  })

  try {
    const workspace = await resolveWorkspace(env, deps)
    const supervisor = new AgentSupervisor({
      agentId: input.mentions?.agent ?? 'chatw-agent',
      workspace,
      modelId: model,
      id: () => runId,
      now,
      policy: {
        allowedOps: [
          'workspace.read',
          'workspace.write',
          'workspace.append',
          'workspace.query',
          ...(workspace.capabilities.functionRuntime ? ['function.invoke' as const] : []),
        ],
        writablePaths: ['/agents', '/runs', '/messages', '/workspace', '/.sandbank'],
        readablePaths: ['/agents', '/runs', '/messages', '/workspace', '/.sandbank'],
        query: workspace.capabilities.sqlQuery ? 'all' : 'none',
      },
    })
    const toolCallId = `tool_${runId}`
    const run = await supervisor.run({
      input: sanitizeInput(input),
      publicRunRoot: `/runs/${runId}`,
      onEvent: async event => {
        await send({
          type: 'harness.event',
          harnessId,
          label: event.label,
          detail: event.detail,
        })
      },
      modelLoop: async context => {
        await context.emit({
          type: 'state',
          label: 'workspace.persisted',
          detail: `db9 workspace wrote /runs/${runId}/request.json`,
        })
        await send({
          type: 'tool.use',
          toolCallId,
          name: 'deepseek_v4_pro',
          input: {
            model,
            workspace: workspace.id,
            runId,
            supervisor: context.run.agentId,
            allowedOps: context.allowedOps,
          },
        })

        const apiKey = resolveApiKey(env)
        if (!apiKey) {
          throw new PublicHarnessError('missing_deepseek_api_key', 'DeepSeek V4 Pro API key is not configured for the harness.')
        }

        const response = await callDeepSeek(input, env, {
          apiKey,
          model,
          fetchImpl: deps.fetchImpl ?? fetch,
          runId,
          workspace,
        })
        assistantText = await streamOpenAIChunks(response, async (text) => {
          assistantText += text
          await send({ type: 'text.delta', messageId: assistantId, text })
        })

        if (!assistantText) {
          assistantText = 'DeepSeek V4 Pro returned an empty streamed response.'
          await send({ type: 'text.delta', messageId: assistantId, text: assistantText })
        }

        return {
          text: assistantText,
          metadata: { model, workspace: workspace.id },
        }
      },
    })
    await send({
      type: 'tool.result',
      toolCallId,
      name: 'deepseek_v4_pro',
      status: 'completed',
      result: {
        model,
        workspace: workspace.id,
        runId,
        supervisor: run.run.agentId,
        checkpoint: run.checkpoint?.ref,
      },
    })
    await send({ type: 'run.done', messageId: assistantId, status: 'completed', metadata: { runId, model, supervisor: run.run.agentId } })
  } catch (err) {
    const error = toPublicHarnessError(err)
    await send({ type: 'error', code: error.code, message: error.message })
    await send({ type: 'text.delta', messageId: assistantId, text: error.message })
    await send({ type: 'run.done', messageId: assistantId, status: 'failed', metadata: { runId, code: error.code } })
  }
}

async function resolveWorkspace(
  env: DbNativeAgentHarnessEnv,
  deps: DbNativeAgentHarnessDeps,
): Promise<WorkspaceAdapter> {
  if (deps.createWorkspace) return deps.createWorkspace(env)
  if (!env.DB9_DATABASE_ID || !env.DB9_TOKEN) {
    throw new PublicHarnessError(
      'missing_db9_configuration',
      'DB9_DATABASE_ID and DB9_TOKEN are required to run the DB-native harness API.',
    )
  }
  return new Db9WorkspaceAdapter({
    dbId: env.DB9_DATABASE_ID,
    token: env.DB9_TOKEN,
    baseUrl: env.DB9_BASE_URL,
  })
}

async function callDeepSeek(
  input: ChatWWorkerInput,
  env: DbNativeAgentHarnessEnv,
  options: {
    apiKey: string
    fetchImpl: (input: string | URL | Request, init?: RequestInit) => Promise<Response>
    model: string
    runId: string
    workspace: WorkspaceAdapter
  },
): Promise<ReadableStream<Uint8Array>> {
  const response = await options.fetchImpl(`${resolveBaseUrl(env).replace(/\/$/, '')}/chat/completions`, {
    method: 'POST',
    headers: {
      Authorization: `Bearer ${options.apiKey}`,
      'Content-Type': 'application/json',
    },
    body: JSON.stringify({
      model: options.model,
      messages: buildMessages(input, options.runId, options.workspace),
      temperature: 0.25,
      max_tokens: 1400,
      stream: true,
    }),
  })

  if (!response.ok) {
    throw new PublicHarnessError('deepseek_http_error', `DeepSeek V4 Pro request failed with HTTP ${response.status}.`)
  }
  if (!response.body) {
    throw new PublicHarnessError('missing_deepseek_stream', 'DeepSeek V4 Pro did not return a response stream.')
  }
  return response.body
}

function buildMessages(input: ChatWWorkerInput, runId: string, workspace: WorkspaceAdapter): OpenAIMessage[] {
  const prompt = input.mentions?.cleanedMessage?.trim() || input.message?.trim() || 'Use the DB-native harness.'
  const history = (input.history ?? [])
    .filter(item => item.content && (item.role === 'user' || item.role === 'assistant'))
    .slice(-8)
  const attachments = input.attachments?.length
    ? `\n\nAttachments:\n${input.attachments.map(asset => `- ${asset.name ?? 'untitled'} (${asset.mediaType ?? 'application/octet-stream'}, ${asset.size ?? 0} bytes)`).join('\n')}`
    : ''

  const messages: OpenAIMessage[] = [{
    role: 'system',
    content: [
      'You are the DB-native agent harness for Sandbank.',
      'The durable workspace is db9, exposed through the Sandbank Workspace protocol rather than a VM-local filesystem.',
      `Current run id: ${runId}. Workspace adapter: ${workspace.kind}.`,
      'Explain visible harness behavior in concrete terms: persisted run files, model/tool events, and db-backed agent state.',
      'Return only the final user-facing answer; do not include analysis, hidden reasoning, or planning text.',
      'Keep the answer concise and do not claim shell execution happened.',
    ].join(' '),
  }]

  if (history.length) {
    for (const [index, item] of history.entries()) {
      const isLastUserTurn = index === history.length - 1 && item.role === 'user'
      messages.push({
        role: item.role === 'assistant' ? 'assistant' : 'user',
        content: isLastUserTurn ? `${prompt}${attachments}` : item.content!,
      })
    }
  } else {
    messages.push({ role: 'user', content: `${prompt}${attachments}` })
  }

  return messages
}

async function streamOpenAIChunks(
  stream: ReadableStream<Uint8Array>,
  onText: (text: string) => Promise<void>,
): Promise<string> {
  const reader = stream.getReader()
  const decoder = new TextDecoder()
  let buffer = ''
  let fullText = ''

  while (true) {
    const { done, value } = await reader.read()
    if (value) buffer += decoder.decode(value, { stream: !done }).replace(/\r\n/g, '\n')

    let boundary = buffer.indexOf('\n\n')
    while (boundary !== -1) {
      const block = buffer.slice(0, boundary)
      buffer = buffer.slice(boundary + 2)
      const data = parseOpenAIData(block)
      if (data === '[DONE]') return fullText
      if (data) {
        const text = extractOpenAIText(data)
        if (text) {
          fullText += text
          await onText(text)
        }
      }
      boundary = buffer.indexOf('\n\n')
    }

    if (done) return fullText
  }
}

function parseOpenAIData(block: string): Record<string, unknown> | '[DONE]' | undefined {
  const data = block
    .split('\n')
    .filter(line => line.startsWith('data:'))
    .map(line => line.slice(5).trimStart())
    .join('\n')

  if (!data) return undefined
  if (data === '[DONE]') return data
  try {
    return JSON.parse(data) as Record<string, unknown>
  } catch {
    return undefined
  }
}

function extractOpenAIText(data: Record<string, unknown>): string {
  const choices = data['choices']
  if (!Array.isArray(choices)) return ''
  const first = choices[0] as { delta?: { content?: unknown } } | undefined
  const content = first?.delta?.content
  return typeof content === 'string' ? content : ''
}

function sanitizeInput(input: ChatWWorkerInput): ChatWWorkerInput {
  return {
    message: input.message,
    history: input.history,
    model: input.model,
    uiVariant: input.uiVariant,
    mentions: input.mentions,
    attachments: input.attachments,
    metadata: input.metadata,
  }
}

function describeHarnessCapabilities(env: DbNativeAgentHarnessEnv) {
  const authRequired = Boolean(resolveHarnessApiKey(env))
  return {
    service: 'sandbank-db-native-agent-harness',
    api: {
      routes: [
        'GET /health',
        'GET /api/db-native-agent-harness/capabilities',
        'POST /api/db-native-agent-harness/stream',
        'POST /api/chatw/stream',
      ],
      auth: authRequired ? 'bearer' : 'none',
      sse: true,
    },
    supervisor: {
      runState: true,
      policyChecks: true,
      auditLog: true,
      checkpointHook: true,
    },
    workspace: {
      backend: env.DB9_DATABASE_ID ? 'db9' : 'unconfigured',
      protocol: '@sandbank.dev/workspace',
      requiredEnv: ['DB9_DATABASE_ID', 'DB9_TOKEN'],
    },
    model: {
      provider: 'deepseek-compatible',
      default: DEFAULT_DEEPSEEK_MODEL,
      active: resolveModel(env),
    },
    deployment: {
      nodeCli: 'sandbank harness-api',
      workerEntrypoint: 'sandbank/harness-worker',
      vasService: 'vas dev <service> pnpm --filter ./packages/sandbank exec tsx src/cli/index.ts harness-api --host 0.0.0.0',
    },
  }
}

function resolveModel(env: DbNativeAgentHarnessEnv): string {
  return env.CHATW_DEEPSEEK_MODEL || env.DEEPSEEK_MODEL || DEFAULT_DEEPSEEK_MODEL
}

function resolveBaseUrl(env: DbNativeAgentHarnessEnv): string {
  return env.CHATW_DEEPSEEK_BASE_URL
    || env.DEEPSEEK_BASE_URL
    || (canUseOpenAIEnvForDeepSeek(env) ? env.OPENAI_BASE_URL : undefined)
    || DEFAULT_DEEPSEEK_BASE_URL
}

function resolveApiKey(env: DbNativeAgentHarnessEnv): string | undefined {
  return env.CHATW_DEEPSEEK_API_KEY
    || env.DEEPSEEK_API_KEY
    || (canUseOpenAIEnvForDeepSeek(env) ? env.OPENAI_API_KEY : undefined)
}

function resolveHarnessApiKey(env: DbNativeAgentHarnessEnv): string | undefined {
  return env.SANDBANK_HARNESS_API_KEY || env.CHATW_HARNESS_API_KEY
}

function authorizeHarnessRequest(request: Request, env: DbNativeAgentHarnessEnv): Response | undefined {
  const token = resolveHarnessApiKey(env)
  if (!token) return undefined
  const header = request.headers.get('authorization') ?? ''
  if (header === `Bearer ${token}`) return undefined
  return json({ error: 'unauthorized' }, 401)
}

function canUseOpenAIEnvForDeepSeek(env: DbNativeAgentHarnessEnv): boolean {
  if (env.CHATW_DEEPSEEK_USE_OPENAI_ENV === '1') return true
  return /deepseek|openrouter|gateway\/deepseek/i.test(env.OPENAI_BASE_URL ?? '')
}

class PublicHarnessError extends Error {
  constructor(
    public readonly code: string,
    message: string,
  ) {
    super(message)
  }
}

function toPublicHarnessError(err: unknown): PublicHarnessError {
  if (err instanceof PublicHarnessError) return err
  return new PublicHarnessError('harness_error', err instanceof Error ? err.message : 'DB-native harness request failed.')
}

function createId(prefix: string): string {
  return `${prefix}_${Date.now().toString(36)}_${Math.random().toString(36).slice(2, 8)}`
}

function json(body: unknown, status = 200): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: corsHeaders({ 'Content-Type': 'application/json; charset=utf-8' }),
  })
}

function emptyCors(): Response {
  return new Response(null, { status: 204, headers: corsHeaders() })
}

function corsHeaders(init: HeadersInit = {}): Headers {
  const headers = new Headers(init)
  headers.set('Access-Control-Allow-Origin', '*')
  headers.set('Access-Control-Allow-Headers', 'content-type, authorization')
  headers.set('Access-Control-Allow-Methods', 'GET, POST, OPTIONS')
  return headers
}
