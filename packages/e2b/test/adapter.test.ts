import { describe, it, expect, vi, beforeEach } from 'vitest'
import { ProviderError, SandboxNotFoundError } from '@sandbank.dev/core'

const mocks = vi.hoisted(() => {
  class MockCommandExitError extends Error {
    exitCode: number
    stdout: string
    stderr: string
    error?: string

    constructor(result: { exitCode: number; stdout: string; stderr: string; error?: string }) {
      super(result.error)
      this.name = 'CommandExitError'
      this.exitCode = result.exitCode
      this.stdout = result.stdout
      this.stderr = result.stderr
      this.error = result.error
    }
  }

  class MockNotFoundError extends Error {}
  class MockSandboxNotFoundError extends MockNotFoundError {}

  const Sandbox = {
    create: vi.fn(),
    connect: vi.fn(),
    list: vi.fn(),
    kill: vi.fn(),
    getInfo: vi.fn(),
  }

  const Volume = {
    create: vi.fn(),
    connect: vi.fn(),
    list: vi.fn(),
    destroy: vi.fn(),
  }

  return {
    CommandExitError: MockCommandExitError,
    NotFoundError: MockNotFoundError,
    SandboxNotFoundError: MockSandboxNotFoundError,
    Sandbox,
    Volume,
  }
})

vi.mock('e2b', () => mocks)

import { E2BAdapter } from '../src/index.js'

function makeInfo(overrides?: Record<string, unknown>) {
  return {
    sandboxId: 'sbx-1',
    templateId: 'base',
    metadata: {},
    startedAt: new Date('2026-01-01T00:00:00Z'),
    endAt: new Date('2026-01-01T00:05:00Z'),
    state: 'running',
    cpuCount: 1,
    memoryMB: 512,
    envdVersion: '1.0.0',
    volumeMounts: [],
    ...overrides,
  }
}

function makeSandbox(overrides?: Record<string, unknown>) {
  return {
    sandboxId: 'sbx-1',
    commands: {
      run: vi.fn().mockResolvedValue({ exitCode: 0, stdout: '', stderr: '' }),
    },
    files: {
      write: vi.fn().mockResolvedValue({}),
      read: vi.fn().mockResolvedValue(new Uint8Array([104, 105])),
    },
    pause: vi.fn().mockResolvedValue(true),
    getInfo: vi.fn().mockResolvedValue(makeInfo()),
    getHost: vi.fn((port: number) => `${port}-sbx-1.e2b.dev`),
    ...overrides,
  }
}

function makePaginator(items: unknown[]) {
  let consumed = false
  return {
    get hasNext() {
      return !consumed
    },
    nextItems: vi.fn(async () => {
      consumed = true
      return items
    }),
  }
}

function runResult(overrides?: Partial<{ exitCode: number; stdout: string; stderr: string }>) {
  return {
    exitCode: 0,
    stdout: '',
    stderr: '',
    ...overrides,
  }
}

describe('E2BAdapter', () => {
  beforeEach(() => {
    vi.clearAllMocks()
    mocks.Sandbox.create.mockResolvedValue(makeSandbox())
    mocks.Sandbox.connect.mockResolvedValue(makeSandbox())
    mocks.Sandbox.list.mockReturnValue(makePaginator([]))
    mocks.Sandbox.kill.mockResolvedValue(true)
    mocks.Sandbox.getInfo.mockResolvedValue(makeInfo())
    mocks.Volume.create.mockResolvedValue({ volumeId: 'vol-1', name: 'data' })
    mocks.Volume.connect.mockResolvedValue({ volumeId: 'vol-1', name: 'data' })
    mocks.Volume.list.mockResolvedValue([])
    mocks.Volume.destroy.mockResolvedValue(true)
  })

  describe('identity', () => {
    it('should have name e2b and persistence-related capabilities', () => {
      const adapter = new E2BAdapter()

      expect(adapter.name).toBe('e2b')
      expect(adapter.capabilities).toEqual(new Set(['terminal', 'volumes', 'sleep', 'port.expose']))
    })

    it('should not claim snapshot support', () => {
      const adapter = new E2BAdapter()

      expect(adapter.capabilities.has('snapshot')).toBe(false)
    })
  })

  describe('createSandbox', () => {
    it('should create from the configured template and map env/timeouts', async () => {
      const adapter = new E2BAdapter({ apiKey: 'test-key', defaultTimeoutMs: 3_600_000 })

      const sandbox = await adapter.createSandbox({
        image: 'node-template',
        env: { FOO: 'bar' },
        timeout: 10,
      })

      expect(mocks.Sandbox.create).toHaveBeenCalledWith('node-template', expect.objectContaining({
        apiKey: 'test-key',
        envs: { FOO: 'bar' },
        requestTimeoutMs: 10_000,
        timeoutMs: 3_600_000,
        lifecycle: { onTimeout: 'pause', autoResume: true },
      }))
      expect(sandbox.id).toBe('sbx-1')
      expect(sandbox.state).toBe('running')
      expect(sandbox.createdAt).toBe('2026-01-01T00:00:00.000Z')
    })

    it('should use kill lifecycle when autoDestroyMinutes is set', async () => {
      const adapter = new E2BAdapter()

      await adapter.createSandbox({ autoDestroyMinutes: 15 })

      expect(mocks.Sandbox.create).toHaveBeenCalledWith(expect.objectContaining({
        timeoutMs: 900_000,
        lifecycle: { onTimeout: 'kill' },
      }))
    })

    it('should use configured template and connection options when image is omitted', async () => {
      const e2bSandbox = makeSandbox()
      mocks.Sandbox.create.mockResolvedValue(e2bSandbox)
      const adapter = new E2BAdapter({
        apiKey: 'test-key',
        domain: 'sandbox.example',
        requestTimeoutMs: 12_345,
        template: 'configured-template',
        debug: true,
      })

      await adapter.createSandbox({})

      expect(mocks.Sandbox.create).toHaveBeenCalledWith('configured-template', expect.objectContaining({
        apiKey: 'test-key',
        domain: 'sandbox.example',
        requestTimeoutMs: 12_345,
        debug: true,
      }))
      expect(e2bSandbox.getInfo).toHaveBeenCalledWith({ requestTimeoutMs: 12_345 })
    })

    it('should connect volumes by id and mount them by path', async () => {
      const volume = { volumeId: 'vol-1', name: 'data' }
      mocks.Volume.connect.mockResolvedValue(volume)
      const adapter = new E2BAdapter()

      await adapter.createSandbox({
        volumes: [{ id: 'vol-1', mountPath: '/mnt/data' }],
      })

      expect(mocks.Volume.connect).toHaveBeenCalledWith('vol-1', expect.any(Object))
      expect(mocks.Sandbox.create).toHaveBeenCalledWith(expect.objectContaining({
        volumeMounts: { '/mnt/data': volume },
      }))
    })

    it('should wrap SDK errors in ProviderError', async () => {
      mocks.Sandbox.create.mockRejectedValue(new Error('boom'))
      const adapter = new E2BAdapter()

      await expect(adapter.createSandbox({})).rejects.toThrow(ProviderError)
    })
  })

  describe('getSandbox', () => {
    it('should connect to an existing sandbox', async () => {
      const adapter = new E2BAdapter()

      const sandbox = await adapter.getSandbox('sbx-1')

      expect(mocks.Sandbox.connect).toHaveBeenCalledWith('sbx-1', expect.any(Object))
      expect(sandbox.id).toBe('sbx-1')
    })

    it('should throw SandboxNotFoundError on E2B not found', async () => {
      mocks.Sandbox.connect.mockRejectedValue(new mocks.SandboxNotFoundError('missing'))
      const adapter = new E2BAdapter()

      await expect(adapter.getSandbox('missing')).rejects.toThrow(SandboxNotFoundError)
    })

    it('should treat SDK 404 messages as not found', async () => {
      mocks.Sandbox.connect.mockRejectedValue(new Error('404 Not Found'))
      const adapter = new E2BAdapter()

      await expect(adapter.getSandbox('missing')).rejects.toThrow(SandboxNotFoundError)
    })

    it('should wrap non-not-found connect errors', async () => {
      mocks.Sandbox.connect.mockRejectedValue(new Error('network down'))
      const adapter = new E2BAdapter()

      await expect(adapter.getSandbox('sbx-1')).rejects.toThrow(ProviderError)
    })
  })

  describe('listSandboxes', () => {
    it('should map E2B running and paused states', async () => {
      mocks.Sandbox.list.mockReturnValue(makePaginator([
        makeInfo({ sandboxId: 'sbx-1', state: 'running' }),
        makeInfo({ sandboxId: 'sbx-2', state: 'paused' }),
      ]))
      const adapter = new E2BAdapter()

      const list = await adapter.listSandboxes()

      expect(list).toEqual([
        { id: 'sbx-1', state: 'running', createdAt: '2026-01-01T00:00:00.000Z', image: 'base' },
        { id: 'sbx-2', state: 'stopped', createdAt: '2026-01-01T00:00:00.000Z', image: 'base' },
      ])
    })

    it('should map stopped filter to E2B paused query', async () => {
      const adapter = new E2BAdapter()

      await adapter.listSandboxes({ state: 'stopped', limit: 5 })

      expect(mocks.Sandbox.list).toHaveBeenCalledWith(expect.objectContaining({
        limit: 5,
        query: { state: ['paused'] },
      }))
    })

    it('should return empty list for unsupported state filters', async () => {
      const adapter = new E2BAdapter()

      const list = await adapter.listSandboxes({ state: 'terminated' })

      expect(list).toEqual([])
      expect(mocks.Sandbox.list).not.toHaveBeenCalled()
    })

    it('should map running filters to E2B running queries', async () => {
      const adapter = new E2BAdapter()

      await adapter.listSandboxes({ state: 'running' })

      expect(mocks.Sandbox.list).toHaveBeenCalledWith(expect.objectContaining({
        query: { state: ['running'] },
      }))
    })

    it('should map combined running and stopped filters', async () => {
      const adapter = new E2BAdapter()

      await adapter.listSandboxes({ state: ['running', 'stopped'] })

      expect(mocks.Sandbox.list).toHaveBeenCalledWith(expect.objectContaining({
        query: { state: ['running', 'paused'] },
      }))
    })

    it('should slice oversized pages to the requested limit', async () => {
      mocks.Sandbox.list.mockReturnValue(makePaginator([
        makeInfo({ sandboxId: 'sbx-1', startedAt: '2026-01-01T00:00:00Z' }),
        makeInfo({ sandboxId: 'sbx-2', startedAt: 1767225600000 }),
        makeInfo({ sandboxId: 'sbx-3' }),
      ]))
      const adapter = new E2BAdapter()

      const list = await adapter.listSandboxes({ limit: 2 })

      expect(list).toEqual([
        { id: 'sbx-1', state: 'running', createdAt: '2026-01-01T00:00:00.000Z', image: 'base' },
        { id: 'sbx-2', state: 'running', createdAt: '2026-01-01T00:00:00.000Z', image: 'base' },
      ])
    })

    it('should wrap list errors', async () => {
      mocks.Sandbox.list.mockImplementation(() => {
        throw new Error('list failed')
      })
      const adapter = new E2BAdapter()

      await expect(adapter.listSandboxes()).rejects.toThrow(ProviderError)
    })
  })

  describe('sandbox operations', () => {
    it('should return non-zero command results instead of throwing', async () => {
      const e2bSandbox = makeSandbox()
      e2bSandbox.commands.run.mockRejectedValue(new mocks.CommandExitError({
        exitCode: 7,
        stdout: 'out',
        stderr: 'err',
      }))
      mocks.Sandbox.create.mockResolvedValue(e2bSandbox)
      const adapter = new E2BAdapter()
      const sandbox = await adapter.createSandbox({})

      const result = await sandbox.exec('exit 7')

      expect(result).toEqual({ exitCode: 7, stdout: 'out', stderr: 'err' })
    })

    it('should return structural non-zero command results', async () => {
      const e2bSandbox = makeSandbox()
      e2bSandbox.commands.run.mockRejectedValue({ exitCode: 2, stdout: 'out', stderr: 'err' })
      mocks.Sandbox.create.mockResolvedValue(e2bSandbox)
      const adapter = new E2BAdapter()
      const sandbox = await adapter.createSandbox({})

      const result = await sandbox.exec('exit 2')

      expect(result).toEqual({ exitCode: 2, stdout: 'out', stderr: 'err' })
    })

    it('should rethrow non-command execution errors', async () => {
      const e2bSandbox = makeSandbox()
      e2bSandbox.commands.run.mockRejectedValue(new Error('exec failed'))
      mocks.Sandbox.create.mockResolvedValue(e2bSandbox)
      const adapter = new E2BAdapter()
      const sandbox = await adapter.createSandbox({})

      await expect(sandbox.exec('boom')).rejects.toThrow('exec failed')
    })

    it('should pass cwd and timeout to E2B commands', async () => {
      const e2bSandbox = makeSandbox()
      mocks.Sandbox.create.mockResolvedValue(e2bSandbox)
      const adapter = new E2BAdapter()
      const sandbox = await adapter.createSandbox({})

      await sandbox.exec('pwd', { cwd: '/app', timeout: 12_000 })

      expect(e2bSandbox.commands.run).toHaveBeenCalledWith('pwd', {
        cwd: '/app',
        timeoutMs: 12_000,
      })
    })

    it('should use native file APIs', async () => {
      const e2bSandbox = makeSandbox()
      mocks.Sandbox.create.mockResolvedValue(e2bSandbox)
      const adapter = new E2BAdapter()
      const sandbox = await adapter.createSandbox({})

      await sandbox.writeFile('/tmp/a.txt', 'hello')
      const data = await sandbox.readFile('/tmp/a.txt')

      expect(e2bSandbox.files.write).toHaveBeenCalledWith('/tmp/a.txt', 'hello')
      expect(e2bSandbox.files.read).toHaveBeenCalledWith('/tmp/a.txt', { format: 'bytes' })
      expect(new TextDecoder().decode(data)).toBe('hi')
    })

    it('should write binary files using ArrayBuffer content', async () => {
      const e2bSandbox = makeSandbox()
      mocks.Sandbox.create.mockResolvedValue(e2bSandbox)
      const adapter = new E2BAdapter()
      const sandbox = await adapter.createSandbox({})

      await sandbox.writeFile('/tmp/a.bin', new Uint8Array([1, 2, 3]))

      const written = e2bSandbox.files.write.mock.calls[0][1]
      expect(written).toBeInstanceOf(ArrayBuffer)
      expect([...new Uint8Array(written)]).toEqual([1, 2, 3])
    })

    it('should expose ports using E2B hostnames', async () => {
      const adapter = new E2BAdapter()
      const sandbox = await adapter.createSandbox({})

      const exposed = await sandbox.exposePort!(3000)

      expect(exposed).toEqual({ url: 'https://3000-sbx-1.e2b.dev' })
    })

    it('should expose insecure URLs when SDK debug mode is enabled', async () => {
      const adapter = new E2BAdapter({ debug: true })
      const sandbox = await adapter.createSandbox({})

      const exposed = await sandbox.exposePort!(3000)

      expect(exposed).toEqual({ url: 'http://3000-sbx-1.e2b.dev' })
    })

    it('should pause and resume sandboxes for sleep/wake', async () => {
      const e2bSandbox = makeSandbox()
      mocks.Sandbox.create.mockResolvedValue(e2bSandbox)
      mocks.Sandbox.connect.mockResolvedValue(makeSandbox())
      const adapter = new E2BAdapter()
      const sandbox = await adapter.createSandbox({})

      await sandbox.sleep!()
      expect(e2bSandbox.pause).toHaveBeenCalled()
      expect(sandbox.state).toBe('stopped')

      await sandbox.wake!()
      expect(mocks.Sandbox.connect).toHaveBeenCalledWith('sbx-1', expect.any(Object))
      expect(sandbox.state).toBe('running')
    })

    it('should start ttyd when it is already installed', async () => {
      const e2bSandbox = makeSandbox({
        commands: {
          run: vi.fn()
            .mockResolvedValueOnce(runResult())
            .mockResolvedValueOnce(runResult())
            .mockResolvedValueOnce(runResult()),
        },
      })
      mocks.Sandbox.create.mockResolvedValue(e2bSandbox)
      const adapter = new E2BAdapter()
      const sandbox = await adapter.createSandbox({})

      const terminal = await sandbox.startTerminal!()

      expect(terminal).toEqual({ url: 'wss://7681-sbx-1.e2b.dev/ws', port: 7681 })
      expect(e2bSandbox.commands.run).toHaveBeenCalledTimes(3)
      expect(e2bSandbox.commands.run).toHaveBeenNthCalledWith(
        2,
        expect.stringContaining('nohup "$TTYD_BIN" -W -p 7681 \'/bin/bash\''),
        { cwd: undefined, timeoutMs: undefined },
      )
    })

    it('should install ttyd and quote custom terminal shells', async () => {
      const e2bSandbox = makeSandbox({
        commands: {
          run: vi.fn()
            .mockResolvedValueOnce(runResult({ exitCode: 1 }))
            .mockResolvedValueOnce(runResult())
            .mockResolvedValueOnce(runResult())
            .mockResolvedValueOnce(runResult()),
        },
      })
      mocks.Sandbox.create.mockResolvedValue(e2bSandbox)
      const adapter = new E2BAdapter({ debug: true })
      const sandbox = await adapter.createSandbox({})

      const terminal = await sandbox.startTerminal!({ shell: "/bin/echo 'hello'" })

      const installCommand = e2bSandbox.commands.run.mock.calls[1][0]
      const startCommand = e2bSandbox.commands.run.mock.calls[2][0]
      expect(terminal).toEqual({ url: 'ws://7681-sbx-1.e2b.dev/ws', port: 7681 })
      expect(installCommand).toContain('TTYD_URL="https://github.com/tsl0922/ttyd/releases/download/1.7.7/ttyd.$ARCH"')
      expect(startCommand).toContain("'/bin/echo '\\''hello'\\'''")
    })

    it('should throw when ttyd fails to start', async () => {
      const e2bSandbox = makeSandbox({
        commands: {
          run: vi.fn()
            .mockResolvedValueOnce(runResult())
            .mockResolvedValueOnce(runResult({ exitCode: 3, stdout: 'start failed' })),
        },
      })
      mocks.Sandbox.create.mockResolvedValue(e2bSandbox)
      const adapter = new E2BAdapter()
      const sandbox = await adapter.createSandbox({})

      await expect(sandbox.startTerminal!()).rejects.toThrow(
        'Starting ttyd failed with exit code 3: start failed',
      )
    })
  })

  describe('volumes', () => {
    it('should create E2B volumes', async () => {
      const adapter = new E2BAdapter()

      const volume = await adapter.createVolume!({ name: 'data', sizeGB: 10 })

      expect(mocks.Volume.create).toHaveBeenCalledWith('data', expect.any(Object))
      expect(volume).toEqual({ id: 'vol-1', name: 'data', sizeGB: 10, attachedTo: null })
    })

    it('should default volume size when omitted', async () => {
      const adapter = new E2BAdapter()

      const volume = await adapter.createVolume!({ name: 'data' })

      expect(volume).toEqual({ id: 'vol-1', name: 'data', sizeGB: 1, attachedTo: null })
    })

    it('should wrap create volume errors', async () => {
      mocks.Volume.create.mockRejectedValue(new Error('volume failed'))
      const adapter = new E2BAdapter()

      await expect(adapter.createVolume!({ name: 'data' })).rejects.toThrow(ProviderError)
    })

    it('should delete volumes idempotently', async () => {
      mocks.Volume.destroy.mockRejectedValue(new mocks.NotFoundError('missing'))
      const adapter = new E2BAdapter()

      await expect(adapter.deleteVolume!('vol-missing')).resolves.toBeUndefined()
    })

    it('should ignore string not-found volume delete errors', async () => {
      mocks.Volume.destroy.mockRejectedValue('404 missing')
      const adapter = new E2BAdapter()

      await expect(adapter.deleteVolume!('vol-missing')).resolves.toBeUndefined()
    })

    it('should wrap delete volume errors', async () => {
      mocks.Volume.destroy.mockRejectedValue(new Error('delete failed'))
      const adapter = new E2BAdapter()

      await expect(adapter.deleteVolume!('vol-1')).rejects.toThrow(ProviderError)
    })

    it('should list volumes and mark attached sandbox by mounted volume name', async () => {
      mocks.Volume.list.mockResolvedValue([{ volumeId: 'vol-1', name: 'data' }])
      mocks.Sandbox.list.mockReturnValue(makePaginator([
        makeInfo({ sandboxId: 'sbx-1', state: 'running' }),
      ]))
      mocks.Sandbox.getInfo.mockResolvedValue(makeInfo({
        sandboxId: 'sbx-1',
        volumeMounts: [{ name: 'data', path: '/mnt/data' }],
      }))
      const adapter = new E2BAdapter()

      const volumes = await adapter.listVolumes!()

      expect(volumes).toEqual([{ id: 'vol-1', name: 'data', sizeGB: 1, attachedTo: 'sbx-1' }])
    })

    it('should list unattached volumes when sandboxes have no mounts', async () => {
      mocks.Volume.list.mockResolvedValue([{ volumeId: 'vol-1', name: 'data' }])
      mocks.Sandbox.list.mockReturnValue(makePaginator([
        makeInfo({ sandboxId: 'sbx-1', state: 'running' }),
      ]))
      mocks.Sandbox.getInfo.mockResolvedValue(makeInfo({
        sandboxId: 'sbx-1',
        volumeMounts: undefined,
      }))
      const adapter = new E2BAdapter()

      const volumes = await adapter.listVolumes!()

      expect(volumes).toEqual([{ id: 'vol-1', name: 'data', sizeGB: 1, attachedTo: null }])
    })

    it('should wrap list volume errors', async () => {
      mocks.Volume.list.mockRejectedValue(new Error('volume list failed'))
      const adapter = new E2BAdapter()

      await expect(adapter.listVolumes!()).rejects.toThrow(ProviderError)
    })
  })

  describe('destroySandbox', () => {
    it('should kill E2B sandbox', async () => {
      const adapter = new E2BAdapter()

      await adapter.destroySandbox('sbx-1')

      expect(mocks.Sandbox.kill).toHaveBeenCalledWith('sbx-1', expect.any(Object))
    })

    it('should ignore not found errors', async () => {
      mocks.Sandbox.kill.mockRejectedValue(new mocks.SandboxNotFoundError('missing'))
      const adapter = new E2BAdapter()

      await expect(adapter.destroySandbox('missing')).resolves.toBeUndefined()
    })

    it('should ignore string not-found destroy errors', async () => {
      mocks.Sandbox.kill.mockRejectedValue('not found')
      const adapter = new E2BAdapter()

      await expect(adapter.destroySandbox('missing')).resolves.toBeUndefined()
    })

    it('should wrap destroy errors', async () => {
      mocks.Sandbox.kill.mockRejectedValue(new Error('destroy failed'))
      const adapter = new E2BAdapter()

      await expect(adapter.destroySandbox('sbx-1')).rejects.toThrow(ProviderError)
    })
  })
})
