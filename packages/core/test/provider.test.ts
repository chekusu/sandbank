import { describe, it, expect, vi } from 'vitest'
import { createProvider } from '../src/provider.js'

import type { SandboxAdapter, AdapterSandbox, Capability } from '../src/types.js'
import type { SandboxObserver, SandboxEvent } from '../src/observer.js'

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

  it('uploadArchive falls back to exec when adapter has no uploadArchive', async () => {
    const execFn = vi.fn(async () => ({ exitCode: 0, stdout: '', stderr: '' }))
    const adapter = mockAdapter({
      createSandbox: async () => mockAdapterSandbox({ exec: execFn }),
    })
    const provider = createProvider(adapter)
    const sandbox = await provider.create({ image: 'node:22' })
    await sandbox.uploadArchive(new Uint8Array([1, 2, 3]))
    // exec fallback should have been called (write + extract + cleanup)
    expect(execFn).toHaveBeenCalled()
  })

  it('uploadArchive uses native when adapter provides it', async () => {
    const nativeUpload = vi.fn(async () => {})
    const adapter = mockAdapter({
      createSandbox: async () => mockAdapterSandbox({ uploadArchive: nativeUpload }),
    })
    const provider = createProvider(adapter)
    const sandbox = await provider.create({ image: 'node:22' })
    const data = new Uint8Array([1, 2, 3])
    await sandbox.uploadArchive(data, '/tmp')
    expect(nativeUpload).toHaveBeenCalledWith(data, '/tmp')
  })

  it('downloadArchive falls back to exec when adapter has no downloadArchive', async () => {
    const base64Content = btoa('fake-tar-data')
    let callCount = 0
    const execFn = vi.fn(async () => {
      callCount++
      if (callCount === 2) {
        // base64 read
        return { exitCode: 0, stdout: base64Content + '\n', stderr: '' }
      }
      return { exitCode: 0, stdout: '', stderr: '' }
    })
    const adapter = mockAdapter({
      createSandbox: async () => mockAdapterSandbox({ exec: execFn }),
    })
    const provider = createProvider(adapter)
    const sandbox = await provider.create({ image: 'node:22' })
    const stream = await sandbox.downloadArchive()
    expect(stream).toBeInstanceOf(ReadableStream)
    expect(execFn).toHaveBeenCalled()
  })

  it('downloadArchive uses native when adapter provides it', async () => {
    const fakeStream = new ReadableStream()
    const nativeDownload = vi.fn(async () => fakeStream)
    const adapter = mockAdapter({
      createSandbox: async () => mockAdapterSandbox({ downloadArchive: nativeDownload }),
    })
    const provider = createProvider(adapter)
    const sandbox = await provider.create({ image: 'node:22' })
    const result = await sandbox.downloadArchive('/workspace')
    expect(result).toBe(fakeStream)
    expect(nativeDownload).toHaveBeenCalledWith('/workspace')
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

  it('exposes service methods when adapter declares services capability and has methods', async () => {
    const adapter = mockAdapter({
      capabilities: new Set<Capability>(['services']),
      createService: vi.fn(async () => ({ id: 's1', type: 'postgres' as const, name: 'db', state: 'ready' as const, credentials: { url: 'postgres://...', env: { DATABASE_URL: 'postgres://...' } } })),
      getService: vi.fn(async () => ({ id: 's1', type: 'postgres' as const, name: 'db', state: 'ready' as const, credentials: { url: 'postgres://...', env: { DATABASE_URL: 'postgres://...' } } })),
      listServices: vi.fn(async () => []),
      destroyService: vi.fn(async () => {}),
    })
    const provider = createProvider(adapter) as any
    expect(typeof provider.createService).toBe('function')
    expect(typeof provider.getService).toBe('function')
    expect(typeof provider.listServices).toBe('function')
    expect(typeof provider.destroyService).toBe('function')
  })

  it('does not expose service methods when adapter declares services but missing methods', async () => {
    const adapter = mockAdapter({
      capabilities: new Set<Capability>(['services']),
    })
    const provider = createProvider(adapter) as any
    expect(provider.createService).toBeUndefined()
  })

  it('injects service credentials as env vars when services are bound', async () => {
    const createSandbox = vi.fn(async (config: any) => {
      // Capture the config to verify env was merged
      return mockAdapterSandbox()
    })
    const adapter = mockAdapter({
      capabilities: new Set<Capability>(['services']),
      createSandbox,
      createService: vi.fn(),
      getService: vi.fn(async () => ({
        id: 's1',
        type: 'postgres' as const,
        name: 'db',
        state: 'ready' as const,
        credentials: {
          url: 'postgres://host:5432/db',
          env: { DATABASE_URL: 'postgres://host:5432/db', PGHOST: 'host' },
        },
      })),
      listServices: vi.fn(async () => []),
      destroyService: vi.fn(async () => {}),
    })
    const provider = createProvider(adapter)
    await provider.create({
      image: 'node:22',
      env: { EXISTING: 'val' },
      services: [{ id: 's1' }],
    })
    expect(createSandbox).toHaveBeenCalledWith(
      expect.objectContaining({
        env: {
          EXISTING: 'val',
          DATABASE_URL: 'postgres://host:5432/db',
          PGHOST: 'host',
        },
      }),
    )
  })

  it('applies envPrefix to service credentials', async () => {
    const createSandbox = vi.fn(async () => mockAdapterSandbox())
    const adapter = mockAdapter({
      capabilities: new Set<Capability>(['services']),
      createSandbox,
      createService: vi.fn(),
      getService: vi.fn(async () => ({
        id: 's1',
        type: 'postgres' as const,
        name: 'db',
        state: 'ready' as const,
        credentials: {
          url: 'postgres://host:5432/db',
          env: { DATABASE_URL: 'postgres://host:5432/db' },
        },
      })),
      listServices: vi.fn(async () => []),
      destroyService: vi.fn(async () => {}),
    })
    const provider = createProvider(adapter)
    await provider.create({
      image: 'node:22',
      services: [{ id: 's1', envPrefix: 'BRAIN' }],
    })
    expect(createSandbox).toHaveBeenCalledWith(
      expect.objectContaining({
        env: { BRAIN_DATABASE_URL: 'postgres://host:5432/db' },
      }),
    )
  })

  it('throws when bound service is not ready', async () => {
    const adapter = mockAdapter({
      capabilities: new Set<Capability>(['services']),
      createService: vi.fn(),
      getService: vi.fn(async () => ({
        id: 's1',
        type: 'postgres' as const,
        name: 'db',
        state: 'creating' as const,
        credentials: { url: '', env: {} },
      })),
      listServices: vi.fn(async () => []),
      destroyService: vi.fn(async () => {}),
    })
    const provider = createProvider(adapter)
    await expect(
      provider.create({ image: 'node:22', services: [{ id: 's1' }] }),
    ).rejects.toThrow('not ready')
  })

  it('throws CapabilityNotSupportedError when services bound but adapter has no getService', async () => {
    const adapter = mockAdapter({
      // No getService — should throw, not silently skip
    })
    const provider = createProvider(adapter)
    await expect(
      provider.create({
        image: 'node:22',
        services: [{ id: 's1' }],
      }),
    ).rejects.toThrow("Capability 'services' is not supported")
  })

  it('last service binding wins when credential keys collide without envPrefix', async () => {
    const createSandbox = vi.fn(async () => mockAdapterSandbox())
    let callCount = 0
    const adapter = mockAdapter({
      capabilities: new Set<Capability>(['services']),
      createSandbox,
      createService: vi.fn(),
      getService: vi.fn(async (id: string) => ({
        id,
        type: 'postgres' as const,
        name: id,
        state: 'ready' as const,
        credentials: {
          url: `postgres://${id}`,
          env: { DATABASE_URL: `postgres://${id}` },
        },
      })),
      listServices: vi.fn(async () => []),
      destroyService: vi.fn(async () => {}),
    })
    const provider = createProvider(adapter)
    await provider.create({
      image: 'node:22',
      services: [{ id: 's1' }, { id: 's2' }],
    })
    // s2 should overwrite s1's DATABASE_URL
    expect(createSandbox).toHaveBeenCalledWith(
      expect.objectContaining({
        env: { DATABASE_URL: 'postgres://s2' },
      }),
    )
  })

  it('exposes both volume and service methods when adapter declares both capabilities', () => {
    const adapter = mockAdapter({
      capabilities: new Set<Capability>(['volumes', 'services']),
      createVolume: vi.fn(async () => ({ id: 'v1', name: 'vol', sizeGB: 1, attachedTo: null })),
      deleteVolume: vi.fn(async () => {}),
      listVolumes: vi.fn(async () => []),
      createService: vi.fn(async () => ({ id: 's1', type: 'postgres' as const, name: 'db', state: 'ready' as const, credentials: { url: '', env: {} } })),
      getService: vi.fn(async () => ({ id: 's1', type: 'postgres' as const, name: 'db', state: 'ready' as const, credentials: { url: '', env: {} } })),
      listServices: vi.fn(async () => []),
      destroyService: vi.fn(async () => {}),
    })
    const provider = createProvider(adapter) as any
    // Both volume AND service methods should be present
    expect(typeof provider.createVolume).toBe('function')
    expect(typeof provider.deleteVolume).toBe('function')
    expect(typeof provider.listVolumes).toBe('function')
    expect(typeof provider.createService).toBe('function')
    expect(typeof provider.getService).toBe('function')
    expect(typeof provider.listServices).toBe('function')
    expect(typeof provider.destroyService).toBe('function')
  })

  it('calls destroySandbox when skill injection fails', async () => {
    const destroySandbox = vi.fn(async () => {})
    const execFn = vi.fn(async () => ({ exitCode: 0, stdout: '', stderr: '' }))
    // writeFile will throw to simulate skill injection failure
    const writeFile = vi.fn(async () => { throw new Error('write failed') })
    const adapter = mockAdapter({
      createSandbox: async () => mockAdapterSandbox({ exec: execFn, writeFile }),
      destroySandbox,
    })
    const provider = createProvider(adapter)
    await expect(
      provider.create({
        image: 'node:22',
        skills: [{ name: 'test', content: 'hello' }],
      }),
    ).rejects.toThrow('write failed')
    expect(destroySandbox).toHaveBeenCalledWith('sb-mock')
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

describe('createProvider with observer', () => {
  it('emits sandbox:exec event on exec()', async () => {
    const events: SandboxEvent[] = []
    const observer: SandboxObserver = { onEvent: (e) => { events.push(e) } }
    const adapter = mockAdapter()
    const provider = createProvider(adapter, { observer })
    const sandbox = await provider.create({ image: 'node:22' })

    await sandbox.exec('echo hi')

    expect(events).toHaveLength(1)
    expect(events[0]!.type).toBe('sandbox:exec')
    expect(events[0]!.sandboxId).toBe('sb-mock')
    expect(events[0]!.data.command).toBe('echo hi')
    expect(events[0]!.data.exitCode).toBe(0)
    expect(typeof events[0]!.data.duration).toBe('number')
  })

  it('emits sandbox:exec event with error info on exec failure', async () => {
    const events: SandboxEvent[] = []
    const observer: SandboxObserver = { onEvent: (e) => { events.push(e) } }
    const adapter = mockAdapter({
      createSandbox: async () => mockAdapterSandbox({
        exec: vi.fn(async () => { throw new Error('command failed') }),
      }),
    })
    const provider = createProvider(adapter, { observer })
    const sandbox = await provider.create({ image: 'node:22' })

    await expect(sandbox.exec('bad cmd')).rejects.toThrow('command failed')

    expect(events).toHaveLength(1)
    expect(events[0]!.data.error).toBe('command failed')
    expect(events[0]!.data.command).toBe('bad cmd')
  })

  it('emits sandbox:writeFile event', async () => {
    const events: SandboxEvent[] = []
    const observer: SandboxObserver = { onEvent: (e) => { events.push(e) } }
    const nativeWrite = vi.fn(async () => {})
    const adapter = mockAdapter({
      createSandbox: async () => mockAdapterSandbox({ writeFile: nativeWrite }),
    })
    const provider = createProvider(adapter, { observer })
    const sandbox = await provider.create({ image: 'node:22' })

    await sandbox.writeFile('/tmp/test.txt', 'hello world')

    expect(events).toHaveLength(1)
    expect(events[0]!.type).toBe('sandbox:writeFile')
    expect(events[0]!.data.path).toBe('/tmp/test.txt')
    expect(events[0]!.data.size).toBe(11)
  })

  it('emits sandbox:readFile event', async () => {
    const events: SandboxEvent[] = []
    const observer: SandboxObserver = { onEvent: (e) => { events.push(e) } }
    const nativeRead = vi.fn(async () => new Uint8Array([1, 2, 3]))
    const adapter = mockAdapter({
      createSandbox: async () => mockAdapterSandbox({ readFile: nativeRead }),
    })
    const provider = createProvider(adapter, { observer })
    const sandbox = await provider.create({ image: 'node:22' })

    await sandbox.readFile('/tmp/data.bin')

    expect(events).toHaveLength(1)
    expect(events[0]!.type).toBe('sandbox:readFile')
    expect(events[0]!.data.path).toBe('/tmp/data.bin')
    expect(events[0]!.data.size).toBe(3)
  })

  it('emits sandbox:uploadArchive event', async () => {
    const events: SandboxEvent[] = []
    const observer: SandboxObserver = { onEvent: (e) => { events.push(e) } }
    const nativeUpload = vi.fn(async () => {})
    const adapter = mockAdapter({
      createSandbox: async () => mockAdapterSandbox({ uploadArchive: nativeUpload }),
    })
    const provider = createProvider(adapter, { observer })
    const sandbox = await provider.create({ image: 'node:22' })

    await sandbox.uploadArchive(new Uint8Array([1]), '/workspace')

    expect(events).toHaveLength(1)
    expect(events[0]!.type).toBe('sandbox:uploadArchive')
    expect(events[0]!.data.destDir).toBe('/workspace')
  })

  it('emits sandbox:downloadArchive event', async () => {
    const events: SandboxEvent[] = []
    const observer: SandboxObserver = { onEvent: (e) => { events.push(e) } }
    const nativeDownload = vi.fn(async () => new ReadableStream())
    const adapter = mockAdapter({
      createSandbox: async () => mockAdapterSandbox({ downloadArchive: nativeDownload }),
    })
    const provider = createProvider(adapter, { observer })
    const sandbox = await provider.create({ image: 'node:22' })

    await sandbox.downloadArchive('/src')

    expect(events).toHaveLength(1)
    expect(events[0]!.type).toBe('sandbox:downloadArchive')
    expect(events[0]!.data.srcDir).toBe('/src')
  })

  it('attaches taskId from options to all events', async () => {
    const events: SandboxEvent[] = []
    const observer: SandboxObserver = { onEvent: (e) => { events.push(e) } }
    const nativeWrite = vi.fn(async () => {})
    const adapter = mockAdapter({
      createSandbox: async () => mockAdapterSandbox({ writeFile: nativeWrite }),
    })
    const provider = createProvider(adapter, { observer, taskId: 'task-42' })
    const sandbox = await provider.create({ image: 'node:22' })

    await sandbox.exec('ls')
    await sandbox.writeFile('/a', 'b')

    expect(events).toHaveLength(2)
    expect(events[0]!.taskId).toBe('task-42')
    expect(events[1]!.taskId).toBe('task-42')
  })

  it('does not emit events when no observer is set', async () => {
    // Just ensure no errors when observer is undefined
    const adapter = mockAdapter()
    const provider = createProvider(adapter)
    const sandbox = await provider.create({ image: 'node:22' })
    await sandbox.exec('echo hi')
    // No assertion needed — just no crash
  })

  it('observer errors do not break sandbox operations', async () => {
    const observer: SandboxObserver = {
      onEvent() { throw new Error('observer boom') },
    }
    const adapter = mockAdapter()
    const provider = createProvider(adapter, { observer })
    const sandbox = await provider.create({ image: 'node:22' })

    const result = await sandbox.exec('echo hi')
    expect(result.stdout).toBe('hello')
  })

  it('observer applies to sandbox from get()', async () => {
    const events: SandboxEvent[] = []
    const observer: SandboxObserver = { onEvent: (e) => { events.push(e) } }
    const adapter = mockAdapter()
    const provider = createProvider(adapter, { observer })
    const sandbox = await provider.get('sb-mock')

    await sandbox.exec('echo hi')

    expect(events).toHaveLength(1)
    expect(events[0]!.type).toBe('sandbox:exec')
  })

  it('writeFile emits size for Uint8Array content', async () => {
    const events: SandboxEvent[] = []
    const observer: SandboxObserver = { onEvent: (e) => { events.push(e) } }
    const nativeWrite = vi.fn(async () => {})
    const adapter = mockAdapter({
      createSandbox: async () => mockAdapterSandbox({ writeFile: nativeWrite }),
    })
    const provider = createProvider(adapter, { observer })
    const sandbox = await provider.create({ image: 'node:22' })

    await sandbox.writeFile('/bin', new Uint8Array([1, 2, 3, 4, 5]))

    expect(events[0]!.data.size).toBe(5)
  })

  it('uploadArchive defaults destDir to /', async () => {
    const events: SandboxEvent[] = []
    const observer: SandboxObserver = { onEvent: (e) => { events.push(e) } }
    const nativeUpload = vi.fn(async () => {})
    const adapter = mockAdapter({
      createSandbox: async () => mockAdapterSandbox({ uploadArchive: nativeUpload }),
    })
    const provider = createProvider(adapter, { observer })
    const sandbox = await provider.create({ image: 'node:22' })

    await sandbox.uploadArchive(new Uint8Array([1]))

    expect(events[0]!.data.destDir).toBe('/')
  })

  it('downloadArchive defaults srcDir to /', async () => {
    const events: SandboxEvent[] = []
    const observer: SandboxObserver = { onEvent: (e) => { events.push(e) } }
    const nativeDownload = vi.fn(async () => new ReadableStream())
    const adapter = mockAdapter({
      createSandbox: async () => mockAdapterSandbox({ downloadArchive: nativeDownload }),
    })
    const provider = createProvider(adapter, { observer })
    const sandbox = await provider.create({ image: 'node:22' })

    await sandbox.downloadArchive()

    expect(events[0]!.data.srcDir).toBe('/')
  })
})

describe('createProvider with user', () => {
  it('sets up non-root user and wraps exec', async () => {
    const execFn = vi.fn(async (cmd: string) => {
      // setupSandboxUser calls
      if (cmd.startsWith('id ') || cmd.includes('useradd')) return { exitCode: 0, stdout: '', stderr: '' }
      if (cmd.startsWith('eval echo ~')) return { exitCode: 0, stdout: '/home/sandbank\n', stderr: '' }
      if (cmd.includes('sudoers.d/')) return { exitCode: 0, stdout: '', stderr: '' }
      // actual exec call (wrapped)
      return { exitCode: 0, stdout: 'sandbank\n', stderr: '' }
    })
    const adapter = mockAdapter({
      createSandbox: async () => mockAdapterSandbox({ exec: execFn }),
    })
    const provider = createProvider(adapter)
    const sandbox = await provider.create({ image: 'node:22', user: 'sandbank' })

    expect(sandbox.user).toEqual({ name: 'sandbank', home: '/home/sandbank' })

    await sandbox.exec('whoami')
    // Last exec call should be wrapped with su
    const lastCall = execFn.mock.calls[execFn.mock.calls.length - 1]!
    expect(lastCall[0]).toBe("su - sandbank -c 'whoami'")
  })

  it('exec with asRoot skips user wrapping', async () => {
    const execFn = vi.fn(async (cmd: string) => {
      if (cmd.startsWith('id ') || cmd.includes('useradd')) return { exitCode: 0, stdout: '', stderr: '' }
      if (cmd.startsWith('eval echo ~')) return { exitCode: 0, stdout: '/home/sandbank\n', stderr: '' }
      if (cmd.includes('sudoers.d/')) return { exitCode: 0, stdout: '', stderr: '' }
      return { exitCode: 0, stdout: '', stderr: '' }
    })
    const adapter = mockAdapter({
      createSandbox: async () => mockAdapterSandbox({ exec: execFn }),
    })
    const provider = createProvider(adapter)
    const sandbox = await provider.create({ image: 'node:22', user: 'sandbank' })

    await sandbox.exec('apt-get install -y git', { asRoot: true })
    const lastCall = execFn.mock.calls[execFn.mock.calls.length - 1]!
    expect(lastCall[0]).toBe('apt-get install -y git')
  })

  it('exec with cwd includes cd in wrapped command', async () => {
    const execFn = vi.fn(async (cmd: string) => {
      if (cmd.startsWith('id ') || cmd.includes('useradd')) return { exitCode: 0, stdout: '', stderr: '' }
      if (cmd.startsWith('eval echo ~')) return { exitCode: 0, stdout: '/home/sandbank\n', stderr: '' }
      if (cmd.includes('sudoers.d/')) return { exitCode: 0, stdout: '', stderr: '' }
      return { exitCode: 0, stdout: '', stderr: '' }
    })
    const adapter = mockAdapter({
      createSandbox: async () => mockAdapterSandbox({ exec: execFn }),
    })
    const provider = createProvider(adapter)
    const sandbox = await provider.create({ image: 'node:22', user: 'sandbank' })

    await sandbox.exec('ls', { cwd: '/workspace' })
    const lastCall = execFn.mock.calls[execFn.mock.calls.length - 1]!
    expect(lastCall[0]).toBe('su - sandbank -c \'cd "/workspace" && ls\'')
    // cwd should not be passed to adapter (already in wrapped command)
    expect(lastCall[1]?.cwd).toBeUndefined()
  })

  it('sandbox.user is undefined when no user configured', async () => {
    const adapter = mockAdapter()
    const provider = createProvider(adapter)
    const sandbox = await provider.create({ image: 'node:22' })
    expect(sandbox.user).toBeUndefined()
  })

  it('supports string shorthand for user config', async () => {
    const execFn = vi.fn(async (cmd: string) => {
      if (cmd.startsWith('id ') || cmd.includes('useradd')) return { exitCode: 0, stdout: '', stderr: '' }
      if (cmd.startsWith('eval echo ~')) return { exitCode: 0, stdout: '/home/claude\n', stderr: '' }
      if (cmd.includes('sudoers.d/')) return { exitCode: 0, stdout: '', stderr: '' }
      return { exitCode: 0, stdout: '', stderr: '' }
    })
    const adapter = mockAdapter({
      createSandbox: async () => mockAdapterSandbox({ exec: execFn }),
    })
    const provider = createProvider(adapter)
    const sandbox = await provider.create({ image: 'node:22', user: 'claude' })
    expect(sandbox.user).toEqual({ name: 'claude', home: '/home/claude' })
  })
})
