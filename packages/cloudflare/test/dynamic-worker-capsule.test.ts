import { describe, expect, it, vi } from 'vitest'
import { MemoryWorkspaceAdapter } from '@sandbank.dev/workspace'
import {
  DynamicWorkerExecutionCapsule,
  buildDynamicWorkerCode,
  type DynamicWorkerExecutionEvent,
  type DynamicWorkerCode,
  type DynamicWorkerLoader,
} from '../src/dynamic-worker-capsule.js'

describe('DynamicWorkerExecutionCapsule', () => {
  it('invokes a one-off Dynamic Worker capsule with minimized bindings and denied egress by default', async () => {
    const loaded: DynamicWorkerCode[] = []
    const loader: DynamicWorkerLoader = {
      load: vi.fn(async code => {
        loaded.push(code)
        return {
          getEntrypoint: () => ({
            fetch: async request => new Response(`ok:${new URL(request.url).pathname}`),
          }),
        }
      }),
      get: vi.fn(),
    }
    const capsule = new DynamicWorkerExecutionCapsule({
      loader,
      bindingAllowlist: ['WORKSPACE'],
    })

    const result = await capsule.invoke({
      code: 'export default { fetch() { return new Response("hello") } }',
      request: new Request('https://capsule.test/run'),
      bindings: {
        WORKSPACE: { read: 'allowed' },
        SECRET: 'not-forwarded',
      },
    })

    expect(result).toEqual({ status: 200, headers: { 'content-type': 'text/plain;charset=UTF-8' }, body: 'ok:/run' })
    expect(loader.load).toHaveBeenCalledTimes(1)
    expect(loaded[0]).toMatchObject({
      mainModule: 'index.js',
      globalOutbound: null,
      env: { WORKSPACE: { read: 'allowed' } },
    })
    expect(loaded[0]?.env).not.toHaveProperty('SECRET')
  })

  it('uses get(id) for reusable code without treating Dynamic Worker memory as durable state', async () => {
    let callbackCode: DynamicWorkerCode | undefined
    const loader: DynamicWorkerLoader = {
      load: vi.fn(),
      get: vi.fn(async (_id, getCode) => {
        callbackCode = await getCode()
        return {
          fetch: async () => new Response('cached'),
        }
      }),
    }
    const capsule = new DynamicWorkerExecutionCapsule({ loader })

    const result = await capsule.invoke({
      id: 'tool-summarize-v1',
      code: 'export default { fetch() { return new Response("cached") } }',
    })

    expect(result.body).toBe('cached')
    expect(loader.get).toHaveBeenCalledWith('tool-summarize-v1', expect.any(Function))
    expect(callbackCode?.globalOutbound).toBeNull()
  })

  it('can route egress through an explicit gateway binding and expose allowlisted hosts as metadata', () => {
    const gateway = { fetch: vi.fn() }
    const code = buildDynamicWorkerCode({
      code: 'export default { fetch() { return new Response("gateway") } }',
      bindings: { WORKSPACE: { read: 'ok' } },
      bindingAllowlist: ['WORKSPACE'],
      egress: {
        mode: 'gateway',
        binding: gateway,
        allowedHosts: ['api.deepseek.com'],
      },
    })

    expect(code.globalOutbound).toBe(gateway)
    expect(code.env).toEqual({
      WORKSPACE: { read: 'ok' },
      SANDBANK_EGRESS_ALLOW_HOSTS: ['api.deepseek.com'],
    })
  })

  it('can deliberately inherit parent outbound only when configured', () => {
    const code = buildDynamicWorkerCode({
      code: 'export default { fetch() { return new Response("inherit") } }',
      egress: { mode: 'inherit' },
    })

    expect(code.globalOutbound).toBeUndefined()
    expect(code.env).toEqual({})
  })

  it('passes a scoped workspace binding plus runtime log and artifact bindings to the Dynamic Worker', async () => {
    const workspace = new MemoryWorkspaceAdapter(undefined, { id: 'run-workspace' })
    const events: DynamicWorkerExecutionEvent[] = []
    let loadedCode: DynamicWorkerCode | undefined
    const loader: DynamicWorkerLoader = {
      load: vi.fn(async code => {
        loadedCode = code
        const workspaceBinding = code.env?.['SANDBANK_WORKSPACE'] as {
          read(path: string): Promise<string>
          write(path: string, data: string): Promise<unknown>
          query(query: { kind: 'files'; path: string }): Promise<{ rowCount: number }>
        }
        const runtimeBinding = code.env?.['SANDBANK_RUNTIME'] as {
          log(level: 'info', message: string, metadata?: Record<string, unknown>): Promise<void>
          artifact(name: string, data: string, metadata?: { mediaType?: string }): Promise<{ path: string }>
        }

        await workspaceBinding.write('/workspace/input.txt', 'hello')
        const input = await workspaceBinding.read('/workspace/input.txt')
        const files = await workspaceBinding.query({ kind: 'files', path: '/workspace' })
        await runtimeBinding.log('info', 'workspace read', { input, files: files.rowCount })
        const artifact = await runtimeBinding.artifact('summary.txt', `artifact:${input}`, { mediaType: 'text/plain' })

        return {
          fetch: async () => new Response(`read:${input};artifact:${artifact.path}`),
        }
      }),
      get: vi.fn(),
    }
    const capsule = new DynamicWorkerExecutionCapsule({ loader })

    const result = await capsule.invoke({
      code: 'export default { fetch() { return new Response("unused") } }',
      workspace,
      workspaceScope: {
        readablePaths: ['/workspace', '/artifacts'],
        writablePaths: ['/workspace', '/artifacts'],
        allowQuery: true,
        artifactRoot: '/artifacts/run-1',
      },
      onEvent: event => events.push(event),
    })

    expect(result.body).toContain('read:hello;artifact:/artifacts/run-1/summary.txt')
    expect(await workspace.read('/artifacts/run-1/summary.txt')).toBe('artifact:hello')
    expect(loadedCode?.env).toHaveProperty('SANDBANK_WORKSPACE')
    expect(loadedCode?.env).toHaveProperty('SANDBANK_RUNTIME')
    expect(events).toContainEqual(expect.objectContaining({ type: 'log', level: 'info', message: 'workspace read' }))
    expect(events).toContainEqual(expect.objectContaining({ type: 'artifact', path: '/artifacts/run-1/summary.txt' }))
  })

  it('emits stream chunk events while still returning the complete response body', async () => {
    const events: DynamicWorkerExecutionEvent[] = []
    const loader: DynamicWorkerLoader = {
      load: vi.fn(async () => ({
        fetch: async () => new Response(new ReadableStream<Uint8Array>({
          start(controller) {
            const encoder = new TextEncoder()
            controller.enqueue(encoder.encode('hel'))
            controller.enqueue(encoder.encode('lo'))
            controller.close()
          },
        })),
      })),
      get: vi.fn(),
    }
    const capsule = new DynamicWorkerExecutionCapsule({ loader })

    const result = await capsule.invoke({
      code: 'export default { fetch() { return new Response("unused") } }',
      onEvent: event => events.push(event),
    })

    expect(result.body).toBe('hello')
    expect(events.filter(event => event.type === 'stream.chunk').map(event => event.text)).toEqual(['hel', 'lo'])
  })

  it('applies timeout and Cloudflare invocation limits to a Dynamic Worker invocation', async () => {
    let loadedCode: DynamicWorkerCode | undefined
    const loader: DynamicWorkerLoader = {
      load: vi.fn(async code => {
        loadedCode = code
        return {
          fetch: async () => new Promise<Response>(() => {}),
        }
      }),
      get: vi.fn(),
    }
    const capsule = new DynamicWorkerExecutionCapsule({ loader })

    await expect(capsule.invoke({
      code: 'export default { fetch() { return new Response("unused") } }',
      timeoutMs: 5,
      limits: { cpuMs: 25, subRequests: 4 },
    })).rejects.toMatchObject({ code: 'DYNAMIC_WORKER_TIMEOUT' })
    expect(loadedCode?.limits).toEqual({ cpuMs: 25, subRequests: 4 })
  })
})
