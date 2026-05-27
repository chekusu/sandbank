import { describe, expect, it, vi } from 'vitest'
import {
  DynamicWorkerExecutionCapsule,
  buildDynamicWorkerCode,
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
})
