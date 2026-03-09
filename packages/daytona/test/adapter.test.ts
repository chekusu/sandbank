import { describe, it, expect, vi, beforeEach } from 'vitest'
import { SandboxNotFoundError, ProviderError } from '@sandbank.dev/core'
import type { DaytonaClient, DaytonaSandboxData, DaytonaVolumeData } from '../src/types.js'

// --- Mock client ---

function freshSandboxData(overrides?: Partial<DaytonaSandboxData>): DaytonaSandboxData {
  return {
    id: 'sb-123',
    state: 'started',
    createdAt: '2026-01-01T00:00:00Z',
    image: 'node:22',
    volumes: [],
    ...overrides,
  }
}

function createMockClient(): DaytonaClient {
  return {
    createSandbox: vi.fn<DaytonaClient['createSandbox']>().mockResolvedValue(freshSandboxData()),
    getSandbox: vi.fn<DaytonaClient['getSandbox']>().mockResolvedValue(freshSandboxData()),
    listSandboxes: vi.fn<DaytonaClient['listSandboxes']>().mockResolvedValue([]),
    deleteSandbox: vi.fn<DaytonaClient['deleteSandbox']>().mockResolvedValue(undefined),
    exec: vi.fn<DaytonaClient['exec']>().mockResolvedValue({ exitCode: 0, stdout: '' }),
    writeFile: vi.fn<DaytonaClient['writeFile']>().mockResolvedValue(undefined),
    readFile: vi.fn<DaytonaClient['readFile']>().mockResolvedValue(new Uint8Array()),
    getPreviewUrl: vi.fn<DaytonaClient['getPreviewUrl']>().mockResolvedValue('https://preview.example.com'),
    createVolume: vi.fn<DaytonaClient['createVolume']>().mockResolvedValue({ id: 'vol-1', name: 'data' }),
    deleteVolume: vi.fn<DaytonaClient['deleteVolume']>().mockResolvedValue(undefined),
    listVolumes: vi.fn<DaytonaClient['listVolumes']>().mockResolvedValue([]),
  }
}

let mockClient: ReturnType<typeof createMockClient>

// Mock the rest-client factory (used for mode: 'rest')
vi.mock('../src/rest-client.js', () => ({
  createDaytonaRestClient: vi.fn(() => mockClient),
}))

// Mock the sdk-client factory (used for mode: 'sdk')
vi.mock('../src/sdk-client.js', () => ({
  createDaytonaSDKClient: vi.fn(async () => mockClient),
}))

import { DaytonaAdapter } from '../src/adapter.js'

function createAdapter(mode: 'sdk' | 'rest' = 'sdk') {
  if (mode === 'rest') {
    return new DaytonaAdapter({
      mode: 'rest',
      apiKey: 'test-key',
      apiUrl: 'https://api.test.com',
    })
  }
  return new DaytonaAdapter({
    apiKey: 'test-key',
    apiUrl: 'https://api.test.com',
    target: 'us',
  })
}

describe('DaytonaAdapter', () => {
  beforeEach(() => {
    vi.clearAllMocks()
    mockClient = createMockClient()
  })

  // --- Identity ---
  describe('identity', () => {
    it('should have name daytona and correct capabilities', () => {
      const adapter = createAdapter()
      expect(adapter.name).toBe('daytona')
      expect(adapter.capabilities).toEqual(new Set(['terminal', 'volumes', 'port.expose']))
    })

    it('should not have exec.stream, snapshot, or sleep capabilities', () => {
      const adapter = createAdapter()
      expect(adapter.capabilities.has('exec.stream' as never)).toBe(false)
      expect(adapter.capabilities.has('snapshot' as never)).toBe(false)
      expect(adapter.capabilities.has('sleep' as never)).toBe(false)
    })
  })

  // --- Mode selection ---
  describe('mode selection', () => {
    it('should use SDK client by default', async () => {
      const adapter = createAdapter('sdk')
      await adapter.createSandbox({ image: 'node:22' })

      const { createDaytonaSDKClient } = await import('../src/sdk-client.js')
      expect(createDaytonaSDKClient).toHaveBeenCalledWith('test-key', 'https://api.test.com', 'us')
    })

    it('should use REST client when mode is rest', async () => {
      const adapter = createAdapter('rest')
      await adapter.createSandbox({ image: 'node:22' })

      const { createDaytonaRestClient } = await import('../src/rest-client.js')
      expect(createDaytonaRestClient).toHaveBeenCalledWith('test-key', 'https://api.test.com')
    })

    it('should cache the client across calls', async () => {
      const adapter = createAdapter('rest')
      await adapter.createSandbox({ image: 'node:22' })
      await adapter.getSandbox('sb-123')

      const { createDaytonaRestClient } = await import('../src/rest-client.js')
      expect(createDaytonaRestClient).toHaveBeenCalledTimes(1)
    })
  })

  // --- createSandbox ---
  describe('createSandbox', () => {
    it('should create sandbox and return AdapterSandbox', async () => {
      const adapter = createAdapter()
      const sandbox = await adapter.createSandbox({ image: 'node:22' })
      expect(sandbox.id).toBe('sb-123')
      expect(sandbox.state).toBe('running')
      expect(sandbox.createdAt).toBe('2026-01-01T00:00:00Z')
      expect(mockClient.createSandbox).toHaveBeenCalled()
    })

    it('should pass config options to client', async () => {
      const adapter = createAdapter()
      await adapter.createSandbox({
        image: 'python:3.12',
        env: { FOO: 'bar' },
        resources: { cpu: 2, memory: 1024, disk: 10 },
        volumes: [{ id: 'vol-1', mountPath: '/data' }],
        autoDestroyMinutes: 30,
        timeout: 60,
      })

      expect(mockClient.createSandbox).toHaveBeenCalledWith({
        image: 'python:3.12',
        envVars: { FOO: 'bar' },
        resources: { cpu: 2, memory: 1024, disk: 10 },
        volumes: [{ volumeId: 'vol-1', mountPath: '/data' }],
        autoDeleteInterval: 30,
        target: 'us',
        timeout: 60,
      })
    })

    it('should not pass timeout option when not set', async () => {
      const adapter = createAdapter()
      await adapter.createSandbox({ image: 'node:22' })
      const call = (mockClient.createSandbox as ReturnType<typeof vi.fn>).mock.calls[0][0]
      expect(call.timeout).toBeUndefined()
    })

    it('should wrap errors in ProviderError', async () => {
      ;(mockClient.createSandbox as ReturnType<typeof vi.fn>).mockRejectedValue(new Error('quota exceeded'))
      const adapter = createAdapter()
      await expect(adapter.createSandbox({ image: 'node:22' })).rejects.toThrow(ProviderError)
    })
  })

  // --- getSandbox ---
  describe('getSandbox', () => {
    it('should return wrapped sandbox', async () => {
      const adapter = createAdapter()
      const sandbox = await adapter.getSandbox('sb-123')
      expect(sandbox.id).toBe('sb-123')
      expect(mockClient.getSandbox).toHaveBeenCalledWith('sb-123')
    })

    it('should throw SandboxNotFoundError on 404', async () => {
      ;(mockClient.getSandbox as ReturnType<typeof vi.fn>).mockRejectedValue(new Error('404 Not Found'))
      const adapter = createAdapter()
      await expect(adapter.getSandbox('missing')).rejects.toThrow(SandboxNotFoundError)
    })

    it('should throw SandboxNotFoundError on "not found"', async () => {
      ;(mockClient.getSandbox as ReturnType<typeof vi.fn>).mockRejectedValue(new Error('resource not found'))
      const adapter = createAdapter()
      await expect(adapter.getSandbox('missing')).rejects.toThrow(SandboxNotFoundError)
    })

    it('should throw ProviderError on other errors', async () => {
      ;(mockClient.getSandbox as ReturnType<typeof vi.fn>).mockRejectedValue(new Error('network error'))
      const adapter = createAdapter()
      await expect(adapter.getSandbox('sb-123')).rejects.toThrow(ProviderError)
    })
  })

  // --- listSandboxes ---
  describe('listSandboxes', () => {
    it('should return mapped sandbox info', async () => {
      ;(mockClient.listSandboxes as ReturnType<typeof vi.fn>).mockResolvedValue([
        freshSandboxData({ id: 'sb-1', state: 'started', createdAt: '2026-01-01', image: 'node:22' }),
        freshSandboxData({ id: 'sb-2', state: 'stopped', createdAt: '2026-01-02', image: 'python:3' }),
      ])

      const adapter = createAdapter()
      const list = await adapter.listSandboxes()
      expect(list).toHaveLength(2)
      expect(list[0].id).toBe('sb-1')
      expect(list[0].state).toBe('running')
      expect(list[1].state).toBe('stopped')
    })

    it('should filter by single state', async () => {
      ;(mockClient.listSandboxes as ReturnType<typeof vi.fn>).mockResolvedValue([
        freshSandboxData({ id: 'sb-1', state: 'started' }),
        freshSandboxData({ id: 'sb-2', state: 'stopped' }),
      ])

      const adapter = createAdapter()
      const list = await adapter.listSandboxes({ state: 'running' })
      expect(list).toHaveLength(1)
      expect(list[0].id).toBe('sb-1')
    })

    it('should filter by array of states', async () => {
      ;(mockClient.listSandboxes as ReturnType<typeof vi.fn>).mockResolvedValue([
        freshSandboxData({ id: 'sb-1', state: 'started' }),
        freshSandboxData({ id: 'sb-2', state: 'stopped' }),
        freshSandboxData({ id: 'sb-3', state: 'error' }),
      ])

      const adapter = createAdapter()
      const list = await adapter.listSandboxes({ state: ['running', 'error'] })
      expect(list).toHaveLength(2)
    })

    it('should pass limit to client', async () => {
      const adapter = createAdapter()
      await adapter.listSandboxes({ limit: 5 })
      expect(mockClient.listSandboxes).toHaveBeenCalledWith(5)
    })

    it('should wrap errors in ProviderError', async () => {
      ;(mockClient.listSandboxes as ReturnType<typeof vi.fn>).mockRejectedValue(new Error('timeout'))
      const adapter = createAdapter()
      await expect(adapter.listSandboxes()).rejects.toThrow(ProviderError)
    })
  })

  // --- destroySandbox ---
  describe('destroySandbox', () => {
    it('should call client.deleteSandbox', async () => {
      const adapter = createAdapter()
      await adapter.destroySandbox('sb-123')
      expect(mockClient.deleteSandbox).toHaveBeenCalledWith('sb-123')
    })

    it('should be idempotent on 404', async () => {
      ;(mockClient.deleteSandbox as ReturnType<typeof vi.fn>).mockRejectedValue(new Error('404 not found'))
      const adapter = createAdapter()
      await expect(adapter.destroySandbox('missing')).resolves.toBeUndefined()
    })

    it('should be idempotent on state transition', async () => {
      ;(mockClient.deleteSandbox as ReturnType<typeof vi.fn>).mockRejectedValue(new Error('state change in progress'))
      const adapter = createAdapter()
      await expect(adapter.destroySandbox('sb-123')).resolves.toBeUndefined()
    })

    it('should be idempotent on destroying', async () => {
      ;(mockClient.deleteSandbox as ReturnType<typeof vi.fn>).mockRejectedValue(new Error('destroying'))
      const adapter = createAdapter()
      await expect(adapter.destroySandbox('sb-123')).resolves.toBeUndefined()
    })

    it('should throw ProviderError on other errors', async () => {
      ;(mockClient.deleteSandbox as ReturnType<typeof vi.fn>).mockRejectedValue(new Error('server error'))
      const adapter = createAdapter()
      await expect(adapter.destroySandbox('sb-123')).rejects.toThrow(ProviderError)
    })
  })

  // --- Wrapped sandbox operations ---
  describe('wrapped sandbox', () => {
    it('exec should call client.exec with sandboxId', async () => {
      ;(mockClient.exec as ReturnType<typeof vi.fn>).mockResolvedValue({ exitCode: 0, stdout: 'hello world' })

      const adapter = createAdapter()
      const sandbox = await adapter.createSandbox({ image: 'node:22' })
      const result = await sandbox.exec('echo hello', { cwd: '/app', timeout: 5000 })

      expect(result.exitCode).toBe(0)
      expect(result.stdout).toBe('hello world')
      expect(result.stderr).toBe('')
      expect(mockClient.exec).toHaveBeenCalledWith('sb-123', 'echo hello', '/app', 5000)
    })

    it('writeFile should call client.writeFile', async () => {
      const adapter = createAdapter()
      const sandbox = await adapter.createSandbox({ image: 'node:22' })
      await sandbox.writeFile!('/app/file.txt', 'content')

      expect(mockClient.writeFile).toHaveBeenCalledWith('sb-123', '/app/file.txt', 'content')
    })

    it('readFile should call client.readFile', async () => {
      const fileContent = new TextEncoder().encode('file content')
      ;(mockClient.readFile as ReturnType<typeof vi.fn>).mockResolvedValue(fileContent)

      const adapter = createAdapter()
      const sandbox = await adapter.createSandbox({ image: 'node:22' })
      const result = await sandbox.readFile!('/app/file.txt')

      expect(result).toBe(fileContent)
      expect(mockClient.readFile).toHaveBeenCalledWith('sb-123', '/app/file.txt')
    })

    it('exposePort should call client.getPreviewUrl and return url', async () => {
      ;(mockClient.getPreviewUrl as ReturnType<typeof vi.fn>).mockResolvedValue('https://preview.example.com')

      const adapter = createAdapter()
      const sandbox = await adapter.createSandbox({ image: 'node:22' })
      const result = await sandbox.exposePort!(3000)

      expect(result.url).toBe('https://preview.example.com')
      expect(mockClient.getPreviewUrl).toHaveBeenCalledWith('sb-123', 3000)
    })

    it('startTerminal should install ttyd if not found', async () => {
      ;(mockClient.exec as ReturnType<typeof vi.fn>)
        .mockResolvedValueOnce({ exitCode: 1, stdout: '' })  // which ttyd → not found
        .mockResolvedValueOnce({ exitCode: 0, stdout: '' })  // install ttyd
        .mockResolvedValueOnce({ exitCode: 0, stdout: '' })  // chmod
        .mockResolvedValueOnce({ exitCode: 0, stdout: '' })  // nohup ttyd
        .mockResolvedValueOnce({ exitCode: 0, stdout: '' })  // wait loop
      ;(mockClient.getPreviewUrl as ReturnType<typeof vi.fn>).mockResolvedValue('https://preview.example.com')

      const adapter = createAdapter()
      const sandbox = await adapter.createSandbox({ image: 'node:22' })
      const terminal = await sandbox.startTerminal!()

      expect(terminal.url).toBe('wss://preview.example.com/ws')
      expect(terminal.port).toBe(7681)
      expect(mockClient.exec).toHaveBeenCalledTimes(5)
    })

    it('startTerminal should skip install if ttyd is found', async () => {
      ;(mockClient.exec as ReturnType<typeof vi.fn>)
        .mockResolvedValueOnce({ exitCode: 0, stdout: '/usr/bin/ttyd' })  // which ttyd → found
        .mockResolvedValueOnce({ exitCode: 0, stdout: '' })  // nohup ttyd
        .mockResolvedValueOnce({ exitCode: 0, stdout: '' })  // wait loop
      ;(mockClient.getPreviewUrl as ReturnType<typeof vi.fn>).mockResolvedValue('http://preview.example.com')

      const adapter = createAdapter()
      const sandbox = await adapter.createSandbox({ image: 'node:22' })
      const terminal = await sandbox.startTerminal!({ shell: '/bin/zsh' })

      expect(terminal.url).toBe('ws://preview.example.com/ws')
      expect(mockClient.exec).toHaveBeenCalledTimes(3)
    })
  })

  // --- State mapping ---
  describe('state mapping', () => {
    const stateMap: Array<[string, string]> = [
      ['creating', 'creating'],
      ['restoring', 'creating'],
      ['starting', 'creating'],
      ['pending_build', 'creating'],
      ['building_snapshot', 'creating'],
      ['pulling_snapshot', 'creating'],
      ['started', 'running'],
      ['stopped', 'stopped'],
      ['stopping', 'stopped'],
      ['archived', 'stopped'],
      ['archiving', 'stopped'],
      ['resizing', 'stopped'],
      ['error', 'error'],
      ['build_failed', 'error'],
      ['destroyed', 'terminated'],
      ['destroying', 'terminated'],
      ['unknown_state_xyz', 'error'],
    ]

    for (const [daytonaState, expected] of stateMap) {
      it(`should map "${daytonaState}" to "${expected}"`, async () => {
        ;(mockClient.getSandbox as ReturnType<typeof vi.fn>).mockResolvedValue(
          freshSandboxData({ state: daytonaState }),
        )

        const adapter = createAdapter()
        const sandbox = await adapter.getSandbox('sb-123')
        expect(sandbox.state).toBe(expected)
      })
    }
  })

  // --- Volume operations ---
  describe('volumes', () => {
    it('createVolume should create and return VolumeInfo', async () => {
      ;(mockClient.createVolume as ReturnType<typeof vi.fn>).mockResolvedValue({ id: 'vol-1', name: 'data' })
      ;(mockClient.listVolumes as ReturnType<typeof vi.fn>).mockResolvedValue([{ id: 'vol-1', state: 'ready' }])

      const adapter = createAdapter()
      const vol = await adapter.createVolume!({ name: 'data', sizeGB: 5 })

      expect(vol.id).toBe('vol-1')
      expect(vol.name).toBe('data')
      expect(vol.sizeGB).toBe(5)
      expect(vol.attachedTo).toBeNull()
    })

    it('createVolume should default sizeGB to 1', async () => {
      ;(mockClient.createVolume as ReturnType<typeof vi.fn>).mockResolvedValue({ id: 'vol-1', name: 'data' })
      ;(mockClient.listVolumes as ReturnType<typeof vi.fn>).mockResolvedValue([{ id: 'vol-1', state: 'ready' }])

      const adapter = createAdapter()
      const vol = await adapter.createVolume!({ name: 'data' })
      expect(vol.sizeGB).toBe(1)
    })

    it('createVolume should throw ProviderError if waitFor times out', async () => {
      vi.useFakeTimers()
      ;(mockClient.createVolume as ReturnType<typeof vi.fn>).mockResolvedValue({ id: 'vol-1', name: 'data' })
      // Volume never becomes ready — always returns pending
      ;(mockClient.listVolumes as ReturnType<typeof vi.fn>).mockResolvedValue([{ id: 'vol-1', state: 'pending_create' }])

      const adapter = createAdapter()
      // Capture the rejection immediately to prevent unhandled rejection
      let caughtError: unknown
      const promise = adapter.createVolume!({ name: 'data' }).catch(e => { caughtError = e })

      // Run all timers to completion (handles sequential setTimeout in waitFor loop)
      await vi.runAllTimersAsync()
      await promise

      expect(caughtError).toBeInstanceOf(ProviderError)
      vi.useRealTimers()
    })

    it('createVolume should wrap errors in ProviderError', async () => {
      ;(mockClient.createVolume as ReturnType<typeof vi.fn>).mockRejectedValue(new Error('quota'))
      const adapter = createAdapter()
      await expect(adapter.createVolume!({ name: 'x' })).rejects.toThrow(ProviderError)
    })

    it('deleteVolume should wait for non-ready volume then delete', async () => {
      vi.useFakeTimers()
      ;(mockClient.listVolumes as ReturnType<typeof vi.fn>)
        .mockResolvedValueOnce([{ id: 'vol-1', name: 'data', state: 'pending_create' } as DaytonaVolumeData]) // initial
        .mockResolvedValueOnce([{ id: 'vol-1', name: 'data', state: 'ready' } as DaytonaVolumeData])          // refresh

      const adapter = createAdapter()
      const promise = adapter.deleteVolume!('vol-1')
      await vi.advanceTimersByTimeAsync(2000)
      await promise

      expect(mockClient.deleteVolume).toHaveBeenCalledWith('vol-1')
      vi.useRealTimers()
    })

    it('deleteVolume should return if volume disappears while waiting', async () => {
      vi.useFakeTimers()
      ;(mockClient.listVolumes as ReturnType<typeof vi.fn>)
        .mockResolvedValueOnce([{ id: 'vol-1', name: 'data', state: 'pending_create' } as DaytonaVolumeData])
        .mockResolvedValueOnce([]) // volume disappeared

      const adapter = createAdapter()
      const promise = adapter.deleteVolume!('vol-1')
      await vi.advanceTimersByTimeAsync(2000)
      await promise

      expect(mockClient.deleteVolume).not.toHaveBeenCalled()
      vi.useRealTimers()
    })

    it('deleteVolume should be idempotent when volume not found', async () => {
      ;(mockClient.listVolumes as ReturnType<typeof vi.fn>).mockResolvedValue([])
      const adapter = createAdapter()
      await expect(adapter.deleteVolume!('nonexistent')).resolves.toBeUndefined()
    })

    it('deleteVolume should be idempotent on 404 errors', async () => {
      ;(mockClient.listVolumes as ReturnType<typeof vi.fn>).mockResolvedValue([
        { id: 'vol-1', name: 'data', state: 'ready' } as DaytonaVolumeData,
      ])
      ;(mockClient.deleteVolume as ReturnType<typeof vi.fn>).mockRejectedValue(new Error('404 not found'))

      const adapter = createAdapter()
      await expect(adapter.deleteVolume!('vol-1')).resolves.toBeUndefined()
    })

    it('deleteVolume should throw ProviderError on real errors', async () => {
      ;(mockClient.listVolumes as ReturnType<typeof vi.fn>).mockResolvedValue([
        { id: 'vol-1', name: 'data', state: 'ready' } as DaytonaVolumeData,
      ])
      ;(mockClient.deleteVolume as ReturnType<typeof vi.fn>).mockRejectedValue(new Error('server error'))

      const adapter = createAdapter()
      await expect(adapter.deleteVolume!('vol-1')).rejects.toThrow(ProviderError)
    })

    it('listVolumes should map and include attachedTo', async () => {
      ;(mockClient.listVolumes as ReturnType<typeof vi.fn>).mockResolvedValue([
        { id: 'vol-1', name: 'data' },
        { id: 'vol-2', name: 'logs' },
      ])
      ;(mockClient.listSandboxes as ReturnType<typeof vi.fn>).mockResolvedValue([
        freshSandboxData({ id: 'sb-1', volumes: [{ volumeId: 'vol-1' }] }),
      ])

      const adapter = createAdapter()
      const vols = await adapter.listVolumes!()

      expect(vols).toHaveLength(2)
      expect(vols[0].attachedTo).toBe('sb-1')
      expect(vols[1].attachedTo).toBeNull()
    })

    it('listVolumes should wrap errors in ProviderError', async () => {
      ;(mockClient.listVolumes as ReturnType<typeof vi.fn>).mockRejectedValue(new Error('fail'))
      const adapter = createAdapter()
      await expect(adapter.listVolumes!()).rejects.toThrow(ProviderError)
    })
  })
})
