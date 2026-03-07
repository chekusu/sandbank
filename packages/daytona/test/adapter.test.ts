import { describe, it, expect, vi, beforeEach } from 'vitest'
import { SandboxNotFoundError, ProviderError } from '@sandbank/core'

// --- Mock Daytona SDK ---

function freshSandbox(overrides?: Record<string, unknown>) {
  return {
    id: 'sb-123',
    state: 'started',
    createdAt: '2026-01-01T00:00:00Z',
    image: 'node:22',
    volumes: [],
    process: {
      executeCommand: vi.fn().mockResolvedValue({ exitCode: 0, result: '', artifacts: {} }),
    },
    fs: {
      uploadFile: vi.fn().mockResolvedValue(undefined),
      downloadFile: vi.fn().mockResolvedValue(Buffer.from('content')),
    },
    getPreviewLink: vi.fn().mockResolvedValue({ url: 'https://preview.example.com' }),
    ...overrides,
  }
}

const mockDaytona = {
  create: vi.fn(),
  get: vi.fn(),
  list: vi.fn(),
  delete: vi.fn(),
  volume: {
    create: vi.fn(),
    delete: vi.fn(),
    list: vi.fn(),
  },
}

vi.mock('@daytonaio/sdk', () => ({
  Daytona: vi.fn(function () { return mockDaytona }),
}))

import { DaytonaAdapter } from '../src/adapter.js'

function createAdapter() {
  return new DaytonaAdapter({
    apiKey: 'test-key',
    apiUrl: 'https://api.test.com',
    target: 'us',
  })
}

describe('DaytonaAdapter', () => {
  beforeEach(() => {
    vi.clearAllMocks()
    const sb = freshSandbox()
    mockDaytona.create.mockResolvedValue(sb)
    mockDaytona.get.mockResolvedValue(sb)
    mockDaytona.list.mockResolvedValue({ items: [] })
    mockDaytona.delete.mockResolvedValue(undefined)
    mockDaytona.volume.create.mockResolvedValue({ id: 'vol-1', name: 'data' })
    mockDaytona.volume.delete.mockResolvedValue(undefined)
    mockDaytona.volume.list.mockResolvedValue([])
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

  // --- createSandbox ---
  describe('createSandbox', () => {
    it('should create sandbox and return AdapterSandbox', async () => {
      const adapter = createAdapter()
      const sandbox = await adapter.createSandbox({ image: 'node:22' })
      expect(sandbox.id).toBe('sb-123')
      expect(sandbox.state).toBe('running')
      expect(mockDaytona.create).toHaveBeenCalled()
    })

    it('should pass config options to Daytona SDK', async () => {
      const adapter = createAdapter()
      await adapter.createSandbox({
        image: 'python:3.12',
        env: { FOO: 'bar' },
        resources: { cpu: 2, memory: 1024, disk: 10 },
        volumes: [{ id: 'vol-1', mountPath: '/data' }],
        autoDestroyMinutes: 30,
        timeout: 60,
      })

      const createCall = mockDaytona.create.mock.calls[0]
      expect(createCall[0].image).toBe('python:3.12')
      expect(createCall[0].envVars).toEqual({ FOO: 'bar' })
      expect(createCall[0].resources).toEqual({ cpu: 2, memory: 1024, disk: 10 })
      expect(createCall[0].volumes).toEqual([{ volumeId: 'vol-1', mountPath: '/data' }])
      expect(createCall[0].autoDeleteInterval).toBe(30)
      expect(createCall[1]).toEqual({ timeout: 60 })
    })

    it('should not pass timeout option when not set', async () => {
      const adapter = createAdapter()
      await adapter.createSandbox({ image: 'node:22' })
      const createCall = mockDaytona.create.mock.calls[0]
      expect(createCall[1]).toBeUndefined()
    })

    it('should wrap SDK errors in ProviderError', async () => {
      mockDaytona.create.mockRejectedValue(new Error('quota exceeded'))
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
      expect(mockDaytona.get).toHaveBeenCalledWith('sb-123')
    })

    it('should throw SandboxNotFoundError on 404', async () => {
      mockDaytona.get.mockRejectedValue(new Error('404 Not Found'))
      const adapter = createAdapter()
      await expect(adapter.getSandbox('missing')).rejects.toThrow(SandboxNotFoundError)
    })

    it('should throw SandboxNotFoundError on "not found"', async () => {
      mockDaytona.get.mockRejectedValue(new Error('resource not found'))
      const adapter = createAdapter()
      await expect(adapter.getSandbox('missing')).rejects.toThrow(SandboxNotFoundError)
    })

    it('should throw ProviderError on other errors', async () => {
      mockDaytona.get.mockRejectedValue(new Error('network error'))
      const adapter = createAdapter()
      await expect(adapter.getSandbox('sb-123')).rejects.toThrow(ProviderError)
    })
  })

  // --- listSandboxes ---
  describe('listSandboxes', () => {
    it('should return mapped sandbox info', async () => {
      mockDaytona.list.mockResolvedValue({
        items: [
          freshSandbox({ id: 'sb-1', state: 'started', createdAt: '2026-01-01', image: 'node:22' }),
          freshSandbox({ id: 'sb-2', state: 'stopped', createdAt: '2026-01-02', image: 'python:3' }),
        ],
      })

      const adapter = createAdapter()
      const list = await adapter.listSandboxes()
      expect(list).toHaveLength(2)
      expect(list[0].id).toBe('sb-1')
      expect(list[0].state).toBe('running')
      expect(list[1].state).toBe('stopped')
    })

    it('should filter by single state', async () => {
      mockDaytona.list.mockResolvedValue({
        items: [
          freshSandbox({ id: 'sb-1', state: 'started' }),
          freshSandbox({ id: 'sb-2', state: 'stopped' }),
        ],
      })

      const adapter = createAdapter()
      const list = await adapter.listSandboxes({ state: 'running' })
      expect(list).toHaveLength(1)
      expect(list[0].id).toBe('sb-1')
    })

    it('should filter by array of states', async () => {
      mockDaytona.list.mockResolvedValue({
        items: [
          freshSandbox({ id: 'sb-1', state: 'started' }),
          freshSandbox({ id: 'sb-2', state: 'stopped' }),
          freshSandbox({ id: 'sb-3', state: 'error' }),
        ],
      })

      const adapter = createAdapter()
      const list = await adapter.listSandboxes({ state: ['running', 'error'] })
      expect(list).toHaveLength(2)
    })

    it('should pass limit to SDK', async () => {
      mockDaytona.list.mockResolvedValue({ items: [] })
      const adapter = createAdapter()
      await adapter.listSandboxes({ limit: 5 })
      expect(mockDaytona.list).toHaveBeenCalledWith(undefined, undefined, 5)
    })

    it('should wrap errors in ProviderError', async () => {
      mockDaytona.list.mockRejectedValue(new Error('timeout'))
      const adapter = createAdapter()
      await expect(adapter.listSandboxes()).rejects.toThrow(ProviderError)
    })
  })

  // --- destroySandbox ---
  describe('destroySandbox', () => {
    it('should get then delete sandbox', async () => {
      const adapter = createAdapter()
      await adapter.destroySandbox('sb-123')
      expect(mockDaytona.get).toHaveBeenCalledWith('sb-123')
      expect(mockDaytona.delete).toHaveBeenCalled()
    })

    it('should be idempotent on 404', async () => {
      mockDaytona.get.mockRejectedValue(new Error('404 not found'))
      const adapter = createAdapter()
      await expect(adapter.destroySandbox('missing')).resolves.toBeUndefined()
    })

    it('should be idempotent on state transition', async () => {
      mockDaytona.get.mockRejectedValue(new Error('state change in progress'))
      const adapter = createAdapter()
      await expect(adapter.destroySandbox('sb-123')).resolves.toBeUndefined()
    })

    it('should be idempotent on destroying', async () => {
      mockDaytona.get.mockRejectedValue(new Error('destroying'))
      const adapter = createAdapter()
      await expect(adapter.destroySandbox('sb-123')).resolves.toBeUndefined()
    })

    it('should throw ProviderError on other errors', async () => {
      mockDaytona.get.mockRejectedValue(new Error('server error'))
      const adapter = createAdapter()
      await expect(adapter.destroySandbox('sb-123')).rejects.toThrow(ProviderError)
    })
  })

  // --- Wrapped sandbox operations ---
  describe('wrapped sandbox', () => {
    it('exec should call sandbox.process.executeCommand', async () => {
      const sb = freshSandbox()
      sb.process.executeCommand.mockResolvedValue({
        exitCode: 0, result: 'fallback', artifacts: { stdout: 'hello world' },
      })
      mockDaytona.create.mockResolvedValue(sb)

      const adapter = createAdapter()
      const sandbox = await adapter.createSandbox({ image: 'node:22' })
      const result = await sandbox.exec('echo hello', { cwd: '/app', timeout: 5000 })

      expect(result.exitCode).toBe(0)
      expect(result.stdout).toBe('hello world')
      expect(result.stderr).toBe('')
      expect(sb.process.executeCommand).toHaveBeenCalledWith('echo hello', '/app', undefined, 5000)
    })

    it('exec should fall back to result when artifacts.stdout is missing', async () => {
      const sb = freshSandbox()
      sb.process.executeCommand.mockResolvedValue({
        exitCode: 0, result: 'fallback output',
      })
      mockDaytona.create.mockResolvedValue(sb)

      const adapter = createAdapter()
      const sandbox = await adapter.createSandbox({ image: 'node:22' })
      const result = await sandbox.exec('ls')
      expect(result.stdout).toBe('fallback output')
    })

    it('exec should return empty string when both artifacts and result are missing', async () => {
      const sb = freshSandbox()
      sb.process.executeCommand.mockResolvedValue({ exitCode: 0 })
      mockDaytona.create.mockResolvedValue(sb)

      const adapter = createAdapter()
      const sandbox = await adapter.createSandbox({ image: 'node:22' })
      const result = await sandbox.exec('true')
      expect(result.stdout).toBe('')
    })

    it('writeFile should convert string to Buffer and upload', async () => {
      const sb = freshSandbox()
      mockDaytona.create.mockResolvedValue(sb)

      const adapter = createAdapter()
      const sandbox = await adapter.createSandbox({ image: 'node:22' })
      await sandbox.writeFile!('/app/file.txt', 'content')

      expect(sb.fs.uploadFile).toHaveBeenCalled()
      const buf = sb.fs.uploadFile.mock.calls[0][0] as Buffer
      expect(buf.toString()).toBe('content')
      expect(sb.fs.uploadFile.mock.calls[0][1]).toBe('/app/file.txt')
    })

    it('writeFile should convert Uint8Array to Buffer', async () => {
      const sb = freshSandbox()
      mockDaytona.create.mockResolvedValue(sb)

      const adapter = createAdapter()
      const sandbox = await adapter.createSandbox({ image: 'node:22' })
      const bytes = new TextEncoder().encode('binary data')
      await sandbox.writeFile!('/app/bin', bytes)

      const buf = sb.fs.uploadFile.mock.calls[0][0] as Buffer
      expect(buf.toString()).toBe('binary data')
    })

    it('readFile should return Uint8Array', async () => {
      const sb = freshSandbox()
      sb.fs.downloadFile.mockResolvedValue(Buffer.from('file content'))
      mockDaytona.create.mockResolvedValue(sb)

      const adapter = createAdapter()
      const sandbox = await adapter.createSandbox({ image: 'node:22' })
      const result = await sandbox.readFile!('/app/file.txt')

      expect(result).toBeInstanceOf(Uint8Array)
      expect(new TextDecoder().decode(result)).toBe('file content')
    })

    it('exposePort should call getPreviewLink and return url', async () => {
      const sb = freshSandbox()
      sb.getPreviewLink.mockResolvedValue({ url: 'https://preview.example.com' })
      mockDaytona.create.mockResolvedValue(sb)

      const adapter = createAdapter()
      const sandbox = await adapter.createSandbox({ image: 'node:22' })
      const result = await sandbox.exposePort!(3000)

      expect(result.url).toBe('https://preview.example.com')
      expect(sb.getPreviewLink).toHaveBeenCalledWith(3000)
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
        const sb = freshSandbox({ state: daytonaState })
        mockDaytona.get.mockResolvedValue(sb)

        const adapter = createAdapter()
        const sandbox = await adapter.getSandbox('sb-123')
        expect(sandbox.state).toBe(expected)
      })
    }
  })

  // --- Volume operations ---
  describe('volumes', () => {
    it('createVolume should create and return VolumeInfo', async () => {
      mockDaytona.volume.create.mockResolvedValue({ id: 'vol-1', name: 'data' })
      mockDaytona.volume.list.mockResolvedValue([{ id: 'vol-1', state: 'ready' }])

      const adapter = createAdapter()
      const vol = await adapter.createVolume!({ name: 'data', sizeGB: 5 })

      expect(vol.id).toBe('vol-1')
      expect(vol.name).toBe('data')
      expect(vol.sizeGB).toBe(5)
      expect(vol.attachedTo).toBeNull()
    })

    it('createVolume should default sizeGB to 1', async () => {
      mockDaytona.volume.create.mockResolvedValue({ id: 'vol-1', name: 'data' })
      mockDaytona.volume.list.mockResolvedValue([{ id: 'vol-1', state: 'ready' }])

      const adapter = createAdapter()
      const vol = await adapter.createVolume!({ name: 'data' })
      expect(vol.sizeGB).toBe(1)
    })

    it('createVolume should wrap errors in ProviderError', async () => {
      mockDaytona.volume.create.mockRejectedValue(new Error('quota'))
      const adapter = createAdapter()
      await expect(adapter.createVolume!({ name: 'x' })).rejects.toThrow(ProviderError)
    })

    it('deleteVolume should be idempotent when volume not found', async () => {
      mockDaytona.volume.list.mockResolvedValue([])
      const adapter = createAdapter()
      await expect(adapter.deleteVolume!('nonexistent')).resolves.toBeUndefined()
    })

    it('deleteVolume should be idempotent on 404 errors', async () => {
      mockDaytona.volume.list.mockResolvedValue([{ id: 'vol-1', state: 'ready' }])
      // Second list call for refresh
      mockDaytona.volume.list.mockResolvedValueOnce([{ id: 'vol-1', state: 'ready' }])
      mockDaytona.volume.list.mockResolvedValueOnce([{ id: 'vol-1', state: 'ready' }])
      mockDaytona.volume.delete.mockRejectedValue(new Error('404 not found'))

      const adapter = createAdapter()
      // isNotFound catches the 404
      await expect(adapter.deleteVolume!('vol-1')).resolves.toBeUndefined()
    })

    it('listVolumes should map and include attachedTo', async () => {
      mockDaytona.volume.list.mockResolvedValue([
        { id: 'vol-1', name: 'data' },
        { id: 'vol-2', name: 'logs' },
      ])
      mockDaytona.list.mockResolvedValue({
        items: [{ id: 'sb-1', volumes: [{ volumeId: 'vol-1' }] }],
      })

      const adapter = createAdapter()
      const vols = await adapter.listVolumes!()

      expect(vols).toHaveLength(2)
      expect(vols[0].attachedTo).toBe('sb-1')
      expect(vols[1].attachedTo).toBeNull()
    })

    it('listVolumes should wrap errors in ProviderError', async () => {
      mockDaytona.volume.list.mockRejectedValue(new Error('fail'))
      const adapter = createAdapter()
      await expect(adapter.listVolumes!()).rejects.toThrow(ProviderError)
    })
  })
})
