import { afterEach, describe, expect, it, vi } from 'vitest'
import { MemoryWorkspaceAdapter, type WorkspaceAdapter } from '@sandbank.dev/workspace'
import { AgentMemoryStore } from './agent-memory.js'
import { createDbNativeAgentHarnessHandler } from './harness-api.js'
import { startDbNativeAgentHarnessServer } from './harness-node.js'
import harnessWorker from './harness-worker.js'
import { ToolUseRegistry, createCloudflareResourceTool } from './tool-use.js'

afterEach(() => {
  vi.unstubAllGlobals()
})

describe('createDbNativeAgentHarnessHandler', () => {
  it('streams chatw events while persisting a db-native run in the workspace', async () => {
    const workspace = new MemoryWorkspaceAdapter(undefined, { id: 'db9:test' })
    const fetchImpl = vi.fn(async (_url: string | URL | Request, _init?: RequestInit) => {
      const encoder = new TextEncoder()
      return new Response(new ReadableStream({
        start(controller) {
          controller.enqueue(encoder.encode('data: {"choices":[{"delta":{"content":"hello"}}]}\n\n'))
          controller.enqueue(encoder.encode('data: {"choices":[{"delta":{"content":" from db9"}}]}\n\n'))
          controller.enqueue(encoder.encode('data: [DONE]\n\n'))
          controller.close()
        },
      }), {
        headers: { 'Content-Type': 'text/event-stream' },
      })
    })
    const handler = createDbNativeAgentHarnessHandler({
      DB9_DATABASE_ID: 'db-test',
      DEEPSEEK_API_KEY: 'deepseek-key',
    }, {
      createWorkspace: async () => workspace,
      fetchImpl,
      now: () => new Date('2026-05-27T00:00:00.000Z'),
      id: () => 'run_1',
    })

    const response = await handler.fetch(new Request('https://sandbank.dev/api/db-native-agent-harness/stream', {
      method: 'POST',
      body: JSON.stringify({
        message: '@codex draft a db-native harness run',
        history: [{ role: 'user', content: '@codex draft a db-native harness run' }],
        model: { id: 'codex', label: 'Codex Harness', provider: 'sandbank', model: 'codex-cli' },
        uiVariant: { id: 'terminal', label: 'Terminal' },
        mentions: { cleanedMessage: 'draft a db-native harness run', agent: 'codex' },
      }),
    }))

    const body = await response.text()
    const requestBody = JSON.parse(String(fetchImpl.mock.calls[0]?.[1]?.body)) as { model: string; messages: Array<{ content: string }> }
    const entries = await workspace.list('/runs/run_1', { recursive: true })

    expect(response.headers.get('content-type')).toContain('text/event-stream')
    expect(body).toContain('"type":"harness.started"')
    expect(body).toContain('"provider":"custom"')
    expect(body).toContain('"type":"text.delta"')
    expect(body).toContain('"text":"hello"')
    expect(body).toContain('"text":" from db9"')
    expect(requestBody.model).toBe('deepseek-v4-pro')
    expect(requestBody.messages[0]?.content).toContain('DB-native agent harness')
    expect(entries.map(entry => entry.path)).toEqual(expect.arrayContaining([
      '/runs/run_1/request.json',
      '/runs/run_1/assistant.md',
    ]))
    await expect(workspace.read('/runs/run_1/assistant.md')).resolves.toBe('hello from db9')
    await expect(workspace.read('/runs/index.jsonl')).resolves.toContain('run_1')
  })

  it('recalls persistent agent memories into the model prompt and records new run memories', async () => {
    const workspace = new MemoryWorkspaceAdapter(undefined, { id: 'db9:test' })
    const seedMemory = new AgentMemoryStore({
      agentId: 'codex',
      workspace,
      id: () => 'mem_seed',
      now: () => new Date('2026-05-26T00:00:00.000Z'),
    })
    await seedMemory.createMemory({
      content: 'Prefer Cloudflare Dynamic Workers for production harness rollouts.',
      memoryType: 'pinned',
      tags: ['deployment'],
    })
    const fetchImpl = vi.fn(async (_url: string | URL | Request, _init?: RequestInit) => {
      const encoder = new TextEncoder()
      return new Response(new ReadableStream({
        start(controller) {
          controller.enqueue(encoder.encode('data: {"choices":[{"delta":{"content":"memory aware answer"}}]}\n\n'))
          controller.enqueue(encoder.encode('data: [DONE]\n\n'))
          controller.close()
        },
      }), {
        headers: { 'Content-Type': 'text/event-stream' },
      })
    })
    const handler = createDbNativeAgentHarnessHandler({
      DB9_DATABASE_ID: 'db-test',
      DEEPSEEK_API_KEY: 'deepseek-key',
    }, {
      createWorkspace: async () => workspace,
      fetchImpl,
      now: () => new Date('2026-05-27T00:00:00.000Z'),
      id: () => 'run_mem',
    })

    const response = await handler.fetch(new Request('https://sandbank.dev/api/db-native-agent-harness/stream', {
      method: 'POST',
      body: JSON.stringify({
        message: '@codex please remember that staging uses db9 fs9. How should we deploy the harness?',
        mentions: {
          cleanedMessage: 'please remember that staging uses db9 fs9. How should we deploy the harness?',
          agent: 'codex',
        },
      }),
    }))

    const body = await response.text()
    const requestBody = JSON.parse(String(fetchImpl.mock.calls[0]?.[1]?.body)) as { messages: Array<{ content: string }> }
    const memoryLog = await workspace.read('/agents/codex/memory/memories.jsonl')

    expect(requestBody.messages[0]?.content).toContain('<relevant-memories>')
    expect(requestBody.messages[0]?.content).toContain('Prefer Cloudflare Dynamic Workers for production harness rollouts.')
    expect(body).toContain('memory.recalled')
    expect(String(memoryLog)).toContain('"memory_type":"session"')
    expect(String(memoryLog)).toContain('"memory_type":"pinned"')
    expect(String(memoryLog)).toContain('staging uses db9 fs9')
  })

  it('invokes a configured Dynamic Worker capsule for the run and forwards its events', async () => {
    const workspace = new MemoryWorkspaceAdapter(undefined, { id: 'db9:test' })
    const fetchImpl = vi.fn(async (_input: string | URL | Request, _init?: RequestInit) => {
      const encoder = new TextEncoder()
      return new Response(new ReadableStream({
        start(controller) {
          controller.enqueue(encoder.encode('data: {"choices":[{"delta":{"content":"model answer"}}]}\n\n'))
          controller.enqueue(encoder.encode('data: [DONE]\n\n'))
          controller.close()
        },
      }), {
        headers: { 'Content-Type': 'text/event-stream' },
      })
    })
    let capsulePayload: Record<string, unknown> | undefined
    const invokeCapsule = vi.fn(async (options: {
      request: Request
      workspace: WorkspaceAdapter
      workspaceScope: unknown
      code: string
      id?: string
      timeoutMs?: number
      limits?: { cpuMs?: number; subRequests?: number }
      onEvent?: (event: { type: 'stream.chunk'; text: string } | { type: 'log'; level: 'info'; message: string; metadata?: Record<string, unknown> } | { type: 'artifact'; name: string; path: string; mediaType?: string; size?: number }) => Promise<void> | void
    }) => {
      capsulePayload = await options.request.json() as Record<string, unknown>
      await options.workspace.write('/workspace/from-capsule.txt', 'capsule wrote this')
      await options.onEvent?.({ type: 'log', level: 'info', message: 'capsule booted', metadata: { runId: capsulePayload.runId } })
      await options.onEvent?.({ type: 'stream.chunk', text: 'capsule streamed' })
      await options.onEvent?.({ type: 'artifact', name: 'capsule.txt', path: '/artifacts/run_dw/capsule.txt', mediaType: 'text/plain', size: 7 })
      return { status: 200, headers: {}, body: 'capsule-complete' }
    })
    const handler = createDbNativeAgentHarnessHandler({
      DB9_DATABASE_ID: 'db-test',
      DEEPSEEK_API_KEY: 'deepseek-key',
      SANDBANK_DYNAMIC_WORKER_TIMEOUT_MS: '5000',
      SANDBANK_DYNAMIC_WORKER_CPU_MS: '50',
      SANDBANK_DYNAMIC_WORKER_SUBREQUESTS: '6',
    }, {
      createWorkspace: async () => workspace,
      fetchImpl,
      now: () => new Date('2026-05-27T00:00:00.000Z'),
      id: () => 'run_dw',
      createExecutionCapsule: () => ({ invoke: invokeCapsule }),
    })

    const response = await handler.fetch(new Request('https://sandbank.dev/api/db-native-agent-harness/stream', {
      method: 'POST',
      body: JSON.stringify({
        message: '@codex use the dynamic worker capsule',
        mentions: { cleanedMessage: 'use the dynamic worker capsule', agent: 'codex' },
      }),
    }))
    const body = await response.text()

    expect(invokeCapsule).toHaveBeenCalledTimes(1)
    expect(invokeCapsule.mock.calls[0]?.[0]).toMatchObject({
      timeoutMs: 5000,
      limits: { cpuMs: 50, subRequests: 6 },
      workspace,
    })
    expect(capsulePayload).toMatchObject({ runId: 'run_dw', agentId: 'codex', workspaceId: 'db9:test' })
    expect(body).toContain('"name":"dynamic_worker_capsule"')
    expect(body).toContain('dynamic-worker.log')
    expect(body).toContain('capsule booted')
    expect(body).toContain('dynamic-worker.stream')
    expect(body).toContain('capsule-complete')
    expect(body).toContain('"text":"model answer"')
    await expect(workspace.read('/workspace/from-capsule.txt')).resolves.toBe('capsule wrote this')
  })

  it('exposes configured Tool Use to Dynamic Worker capsules through the supervisor policy', async () => {
    const workspace = new MemoryWorkspaceAdapter(undefined, { id: 'db9:test' })
    const toolHandler = vi.fn(async input => ({ ok: true, input }))
    const registry = new ToolUseRegistry()
      .register(createCloudflareResourceTool('read', toolHandler))
    const fetchImpl = vi.fn(async (_input: string | URL | Request, _init?: RequestInit) => {
      const encoder = new TextEncoder()
      return new Response(new ReadableStream({
        start(controller) {
          controller.enqueue(encoder.encode('data: {"choices":[{"delta":{"content":"model answer"}}]}\n\n'))
          controller.enqueue(encoder.encode('data: [DONE]\n\n'))
          controller.close()
        },
      }))
    })
    let capsuleToolList: unknown
    let capsuleToolResult: unknown
    const invokeCapsule = vi.fn(async (options: {
      tools?: {
        list(): Promise<Array<{ name: string; description?: string }>>
        use(request: { tool: string; input?: unknown; reason?: string; metadata?: Record<string, unknown> }): Promise<unknown>
      }
      onEvent?: (event: { type: 'log'; level: 'info'; message: string }) => Promise<void> | void
    }) => {
      capsuleToolList = await options.tools?.list()
      capsuleToolResult = await options.tools?.use({
        tool: 'cloudflare.resource.read',
        input: {
          resource: { kind: 'cloudflare.d1', id: 'analytics' },
          operation: 'select',
        },
        reason: 'capsule needs readonly analytics context',
      })
      await options.onEvent?.({ type: 'log', level: 'info', message: 'tool use completed' })
      return { status: 200, headers: {}, body: 'capsule-complete' }
    })
    const handler = createDbNativeAgentHarnessHandler({
      DB9_DATABASE_ID: 'db-test',
      DEEPSEEK_API_KEY: 'deepseek-key',
    }, {
      createWorkspace: async () => workspace,
      createToolUse: async () => ({
        registry,
        policy: {
          allowedTools: ['cloudflare.resource.read'],
          resources: [
            { kind: 'cloudflare.d1', id: 'analytics', actions: ['read'] },
          ],
        },
      }),
      createExecutionCapsule: () => ({ invoke: invokeCapsule }),
      fetchImpl,
      now: () => new Date('2026-06-03T00:00:00.000Z'),
      id: () => 'run_dw_tools',
    })

    const response = await handler.fetch(new Request('https://sandbank.dev/api/db-native-agent-harness/stream', {
      method: 'POST',
      body: JSON.stringify({
        message: '@codex run a capsule tool',
        mentions: { cleanedMessage: 'run a capsule tool', agent: 'codex' },
      }),
    }))
    const body = await response.text()

    expect(capsuleToolList).toEqual(expect.arrayContaining([
      expect.objectContaining({ name: 'cloudflare.resource.read' }),
    ]))
    expect(capsuleToolResult).toMatchObject({ ok: true })
    expect(toolHandler).toHaveBeenCalledTimes(1)
    expect(body).toContain('tool use completed')
    expect(body).toContain('"text":"model answer"')
  })

  it('reports missing db9 configuration as a chatw error event', async () => {
    const handler = createDbNativeAgentHarnessHandler({
      DEEPSEEK_API_KEY: 'deepseek-key',
    }, {
      fetchImpl: vi.fn(),
      now: () => new Date('2026-05-27T00:00:00.000Z'),
      id: () => 'run_2',
    })

    const response = await handler.fetch(new Request('https://sandbank.dev/api/db-native-agent-harness/stream', {
      method: 'POST',
      body: JSON.stringify({ message: 'hello' }),
    }))

    const body = await response.text()

    expect(response.status).toBe(200)
    expect(body).toContain('missing_db9_configuration')
    expect(body).toContain('"status":"failed"')
  })

  it('does not expose model reasoning chunks as visible chat text', async () => {
    const workspace = new MemoryWorkspaceAdapter(undefined, { id: 'db9:test' })
    const fetchImpl = vi.fn(async (_input: string | URL | Request, _init?: RequestInit) => {
      const encoder = new TextEncoder()
      return new Response(new ReadableStream({
        start(controller) {
          controller.enqueue(encoder.encode('data: {"choices":[{"delta":{"reasoning_content":"hidden plan"}}]}\n\n'))
          controller.enqueue(encoder.encode('data: {"choices":[{"delta":{"content":"final answer"}}]}\n\n'))
          controller.enqueue(encoder.encode('data: [DONE]\n\n'))
          controller.close()
        },
      }), {
        headers: { 'Content-Type': 'text/event-stream' },
      })
    })
    const handler = createDbNativeAgentHarnessHandler({
      DB9_DATABASE_ID: 'db-test',
      DEEPSEEK_API_KEY: 'deepseek-key',
    }, {
      createWorkspace: async () => workspace,
      fetchImpl,
      now: () => new Date('2026-05-27T00:00:00.000Z'),
      id: () => 'run_reasoning',
    })

    const response = await handler.fetch(new Request('https://sandbank.dev/api/db-native-agent-harness/stream', {
      method: 'POST',
      body: JSON.stringify({ message: '@codex explain the harness' }),
    }))

    const body = await response.text()

    expect(body).toContain('"text":"final answer"')
    expect(body).not.toContain('hidden plan')
    await expect(workspace.read('/runs/run_reasoning/assistant.md')).resolves.toBe('final answer')
  })

  it('uses attachment context and falls back when streamed model chunks contain no visible text', async () => {
    const workspace = new MemoryWorkspaceAdapter(undefined, { id: 'db9:test' })
    const fetchImpl = vi.fn(async (_input: string | URL | Request, _init?: RequestInit) => {
      const encoder = new TextEncoder()
      return new Response(new ReadableStream({
        start(controller) {
          controller.enqueue(encoder.encode('data: not-json\n\n'))
          controller.enqueue(encoder.encode('data: {"choices":[{"delta":{"reasoning_content":"hidden only"}}]}\n\n'))
          controller.enqueue(encoder.encode('data: [DONE]\n\n'))
          controller.close()
        },
      }))
    })
    const handler = createDbNativeAgentHarnessHandler({
      DB9_DATABASE_ID: 'db-test',
      OPENAI_API_KEY: 'openai-key',
      CHATW_DEEPSEEK_USE_OPENAI_ENV: '1',
      OPENAI_BASE_URL: 'https://openai-compatible.example',
      DEEPSEEK_MODEL: 'deepseek-custom',
    }, {
      createWorkspace: async () => workspace,
      fetchImpl,
      now: () => new Date('2026-05-27T00:00:00.000Z'),
      id: () => 'run_empty_stream',
    })

    const response = await handler.fetch(new Request('https://sandbank.dev/api/chatw/stream', {
      method: 'POST',
      body: JSON.stringify({
        message: '@agent inspect uploaded context',
        attachments: [{}],
      }),
    }))

    const body = await response.text()
    const requestBody = JSON.parse(String(fetchImpl.mock.calls[0]?.[1]?.body)) as { model: string; messages: Array<{ content: string }> }

    expect(requestBody.model).toBe('deepseek-custom')
    expect(String(fetchImpl.mock.calls[0]?.[0])).toBe('https://openai-compatible.example/chat/completions')
    expect(requestBody.messages.at(-1)?.content).toContain('untitled (application/octet-stream, 0 bytes)')
    expect(body).toContain('DeepSeek V4 Pro returned an empty streamed response.')
    await expect(workspace.read('/runs/run_empty_stream/assistant.md')).resolves.toBe('DeepSeek V4 Pro returned an empty streamed response.')
  })

  it('reports missing DeepSeek credentials after workspace setup', async () => {
    const workspace = new MemoryWorkspaceAdapter(undefined, { id: 'db9:test' })
    const handler = createDbNativeAgentHarnessHandler({
      DB9_DATABASE_ID: 'db-test',
    }, {
      createWorkspace: async () => workspace,
      id: () => 'run_missing_model_key',
      now: () => new Date('2026-05-27T00:00:00.000Z'),
    })

    const response = await handler.fetch(new Request('https://sandbank.dev/api/db-native-agent-harness/stream', {
      method: 'POST',
      body: JSON.stringify({ message: '@agent needs model key' }),
    }))

    const body = await response.text()

    expect(body).toContain('missing_deepseek_api_key')
    expect(body).toContain('"status":"failed"')
  })

  it('uses global fetch fallback and handles sparse model stream blocks', async () => {
    const workspace = new MemoryWorkspaceAdapter(undefined, { id: 'db9:test' })
    const globalFetch = vi.fn(async (_input: string | URL | Request, _init?: RequestInit) => {
      const encoder = new TextEncoder()
      return new Response(new ReadableStream({
        start(controller) {
          controller.enqueue(encoder.encode('event: ping\n\n'))
          controller.enqueue(encoder.encode('data: {"foo":true}\n\n'))
          controller.enqueue(encoder.encode('data: {"choices":[{"delta":{"content":"global fetch answer"}}]}\n\n'))
          controller.close()
        },
      }))
    })
    vi.stubGlobal('fetch', globalFetch)
    const handler = createDbNativeAgentHarnessHandler({
      DB9_DATABASE_ID: 'db-test',
      CHATW_DEEPSEEK_API_KEY: 'chatw-key',
      CHATW_DEEPSEEK_BASE_URL: 'https://chatw-deepseek.example',
      CHATW_DEEPSEEK_MODEL: 'chatw-deepseek',
    }, {
      createWorkspace: async () => workspace,
      id: () => 'run_global_fetch',
      now: () => new Date('2026-05-27T00:00:00.000Z'),
    })

    const response = await handler.fetch(new Request('https://sandbank.dev/api/db-native-agent-harness/stream', {
      method: 'POST',
      body: JSON.stringify({
        history: [
          { role: 'system', content: 'ignored' },
          { role: 'assistant', content: 'assistant memory' },
          { role: 'user', content: 'old user message' },
          { role: 'user', content: 'latest user message' },
        ],
      }),
    }))

    const body = await response.text()
    const requestBody = JSON.parse(String(globalFetch.mock.calls[0]?.[1]?.body)) as { model: string; messages: Array<{ role: string; content: string }> }

    expect(String(globalFetch.mock.calls[0]?.[0])).toBe('https://chatw-deepseek.example/chat/completions')
    expect(requestBody.model).toBe('chatw-deepseek')
    expect(requestBody.messages.map(message => message.role)).toEqual(['system', 'assistant', 'user', 'user'])
    expect(requestBody.messages.at(-1)?.content).toBe('Use the DB-native harness.')
    expect(body).toContain('"text":"global fetch answer"')
    await expect(workspace.read('/runs/run_global_fetch/assistant.md')).resolves.toBe('global fetch answer')
  })

  it('reports DeepSeek HTTP failures and missing streams as harness errors', async () => {
    const httpFailure = createDbNativeAgentHarnessHandler({
      DB9_DATABASE_ID: 'db-test',
      DEEPSEEK_API_KEY: 'deepseek-key',
    }, {
      createWorkspace: async () => new MemoryWorkspaceAdapter(undefined, { id: 'db9:test' }),
      fetchImpl: vi.fn(async () => new Response('rate limited', { status: 429 })),
      id: () => 'run_http_failure',
      now: () => new Date('2026-05-27T00:00:00.000Z'),
    })
    const missingStream = createDbNativeAgentHarnessHandler({
      DB9_DATABASE_ID: 'db-test',
      DEEPSEEK_API_KEY: 'deepseek-key',
    }, {
      createWorkspace: async () => new MemoryWorkspaceAdapter(undefined, { id: 'db9:test' }),
      fetchImpl: vi.fn(async () => new Response(null)),
      id: () => 'run_missing_stream',
      now: () => new Date('2026-05-27T00:00:00.000Z'),
    })

    const httpBody = await (await httpFailure.fetch(new Request('https://sandbank.dev/api/db-native-agent-harness/stream', {
      method: 'POST',
      body: JSON.stringify({ message: '@agent http fail' }),
    }))).text()
    const streamBody = await (await missingStream.fetch(new Request('https://sandbank.dev/api/db-native-agent-harness/stream', {
      method: 'POST',
      body: JSON.stringify({ message: '@agent no stream' }),
    }))).text()

    expect(httpBody).toContain('deepseek_http_error')
    expect(streamBody).toContain('missing_deepseek_stream')
  })

  it('normalizes unknown thrown values from the model call', async () => {
    const handler = createDbNativeAgentHarnessHandler({
      DB9_DATABASE_ID: 'db-test',
      DEEPSEEK_API_KEY: 'deepseek-key',
    }, {
      createWorkspace: async () => new MemoryWorkspaceAdapter(undefined, { id: 'db9:test' }),
      fetchImpl: vi.fn(async () => {
        throw 'model transport failed'
      }),
      id: () => 'run_unknown_throw',
      now: () => new Date('2026-05-27T00:00:00.000Z'),
    })

    const response = await handler.fetch(new Request('https://sandbank.dev/api/db-native-agent-harness/stream', {
      method: 'POST',
      body: JSON.stringify({ message: '@agent unknown throw' }),
    }))

    const body = await response.text()

    expect(body).toContain('DB-native harness request failed.')
    expect(body).toContain('"code":"harness_error"')
  })

  it('fails the run when a Dynamic Worker capsule returns a non-2xx response', async () => {
    const workspace = new MemoryWorkspaceAdapter(undefined, { id: 'db9:test' })
    const handler = createDbNativeAgentHarnessHandler({
      DB9_DATABASE_ID: 'db-test',
      DEEPSEEK_API_KEY: 'deepseek-key',
    }, {
      createWorkspace: async () => workspace,
      createExecutionCapsule: () => ({
        invoke: async options => {
          await options.onEvent?.({ type: 'log', level: 'error', message: 'capsule failed' })
          return { status: 500, headers: {}, body: 'boom' }
        },
      }),
      fetchImpl: vi.fn(),
      id: () => 'run_capsule_failure',
      now: () => new Date('2026-05-27T00:00:00.000Z'),
    })

    const response = await handler.fetch(new Request('https://sandbank.dev/api/db-native-agent-harness/stream', {
      method: 'POST',
      body: JSON.stringify({ message: '@agent run failing capsule' }),
    }))

    const body = await response.text()

    expect(body).toContain('capsule failed')
    expect(body).toContain('"name":"dynamic_worker_capsule","status":"failed"')
    expect(body).toContain('dynamic_worker_http_error')
  })

  it('can be served as a Node HTTP API surface', async () => {
    const server = await startDbNativeAgentHarnessServer({
      DB9_DATABASE_ID: 'db-test',
      DEEPSEEK_API_KEY: 'deepseek-key',
    }, {
      port: 0,
      host: '127.0.0.1',
    })

    try {
      const response = await fetch(`${server.url}/health`)
      const body = await response.json() as { ok: boolean; service: string; model: string; workspace: string; supervisor: boolean }

      expect(body).toEqual({
        ok: true,
        service: 'sandbank-db-native-agent-harness',
        model: 'deepseek-v4-pro',
        workspace: 'db9',
        supervisor: true,
      })
    } finally {
      await server.close()
    }
  })

  it('reports deployable API capabilities and protects stream routes when bearer auth is configured', async () => {
    const handler = createDbNativeAgentHarnessHandler({
      DB9_DATABASE_ID: 'db-test',
      SANDBANK_HARNESS_API_KEY: 'harness-token',
    })

    const capabilities = await handler.fetch(new Request('https://sandbank.dev/api/db-native-agent-harness/capabilities'))
    await expect(capabilities.json()).resolves.toMatchObject({
      api: { auth: 'bearer', sse: true },
      supervisor: { runState: true, policyChecks: true },
      memory: { enabled: true, types: ['pinned', 'insight', 'session'] },
      toolUse: {
        supported: true,
        dynamicWorkerBinding: 'SANDBANK_TOOLS',
        sandboxProviderSwitching: true,
      },
      deployment: { nodeCli: 'sandbank harness-api' },
    })

    const unauthorized = await handler.fetch(new Request('https://sandbank.dev/api/db-native-agent-harness/stream', {
      method: 'POST',
      body: JSON.stringify({ message: 'hello' }),
    }))
    expect(unauthorized.status).toBe(401)

    const authorized = await handler.fetch(new Request('https://sandbank.dev/api/db-native-agent-harness/stream', {
      method: 'POST',
      headers: { Authorization: 'Bearer harness-token' },
      body: JSON.stringify({ message: 'hello' }),
    }))
    expect(authorized.status).toBe(200)
  })

  it('reports unconfigured health and not-found routes without auth', async () => {
    const handler = createDbNativeAgentHarnessHandler()

    const health = await handler.fetch(new Request('https://sandbank.dev/health'))
    const capabilities = await handler.fetch(new Request('https://sandbank.dev/api/db-native-agent-harness/capabilities'))
    const notFound = await handler.fetch(new Request('https://sandbank.dev/nope'))

    await expect(health.json()).resolves.toMatchObject({ workspace: 'unconfigured', model: 'deepseek-v4-pro' })
    await expect(capabilities.json()).resolves.toMatchObject({
      api: { auth: 'none' },
      workspace: { backend: 'unconfigured' },
    })
    expect(notFound.status).toBe(404)
  })

  it('exports a Cloudflare Worker-compatible fetch surface without Node server dependencies', async () => {
    const response = await harnessWorker.fetch(new Request('https://sandbank.dev/health'), {
      DB9_DATABASE_ID: 'db-test',
    })
    await expect(response.json()).resolves.toMatchObject({
      ok: true,
      service: 'sandbank-db-native-agent-harness',
      supervisor: true,
    })
  })

  it('passes Tool Use binding into a Cloudflare Dynamic Worker loader', async () => {
    const workspace = new MemoryWorkspaceAdapter(undefined, { id: 'db9:test' })
    const toolHandler = vi.fn(async input => ({ ok: true, input }))
    const registry = new ToolUseRegistry()
      .register(createCloudflareResourceTool('read', toolHandler))
    const fetchImpl = vi.fn(async () => {
      const encoder = new TextEncoder()
      return new Response(new ReadableStream({
        start(controller) {
          controller.enqueue(encoder.encode('data: {"choices":[{"delta":{"content":"model answer"}}]}\n\n'))
          controller.enqueue(encoder.encode('data: [DONE]\n\n'))
          controller.close()
        },
      }))
    })
    let loaderToolList: unknown
    let loaderToolResult: unknown
    const loader = {
      load: vi.fn(async (code: { env?: Record<string, unknown> }) => {
        const tools = code.env?.['SANDBANK_TOOLS'] as {
          list(): Promise<Array<{ name: string; description?: string }>>
          use(request: { tool: string; input?: unknown }): Promise<unknown>
        } | undefined
        loaderToolList = await tools?.list()
        loaderToolResult = await tools?.use({
          tool: 'cloudflare.resource.read',
          input: {
            resource: { kind: 'cloudflare.d1', id: 'analytics' },
            operation: 'select',
          },
        })
        return {
          fetch: async () => new Response('worker-tools-ok'),
        }
      }),
      get: vi.fn(),
    }

    const response = await harnessWorker.fetch(new Request('https://sandbank.dev/api/db-native-agent-harness/stream', {
      method: 'POST',
      body: JSON.stringify({
        message: '@codex run worker tool',
        mentions: { cleanedMessage: 'run worker tool', agent: 'codex' },
      }),
    }), {
      DB9_DATABASE_ID: 'db-test',
      DEEPSEEK_API_KEY: 'deepseek-key',
      SANDBANK_DYNAMIC_WORKER_LOADER: loader,
    }, undefined, {
      createWorkspace: async () => workspace,
      createToolUse: async () => ({
        registry,
        policy: {
          allowedTools: ['cloudflare.resource.read'],
          resources: [
            { kind: 'cloudflare.d1', id: 'analytics', actions: ['read'] },
          ],
        },
      }),
      fetchImpl,
      now: () => new Date('2026-06-03T00:00:00.000Z'),
      id: () => 'run_worker_tools',
    })
    const body = await response.text()

    expect(loaderToolList).toEqual(expect.arrayContaining([
      expect.objectContaining({ name: 'cloudflare.resource.read' }),
    ]))
    expect(loaderToolResult).toMatchObject({ ok: true })
    expect(toolHandler).toHaveBeenCalledTimes(1)
    expect(body).toContain('worker-tools-ok')
    expect(body).toContain('"text":"model answer"')
  })
})
