import { describe, it, expect, vi } from 'vitest'
import { createProvider } from '../src/provider.js'
import { CapabilityNotSupportedError, ProviderError, SandboxError } from '../src/errors.js'
import type { SandboxAdapter, AdapterSandbox, Capability } from '../src/types.js'

function mockAdapterSandbox(overrides: Partial<AdapterSandbox> = {}): AdapterSandbox {
  return {
    id: 'sb-mock',
    state: 'running',
    createdAt: '2025-01-01T00:00:00Z',
    exec: vi.fn(async () => ({ exitCode: 0, stdout: 'hello', stderr: '' })),
    ...overrides,
  }
}

function mockAdapter(overrides: Partial<SandboxAdapter> = {}): SandboxAdapter {
  const raw = mockAdapterSandbox()
  return {
    name: 'mock',
    capabilities: new Set<Capability>(),
    createSandbox: vi.fn(async () => raw),
    getSandbox: vi.fn(async () => raw),
    listSandboxes: vi.fn(async () => []),
    destroySandbox: vi.fn(async () => {}),
    ...overrides,
  }
}

describe('createProvider', () => {
  it('wraps adapter into SandboxProvider', () => {
    const adapter = mockAdapter()
    const provider = createProvider(adapter)
    expect(provider.name).toBe('mock')
    expect(provider.capabilities.size).toBe(0)
  })

  it('create() returns a wrapped Sandbox', async () => {
    const provider = createProvider(mockAdapter())
    const sandbox = await provider.create({ image: 'node:22' })
    expect(sandbox.id).toBe('sb-mock')
    expect(sandbox.state).toBe('running')
  })

  it('sandbox.exec() delegates to adapter', async () => {
    const execFn = vi.fn(async () => ({ exitCode: 0, stdout: 'ok', stderr: '' }))
    const adapter = mockAdapter({
      createSandbox: async () => mockAdapterSandbox({ exec: execFn }),
    })
    const provider = createProvider(adapter)
    const sandbox = await provider.create({ image: 'node:22' })
    const result = await sandbox.exec('echo ok')
    expect(result.stdout).toBe('ok')
    expect(execFn).toHaveBeenCalledWith('echo ok', undefined)
  })

  it('sandbox.writeFile() falls back to exec when adapter has no writeFile', async () => {
    const execFn = vi.fn(async () => ({ exitCode: 0, stdout: '', stderr: '' }))
    const adapter = mockAdapter({
      createSandbox: async () => mockAdapterSandbox({ exec: execFn }),
    })
    const provider = createProvider(adapter)
    const sandbox = await provider.create({ image: 'node:22' })
    await sandbox.writeFile('/tmp/test.txt', 'hello')
    // exec fallback should have been called (mkdir + write)
    expect(execFn).toHaveBeenCalled()
  })

  it('sandbox.writeFile() uses native when adapter provides it', async () => {
    const nativeWrite = vi.fn(async () => {})
    const adapter = mockAdapter({
      createSandbox: async () => mockAdapterSandbox({ writeFile: nativeWrite }),
    })
    const provider = createProvider(adapter)
    const sandbox = await provider.create({ image: 'node:22' })
    await sandbox.writeFile('/tmp/test.txt', 'hello')
    expect(nativeWrite).toHaveBeenCalledWith('/tmp/test.txt', 'hello')
  })

  it('sandbox.readFile() falls back to exec when adapter has no readFile', async () => {
    // base64 of "hello" is "aGVsbG8="
    const execFn = vi.fn(async () => ({ exitCode: 0, stdout: 'aGVsbG8=\n', stderr: '' }))
    const adapter = mockAdapter({
      createSandbox: async () => mockAdapterSandbox({ exec: execFn }),
    })
    const provider = createProvider(adapter)
    const sandbox = await provider.create({ image: 'node:22' })
    const content = await sandbox.readFile('/tmp/test.txt')
    expect(new TextDecoder().decode(content)).toBe('hello')
  })

  it('get() delegates to adapter.getSandbox', async () => {
    const adapter = mockAdapter()
    const provider = createProvider(adapter)
    const sandbox = await provider.get('sb-mock')
    expect(sandbox.id).toBe('sb-mock')
    expect(adapter.getSandbox).toHaveBeenCalledWith('sb-mock')
  })

  it('list() delegates to adapter.listSandboxes', async () => {
    const adapter = mockAdapter({
      listSandboxes: vi.fn(async () => [
        { id: 'sb-1', state: 'running' as const, createdAt: '', image: 'node:22' },
      ]),
    })
    const provider = createProvider(adapter)
    const result = await provider.list()
    expect(result).toHaveLength(1)
    expect(result[0]!.id).toBe('sb-1')
  })

  it('destroy() delegates to adapter.destroySandbox', async () => {
    const adapter = mockAdapter()
    const provider = createProvider(adapter)
    await provider.destroy('sb-mock')
    expect(adapter.destroySandbox).toHaveBeenCalledWith('sb-mock')
  })

  it('uploadArchive throws SandboxError when not implemented', async () => {
    const adapter = mockAdapter()
    const provider = createProvider(adapter)
    const sandbox = await provider.create({ image: 'node:22' })
    expect(() => sandbox.uploadArchive(new Uint8Array([1]))).toThrow(SandboxError)
    expect(() => sandbox.uploadArchive(new Uint8Array([1]))).toThrow(/uploadArchive is not supported/)
  })

  it('downloadArchive throws SandboxError when not implemented', async () => {
    const adapter = mockAdapter()
    const provider = createProvider(adapter)
    const sandbox = await provider.create({ image: 'node:22' })
    expect(() => sandbox.downloadArchive()).toThrow(SandboxError)
    expect(() => sandbox.downloadArchive()).toThrow(/downloadArchive is not supported/)
  })

  it('exposes volume methods when adapter declares volumes capability and has methods', async () => {
    const adapter = mockAdapter({
      capabilities: new Set<Capability>(['volumes']),
      createVolume: vi.fn(async () => ({ id: 'v1', name: 'vol', sizeGB: 1, attachedTo: null })),
      deleteVolume: vi.fn(async () => {}),
      listVolumes: vi.fn(async () => []),
    })
    const provider = createProvider(adapter) as any
    expect(typeof provider.createVolume).toBe('function')
    expect(typeof provider.deleteVolume).toBe('function')
    expect(typeof provider.listVolumes).toBe('function')
  })

  it('does not expose volume methods when adapter declares volumes but missing methods', async () => {
    const adapter = mockAdapter({
      capabilities: new Set<Capability>(['volumes']),
      // No createVolume/deleteVolume/listVolumes
    })
    const provider = createProvider(adapter) as any
    expect(provider.createVolume).toBeUndefined()
  })

  it('detectCapabilities trusts sandbox-level capabilities', () => {
    const adapter = mockAdapter({
      capabilities: new Set<Capability>(['exec.stream', 'port.expose', 'sleep']),
    })
    const provider = createProvider(adapter)
    expect(provider.capabilities.has('exec.stream')).toBe(true)
    expect(provider.capabilities.has('port.expose')).toBe(true)
    expect(provider.capabilities.has('sleep')).toBe(true)
  })

  it('forwards optional capability methods on sandbox', async () => {
    const execStreamFn = vi.fn(async () => new ReadableStream())
    const sleepFn = vi.fn(async () => {})
    const adapter = mockAdapter({
      createSandbox: async () => mockAdapterSandbox({
        execStream: execStreamFn,
        sleep: sleepFn,
      }),
    })
    const provider = createProvider(adapter)
    const sandbox = await provider.create({ image: 'node:22' }) as any
    expect(typeof sandbox.execStream).toBe('function')
    expect(typeof sandbox.sleep).toBe('function')
  })
})
