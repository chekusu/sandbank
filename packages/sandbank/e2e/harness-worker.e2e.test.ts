import { describe, expect, it, vi } from 'vitest'
import { MemoryWorkspaceAdapter } from '@sandbank.dev/workspace'
import harnessWorker, {
  SandbankRuntimeBinding,
  SandbankSearchBinding,
  SandbankWorkspaceBinding,
} from '../src/harness-worker.js'
import type { DynamicWorkerCode, DynamicWorkerLoader } from '@sandbank.dev/cloudflare/dynamic-worker-capsule'

function createExecutionContext(env: Record<string, unknown>) {
  return {
    waitUntil() {},
    passThroughOnException() {},
    props: {},
    exports: {
      SandbankWorkspaceBinding: ({ props }: { props: { invocationId: string } }) => new SandbankWorkspaceBinding({
        waitUntil() {},
        passThroughOnException() {},
        props,
      }, env),
      SandbankRuntimeBinding: ({ props }: { props: { invocationId: string } }) => new SandbankRuntimeBinding({
        waitUntil() {},
        passThroughOnException() {},
        props,
      }, env),
      SandbankSearchBinding: ({ props }: { props: { invocationId: string } }) => new SandbankSearchBinding({
        waitUntil() {},
        passThroughOnException() {},
        props,
      }, env),
    },
  } as ExecutionContext & {
    exports: Record<string, (options: { props: { invocationId: string } }) => unknown>
  }
}

describe('db-native harness Worker e2e', () => {
  it('runs search code mode through the Worker endpoint and Dynamic Worker loader', async () => {
    const loadedCodes: DynamicWorkerCode[] = []
    const loader: DynamicWorkerLoader = {
      get: vi.fn(),
      load: vi.fn(async code => {
        loadedCodes.push(code)
        return {
          fetch: async request => executeDynamicWorkerModule(code, request),
        }
      }),
    }
    const env = {
      DB9_DATABASE_ID: 'db-test',
      DEEPSEEK_API_KEY: 'deepseek-key',
      LOADER: loader,
    }

    const response = await harnessWorker.fetch(new Request('https://sandbank.dev/__sandbank/e2e/search-code', {
      method: 'POST',
      body: JSON.stringify({ query: 'tokyo french restaurants' }),
    }), env, createExecutionContext(env))
    const body = await response.json() as {
      ok: boolean
      tool: {
        result: { query: string; count: number; top: string }
        artifacts: Array<{ name: string; path: string }>
      }
      artifacts: Record<string, unknown>
    }

    expect(response.status, JSON.stringify(body)).toBe(200)
    expect(body.ok).toBe(true)
    expect(body.tool.result).toMatchObject({
      query: 'tokyo french restaurants',
      count: 3,
      top: 'Lature',
    })
    expect(body.tool.artifacts.map(artifact => artifact.name).sort()).toEqual(['restaurants.json', 'summary.json'])
    expect(body.artifacts['restaurants.json']).toMatchObject({
      query: 'tokyo french restaurants',
      ranked: expect.arrayContaining([
        expect.objectContaining({ title: 'Lature' }),
      ]),
    })
    expect(loader.load).toHaveBeenCalledTimes(1)
    expect(loadedCodes[0]?.globalOutbound).toBeNull()
    expect(loadedCodes[0]?.env).toHaveProperty('SANDBANK_SEARCH')
    expect(loadedCodes[0]?.env).toHaveProperty('SANDBANK_WORKSPACE')
    expect(loadedCodes[0]?.env).toHaveProperty('SANDBANK_RUNTIME')
  })

  it('routes Dynamic Worker capsule calls through Cloudflare loopback bindings', async () => {
    const loadedCodes: DynamicWorkerCode[] = []
    const loader: DynamicWorkerLoader = {
      get: vi.fn(),
      load: vi.fn(async code => {
        loadedCodes.push(code)
        const workspace = code.env?.['SANDBANK_WORKSPACE'] as {
          append(path: string, data: string): Promise<unknown>
          list(path: string, opts?: { recursive?: boolean }): Promise<Array<{ path: string }>>
          query(query: { kind: 'files'; path: string }): Promise<{ rowCount: number }>
          read(path: string): Promise<string>
          write(path: string, data: string): Promise<unknown>
        }
        const runtime = code.env?.['SANDBANK_RUNTIME'] as {
          artifact(name: string, data: string, metadata?: { mediaType?: string }): Promise<{ path: string }>
          log(level: 'info', message: string, metadata?: Record<string, unknown>): Promise<void>
        }

        await runtime.log('info', 'loopback capsule booted', { source: 'e2e' })
        await workspace.write('/workspace/loopback.txt', 'hello')
        await workspace.append('/workspace/loopback.txt', ' worker')
        const content = await workspace.read('/workspace/loopback.txt')
        const files = await workspace.list('/workspace', { recursive: true })
        const query = await workspace.query({ kind: 'files', path: '/workspace' })
        await runtime.artifact('loopback.json', JSON.stringify({ content, files: files.length, rows: query.rowCount }), {
          mediaType: 'application/json',
        })

        return {
          fetch: async () => new Response(`capsule:${content}:${query.rowCount}`),
        }
      }),
    }
    const workspace = new MemoryWorkspaceAdapter(undefined, { id: 'db9:worker-e2e' })
    const fetchImpl = vi.fn(async () => {
      const encoder = new TextEncoder()
      return new Response(new ReadableStream({
        start(controller) {
          controller.enqueue(encoder.encode('data: {"choices":[{"delta":{"content":"worker e2e"}}]}\n\n'))
          controller.enqueue(encoder.encode('data: [DONE]\n\n'))
          controller.close()
        },
      }))
    })
    const env = {
      DB9_DATABASE_ID: 'db-test',
      DEEPSEEK_API_KEY: 'deepseek-key',
      LOADER: loader,
    }

    const response = await harnessWorker.fetch(new Request('https://sandbank.dev/api/db-native-agent-harness/stream', {
      method: 'POST',
      body: JSON.stringify({
        message: '@codex verify loopback worker bindings',
        mentions: { agent: 'codex', cleanedMessage: 'verify loopback worker bindings' },
      }),
    }), env, createExecutionContext(env), {
      createWorkspace: async () => workspace,
      fetchImpl,
      id: () => 'run_worker_e2e',
      now: () => new Date('2026-05-28T00:00:00.000Z'),
    } as never)

    const body = await response.text()

    expect(loader.load).toHaveBeenCalledTimes(1)
    expect(loader.get).not.toHaveBeenCalled()
    expect(loadedCodes[0]?.globalOutbound).toBeNull()
    expect(body).toContain('loopback capsule booted')
    expect(body).toContain('/runs/run_worker_e2e/artifacts/loopback.json')
    expect(body).toContain('capsule:hello worker:1')
    expect(body).toContain('"text":"worker e2e"')
    await expect(workspace.read('/workspace/loopback.txt')).resolves.toBe('hello worker')
    await expect(workspace.read('/runs/run_worker_e2e/artifacts/loopback.json')).resolves.toContain('"content":"hello worker"')
  })

  it('falls back to plain scoped bindings when loopback exports are unavailable', async () => {
    const loader: DynamicWorkerLoader = {
      get: vi.fn(),
      load: vi.fn(async code => {
        const workspace = code.env?.['SANDBANK_WORKSPACE'] as {
          read(path: string): Promise<string>
          write(path: string, data: string): Promise<unknown>
        }
        const runtime = code.env?.['SANDBANK_RUNTIME'] as {
          log(level: 'info', message: string): Promise<void>
        }
        await workspace.write('/workspace/plain.txt', 'plain binding')
        await runtime.log('info', await workspace.read('/workspace/plain.txt'))
        return {
          fetch: async () => new Response('plain capsule complete'),
        }
      }),
    }
    const workspace = new MemoryWorkspaceAdapter(undefined, { id: 'db9:plain-worker-e2e' })
    const fetchImpl = vi.fn(async () => {
      const encoder = new TextEncoder()
      return new Response(new ReadableStream({
        start(controller) {
          controller.enqueue(encoder.encode('data: {"choices":[{"delta":{"content":"plain worker"}}]}\n\n'))
          controller.enqueue(encoder.encode('data: [DONE]\n\n'))
          controller.close()
        },
      }))
    })

    const response = await harnessWorker.fetch(new Request('https://sandbank.dev/api/db-native-agent-harness/stream', {
      method: 'POST',
      body: JSON.stringify({ message: '@agent use plain bindings' }),
    }), {
      DB9_DATABASE_ID: 'db-test',
      DEEPSEEK_API_KEY: 'deepseek-key',
      LOADER: loader,
    }, undefined, {
      createWorkspace: async () => workspace,
      fetchImpl,
      id: () => 'run_plain_worker_e2e',
      now: () => new Date('2026-05-28T00:00:00.000Z'),
    })

    const body = await response.text()

    expect(loader.load).toHaveBeenCalledTimes(1)
    expect(body).toContain('plain binding')
    expect(body).toContain('plain capsule complete')
    expect(body).toContain('"text":"plain worker"')
    await expect(workspace.read('/workspace/plain.txt')).resolves.toBe('plain binding')
  })

  it('flushes queued loopback events before reporting capsule failures', async () => {
    const loader: DynamicWorkerLoader = {
      get: vi.fn(),
      load: vi.fn(async code => {
        const runtime = code.env?.['SANDBANK_RUNTIME'] as {
          log(level: 'error', message: string): Promise<void>
        }
        await runtime.log('error', 'queued before failure')
        throw new Error('loader exploded')
      }),
    }
    const workspace = new MemoryWorkspaceAdapter(undefined, { id: 'db9:worker-failure-e2e' })
    const env = {
      DB9_DATABASE_ID: 'db-test',
      DEEPSEEK_API_KEY: 'deepseek-key',
      LOADER: loader,
    }

    const response = await harnessWorker.fetch(new Request('https://sandbank.dev/api/db-native-agent-harness/stream', {
      method: 'POST',
      body: JSON.stringify({ message: '@agent fail loopback worker' }),
    }), env, createExecutionContext(env), {
      createWorkspace: async () => workspace,
      fetchImpl: vi.fn(),
      id: () => 'run_worker_failure_e2e',
      now: () => new Date('2026-05-28T00:00:00.000Z'),
    })

    const body = await response.text()

    expect(body).toContain('queued before failure')
    expect(body).toContain('loader exploded')
    expect(body).toContain('"status":"failed"')
  })

  it('surfaces stale loopback binding invocations as harness errors', async () => {
    const binding = new SandbankWorkspaceBinding({
      waitUntil() {},
      passThroughOnException() {},
      props: { invocationId: 'missing' },
    }, {})

    await expect(binding.read('/workspace/missing.txt')).rejects.toThrow('Dynamic Worker binding context not found: missing')
  })
})

async function executeDynamicWorkerModule(code: DynamicWorkerCode, request: Request): Promise<Response> {
  const moduleContent = code.modules[code.mainModule]
  if (typeof moduleContent !== 'string') throw new Error(`Expected string module for ${code.mainModule}`)
  const moduleUrl = `data:text/javascript;base64,${Buffer.from(moduleContent).toString('base64')}`
  const mod = await import(moduleUrl) as { default: { fetch(request: Request, env: Record<string, unknown>): Promise<Response> } }
  return mod.default.fetch(request, code.env ?? {})
}
