import { describe, expect, it, vi } from 'vitest'
import { MemoryWorkspaceAdapter, type WorkspaceAdapter } from '@sandbank.dev/workspace'
import { createDbNativeAgentHarnessHandler } from './harness-api.js'
import { startDbNativeAgentHarnessServer } from './harness-node.js'
import harnessWorker from './harness-worker.js'

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

  it('invokes a configured Dynamic Worker capsule for the run and forwards its events', async () => {
    const workspace = new MemoryWorkspaceAdapter(undefined, { id: 'db9:test' })
    const fetchImpl = vi.fn(async () => {
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
    const fetchImpl = vi.fn(async () => {
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
      deployment: { nodeCli: 'sandbank harness-api' },
    })

    const unauthorized = await handler.fetch(new Request('https://sandbank.dev/api/db-native-agent-harness/stream', {
      method: 'POST',
      body: JSON.stringify({ message: 'hello' }),
    }))
    expect(unauthorized.status).toBe(401)
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
})
