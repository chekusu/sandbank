import { describe, it, expect, vi, beforeEach } from 'vitest'
import { SandboxNotFoundError, ProviderError } from '@sandbank/core'

// --- Mock client module ---

const mockClient = {
  createBox: vi.fn(),
  getBox: vi.fn(),
  listBoxes: vi.fn(),
  deleteBox: vi.fn(),
  startBox: vi.fn(),
  stopBox: vi.fn(),
  exec: vi.fn(),
  execStream: vi.fn(),
  uploadFiles: vi.fn(),
  downloadFiles: vi.fn(),
  createSnapshot: vi.fn(),
  restoreSnapshot: vi.fn(),
  listSnapshots: vi.fn(),
  deleteSnapshot: vi.fn(),
}

vi.mock('../src/client.js', () => ({
  createBoxLiteClient: () => mockClient,
}))

// --- Import after mock ---

import { BoxLiteAdapter } from '../src/adapter.js'

// --- Helpers ---

function makeBox(overrides?: Record<string, unknown>) {
  return {
    box_id: 'b-123',
    name: null,
    status: 'running',
    created_at: '2026-01-01T00:00:00Z',
    image: 'ubuntu:24.04',
    cpus: 1,
    memory_mib: 512,
    pid: 123,
    ...overrides,
  }
}

function createAdapter() {
  return new BoxLiteAdapter({
    apiToken: 'test-token',
    apiUrl: 'http://10.0.0.1:8080',
    prefix: 'default',
  })
}

// --- Tests ---

describe('BoxLiteAdapter', () => {
  beforeEach(() => {
    vi.clearAllMocks()
    mockClient.createBox.mockResolvedValue(makeBox())
    mockClient.getBox.mockResolvedValue(makeBox())
    mockClient.listBoxes.mockResolvedValue([])
    mockClient.deleteBox.mockResolvedValue(undefined)
    mockClient.startBox.mockResolvedValue(undefined)
    mockClient.stopBox.mockResolvedValue(undefined)
    mockClient.exec.mockResolvedValue({ stdout: '', stderr: '', exitCode: 0 })
    mockClient.execStream.mockResolvedValue(new ReadableStream())
    mockClient.uploadFiles.mockResolvedValue(undefined)
    mockClient.downloadFiles.mockResolvedValue(new ReadableStream())
    mockClient.createSnapshot.mockResolvedValue({ id: 's-1', box_id: 'b-123', name: 'snap-1', created_at: 123, size_bytes: 1000 })
    mockClient.restoreSnapshot.mockResolvedValue(undefined)
  })

  // 1. Identity
  describe('identity', () => {
    it('should have name boxlite and correct capabilities', () => {
      const adapter = createAdapter()
      expect(adapter.name).toBe('boxlite')
      expect(adapter.capabilities).toEqual(new Set([
        'exec.stream',
        'terminal',
        'sleep',
        'snapshot',
        'port.expose',
      ]))
    })

    it('should not have volumes capability', () => {
      const adapter = createAdapter()
      expect(adapter.capabilities.has('volumes' as never)).toBe(false)
    })
  })

  // 2. createSandbox
  describe('createSandbox', () => {
    it('should call createBox and return sandbox with correct id and state', async () => {
      const adapter = createAdapter()
      const sandbox = await adapter.createSandbox({ image: 'ubuntu:24.04' })

      expect(mockClient.createBox).toHaveBeenCalledTimes(1)
      expect(sandbox.id).toBe('b-123')
      expect(sandbox.state).toBe('running')
    })

    it('should map resources to cpus and memory_mib', async () => {
      const adapter = createAdapter()
      await adapter.createSandbox({
        image: 'ubuntu:24.04',
        resources: { cpu: 4, memory: 2048 },
      })

      const call = mockClient.createBox.mock.calls[0]![0]
      expect(call.cpus).toBe(4)
      expect(call.memory_mib).toBe(2048)
    })

    it('should pass env vars', async () => {
      const adapter = createAdapter()
      await adapter.createSandbox({
        image: 'ubuntu:24.04',
        env: { FOO: 'bar' },
      })

      const call = mockClient.createBox.mock.calls[0]![0]
      expect(call.env).toEqual({ FOO: 'bar' })
    })

    it('should start box and poll for running state when created as configured', async () => {
      mockClient.createBox.mockResolvedValue(makeBox({ status: 'configured' }))
      mockClient.getBox
        .mockResolvedValueOnce(makeBox({ status: 'configured' }))
        .mockResolvedValueOnce(makeBox({ status: 'running' }))

      const adapter = createAdapter()
      const sandbox = await adapter.createSandbox({ image: 'ubuntu:24.04' })

      expect(mockClient.startBox).toHaveBeenCalledWith('b-123')
      expect(sandbox.state).toBe('running')
    })

    it('should wrap errors in ProviderError', async () => {
      mockClient.createBox.mockRejectedValue(new Error('boom'))
      const adapter = createAdapter()

      await expect(adapter.createSandbox({ image: 'ubuntu:24.04' })).rejects.toThrow(ProviderError)
    })
  })

  // 3. exec
  describe('exec', () => {
    it('should delegate to client.exec with bash -c wrapper', async () => {
      mockClient.exec.mockResolvedValue({ stdout: 'hello', stderr: '', exitCode: 0 })
      const adapter = createAdapter()
      const sandbox = await adapter.createSandbox({ image: 'ubuntu:24.04' })

      const result = await sandbox.exec('echo hello')

      expect(result).toEqual({ exitCode: 0, stdout: 'hello', stderr: '' })
      const execCall = mockClient.exec.mock.calls.find(
        (c: unknown[]) => c[1]?.args?.[1] === 'echo hello',
      )
      expect(execCall).toBeDefined()
      expect(execCall![1].command).toBe('bash')
      expect(execCall![1].args).toEqual(['-c', 'echo hello'])
    })

    it('should pass cwd as working_dir', async () => {
      mockClient.exec.mockResolvedValue({ stdout: '/app', stderr: '', exitCode: 0 })
      const adapter = createAdapter()
      const sandbox = await adapter.createSandbox({ image: 'ubuntu:24.04' })

      await sandbox.exec('pwd', { cwd: '/app' })

      const execCall = mockClient.exec.mock.calls.find(
        (c: unknown[]) => c[1]?.args?.[1] === 'pwd',
      )
      expect(execCall).toBeDefined()
      expect(execCall![1].working_dir).toBe('/app')
    })

    it('should convert timeout from ms to seconds', async () => {
      mockClient.exec.mockResolvedValue({ stdout: '', stderr: '', exitCode: 0 })
      const adapter = createAdapter()
      const sandbox = await adapter.createSandbox({ image: 'ubuntu:24.04' })

      await sandbox.exec('sleep 1', { timeout: 5000 })

      const execCall = mockClient.exec.mock.calls.find(
        (c: unknown[]) => c[1]?.args?.[1] === 'sleep 1',
      )
      expect(execCall).toBeDefined()
      expect(execCall![1].timeout_seconds).toBe(5)
    })
  })

  // 4. execStream
  describe('execStream', () => {
    it('should delegate to client.execStream', async () => {
      const stream = new ReadableStream()
      mockClient.execStream.mockResolvedValue(stream)
      const adapter = createAdapter()
      const sandbox = await adapter.createSandbox({ image: 'ubuntu:24.04' })

      const result = await sandbox.execStream!('echo hello')

      expect(result).toBe(stream)
      expect(mockClient.execStream).toHaveBeenCalledWith('b-123', expect.objectContaining({
        command: 'bash',
        args: ['-c', 'echo hello'],
      }))
    })
  })

  // 5. uploadArchive / downloadArchive
  describe('uploadArchive', () => {
    it('should delegate Uint8Array to client.uploadFiles', async () => {
      const adapter = createAdapter()
      const sandbox = await adapter.createSandbox({ image: 'ubuntu:24.04' })

      const data = new Uint8Array([1, 2, 3])
      await sandbox.uploadArchive!(data, '/app')

      expect(mockClient.uploadFiles).toHaveBeenCalledWith('b-123', '/app', data)
    })

    it('should collect ReadableStream and pass as Uint8Array', async () => {
      const adapter = createAdapter()
      const sandbox = await adapter.createSandbox({ image: 'ubuntu:24.04' })

      const stream = new ReadableStream({
        start(controller) {
          controller.enqueue(new Uint8Array([1, 2]))
          controller.enqueue(new Uint8Array([3, 4]))
          controller.close()
        },
      })
      await sandbox.uploadArchive!(stream, '/app')

      expect(mockClient.uploadFiles).toHaveBeenCalledWith('b-123', '/app', new Uint8Array([1, 2, 3, 4]))
    })

    it('should default destDir to /', async () => {
      const adapter = createAdapter()
      const sandbox = await adapter.createSandbox({ image: 'ubuntu:24.04' })

      await sandbox.uploadArchive!(new Uint8Array([1]), undefined)

      expect(mockClient.uploadFiles).toHaveBeenCalledWith('b-123', '/', expect.any(Uint8Array))
    })
  })

  describe('downloadArchive', () => {
    it('should delegate to client.downloadFiles', async () => {
      const stream = new ReadableStream()
      mockClient.downloadFiles.mockResolvedValue(stream)
      const adapter = createAdapter()
      const sandbox = await adapter.createSandbox({ image: 'ubuntu:24.04' })

      const result = await sandbox.downloadArchive!('/app')

      expect(result).toBe(stream)
      expect(mockClient.downloadFiles).toHaveBeenCalledWith('b-123', '/app')
    })
  })

  // 6. sleep / wake
  describe('sleep / wake', () => {
    it('sleep should call stopBox', async () => {
      const adapter = createAdapter()
      const sandbox = await adapter.createSandbox({ image: 'ubuntu:24.04' })

      await sandbox.sleep!()

      expect(mockClient.stopBox).toHaveBeenCalledWith('b-123')
    })

    it('wake should call startBox', async () => {
      const adapter = createAdapter()
      const sandbox = await adapter.createSandbox({ image: 'ubuntu:24.04' })

      await sandbox.wake!()

      expect(mockClient.startBox).toHaveBeenCalledWith('b-123')
    })
  })

  // 7. snapshot
  describe('snapshot', () => {
    it('createSnapshot should call client.createSnapshot and return snapshotId', async () => {
      const adapter = createAdapter()
      const sandbox = await adapter.createSandbox({ image: 'ubuntu:24.04' })

      const result = await sandbox.createSnapshot!('my-snap')

      expect(result.snapshotId).toBe('my-snap')
      expect(mockClient.createSnapshot).toHaveBeenCalledWith('b-123', 'my-snap')
    })

    it('createSnapshot should generate name when not provided', async () => {
      const adapter = createAdapter()
      const sandbox = await adapter.createSandbox({ image: 'ubuntu:24.04' })

      const result = await sandbox.createSnapshot!()

      expect(result.snapshotId).toMatch(/^snap-\d+$/)
      expect(mockClient.createSnapshot).toHaveBeenCalledTimes(1)
    })

    it('restoreSnapshot should call client.restoreSnapshot', async () => {
      const adapter = createAdapter()
      const sandbox = await adapter.createSandbox({ image: 'ubuntu:24.04' })

      await sandbox.restoreSnapshot!('my-snap')

      expect(mockClient.restoreSnapshot).toHaveBeenCalledWith('b-123', 'my-snap')
    })
  })

  // 8. exposePort
  describe('exposePort', () => {
    it('should return http://{host}:{port} URL', async () => {
      const adapter = createAdapter()
      const sandbox = await adapter.createSandbox({ image: 'ubuntu:24.04' })

      const result = await sandbox.exposePort!(8080)

      expect(result.url).toBe('http://10.0.0.1:8080')
    })
  })

  // 9. startTerminal
  describe('startTerminal', () => {
    it('should install ttyd if not present and start it', async () => {
      const adapter = createAdapter()
      const sandbox = await adapter.createSandbox({ image: 'ubuntu:24.04' })

      // Reset exec mocks after createSandbox
      mockClient.exec.mockReset()
      mockClient.exec
        .mockResolvedValueOnce({ stdout: '', stderr: '', exitCode: 1 }) // which ttyd → not found
        .mockResolvedValueOnce({ stdout: '', stderr: '', exitCode: 0 }) // install
        .mockResolvedValueOnce({ stdout: '', stderr: '', exitCode: 0 }) // chmod
        .mockResolvedValueOnce({ stdout: '', stderr: '', exitCode: 0 }) // start ttyd
        .mockResolvedValueOnce({ stdout: '', stderr: '', exitCode: 0 }) // wait loop

      const info = await sandbox.startTerminal!()

      expect(info.url).toBe('ws://10.0.0.1:7681/ws')
      expect(info.port).toBe(7681)
    })

    it('should skip install if ttyd is already present', async () => {
      const adapter = createAdapter()
      const sandbox = await adapter.createSandbox({ image: 'ubuntu:24.04' })

      mockClient.exec.mockReset()
      mockClient.exec
        .mockResolvedValueOnce({ stdout: '/usr/local/bin/ttyd', stderr: '', exitCode: 0 }) // which ttyd → found
        .mockResolvedValueOnce({ stdout: '', stderr: '', exitCode: 0 }) // start ttyd
        .mockResolvedValueOnce({ stdout: '', stderr: '', exitCode: 0 }) // wait loop

      const info = await sandbox.startTerminal!()

      expect(info.url).toBe('ws://10.0.0.1:7681/ws')
      expect(mockClient.exec).toHaveBeenCalledTimes(3) // which + start + wait
    })

    it('should use custom shell', async () => {
      const adapter = createAdapter()
      const sandbox = await adapter.createSandbox({ image: 'ubuntu:24.04' })

      mockClient.exec.mockReset()
      mockClient.exec.mockResolvedValue({ stdout: '/usr/local/bin/ttyd', stderr: '', exitCode: 0 })

      await sandbox.startTerminal!({ shell: '/bin/sh' })

      // Verify ttyd was started with /bin/sh
      const startCall = mockClient.exec.mock.calls.find(
        (c: unknown[]) => c[1]?.args?.[1]?.includes('ttyd'),
      )
      expect(startCall).toBeDefined()
      expect(startCall![1].args[1]).toContain('/bin/sh')
    })
  })

  // 10. destroySandbox
  describe('destroySandbox', () => {
    it('should call deleteBox with force=true', async () => {
      const adapter = createAdapter()
      await adapter.destroySandbox('b-123')

      expect(mockClient.deleteBox).toHaveBeenCalledWith('b-123', true)
    })

    it('should be idempotent (404 does not throw)', async () => {
      mockClient.deleteBox.mockRejectedValue(new Error('BoxLite API error 404: not found'))
      const adapter = createAdapter()

      await expect(adapter.destroySandbox('b-123')).resolves.toBeUndefined()
    })
  })

  // 11. State mapping
  describe('state mapping', () => {
    it.each([
      ['configured', 'creating'],
      ['running', 'running'],
      ['stopping', 'stopped'],
      ['stopped', 'stopped'],
      ['paused', 'stopped'],
      ['unknown', 'error'],
    ])('should map BoxLite status "%s" to sandbank state "%s"', async (boxStatus, expected) => {
      mockClient.getBox.mockResolvedValue(makeBox({ status: boxStatus }))
      const adapter = createAdapter()

      const sandbox = await adapter.getSandbox('b-123')

      expect(sandbox.state).toBe(expected)
    })
  })

  // 12. listSandboxes
  describe('listSandboxes', () => {
    it('should return mapped SandboxInfo array', async () => {
      mockClient.listBoxes.mockResolvedValue([
        makeBox({ box_id: 'b-1', status: 'running' }),
        makeBox({ box_id: 'b-2', status: 'stopped' }),
      ])
      const adapter = createAdapter()

      const list = await adapter.listSandboxes()

      expect(list).toHaveLength(2)
      expect(list[0]!.id).toBe('b-1')
      expect(list[0]!.state).toBe('running')
      expect(list[1]!.id).toBe('b-2')
      expect(list[1]!.state).toBe('stopped')
    })

    it('should filter by state', async () => {
      mockClient.listBoxes.mockResolvedValue([
        makeBox({ box_id: 'b-1', status: 'running' }),
        makeBox({ box_id: 'b-2', status: 'stopped' }),
        makeBox({ box_id: 'b-3', status: 'running' }),
      ])
      const adapter = createAdapter()

      const list = await adapter.listSandboxes({ state: 'running' })

      expect(list).toHaveLength(2)
      expect(list.every(s => s.state === 'running')).toBe(true)
    })

    it('should apply limit', async () => {
      mockClient.listBoxes.mockResolvedValue([
        makeBox({ box_id: 'b-1' }),
        makeBox({ box_id: 'b-2' }),
        makeBox({ box_id: 'b-3' }),
      ])
      const adapter = createAdapter()

      const list = await adapter.listSandboxes({ limit: 2 })

      expect(list).toHaveLength(2)
    })
  })

  // 13. getSandbox
  describe('getSandbox', () => {
    it('should throw SandboxNotFoundError on 404', async () => {
      mockClient.getBox.mockRejectedValue(new Error('BoxLite API error 404: not found'))
      const adapter = createAdapter()

      await expect(adapter.getSandbox('b-999')).rejects.toThrow(SandboxNotFoundError)
    })

    it('should throw ProviderError on other errors', async () => {
      mockClient.getBox.mockRejectedValue(new Error('network error'))
      const adapter = createAdapter()

      await expect(adapter.getSandbox('b-1')).rejects.toThrow(ProviderError)
    })
  })
})
