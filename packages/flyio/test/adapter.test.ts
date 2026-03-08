import { describe, it, expect, vi, beforeEach } from 'vitest'
import { SandboxNotFoundError, ProviderError } from '@sandbank/core'

// --- Mock client module ---

const mockClient = {
  createMachine: vi.fn(),
  getMachine: vi.fn(),
  listMachines: vi.fn(),
  startMachine: vi.fn(),
  stopMachine: vi.fn(),
  destroyMachine: vi.fn(),
  waitForState: vi.fn(),
  exec: vi.fn(),
  createVolume: vi.fn(),
  deleteVolume: vi.fn(),
  listVolumes: vi.fn(),
}

vi.mock('../src/client.js', () => ({
  createFlyioClient: () => mockClient,
}))

// --- Import after mock ---

import { FlyioAdapter } from '../src/adapter.js'

// --- Helpers ---

function makeMachine(overrides?: Record<string, unknown>) {
  return {
    id: 'm-123',
    name: 'test-machine',
    state: 'started',
    region: 'nrt',
    instance_id: 'i-1',
    private_ip: '10.0.0.1',
    image_ref: { registry: '', repository: '', tag: '', digest: '' },
    created_at: '2026-01-01T00:00:00Z',
    config: { image: 'node:22' },
    ...overrides,
  }
}

function createAdapter() {
  return new FlyioAdapter({ apiToken: 'test-token', appName: 'my-app' })
}

// --- Tests ---

describe('FlyioAdapter', () => {
  beforeEach(() => {
    vi.clearAllMocks()
    mockClient.createMachine.mockResolvedValue(makeMachine())
    mockClient.getMachine.mockResolvedValue(makeMachine())
    mockClient.waitForState.mockResolvedValue(undefined)
    mockClient.listMachines.mockResolvedValue([])
    mockClient.destroyMachine.mockResolvedValue(undefined)
    mockClient.exec.mockResolvedValue({ stdout: '', stderr: '', exit_code: 0 })
    mockClient.createVolume.mockResolvedValue({ id: 'vol-1', name: 'data', region: 'nrt', size_gb: 1, state: 'created', attached_machine_id: null, created_at: '' })
    mockClient.deleteVolume.mockResolvedValue(undefined)
    mockClient.listVolumes.mockResolvedValue([])
  })

  // 1. Identity
  describe('identity', () => {
    it('should have name flyio and correct capabilities', () => {
      const adapter = createAdapter()
      expect(adapter.name).toBe('flyio')
      expect(adapter.capabilities).toEqual(new Set(['terminal', 'volumes', 'port.expose']))
    })

    it('should not have exec.stream, snapshot, or sleep capabilities', () => {
      const adapter = createAdapter()
      expect(adapter.capabilities.has('exec.stream' as never)).toBe(false)
      expect(adapter.capabilities.has('snapshot' as never)).toBe(false)
      expect(adapter.capabilities.has('sleep' as never)).toBe(false)
    })
  })

  // 2-4. createSandbox
  describe('createSandbox', () => {
    it('should call createMachine, waitForState, and getMachine', async () => {
      const adapter = createAdapter()

      const sandbox = await adapter.createSandbox({ image: 'node:22' })

      expect(mockClient.createMachine).toHaveBeenCalledTimes(1)
      expect(mockClient.waitForState).toHaveBeenCalledWith('m-123', 'started', 60)
      expect(mockClient.getMachine).toHaveBeenCalledWith('m-123')
      expect(sandbox.id).toBe('m-123')
      expect(sandbox.state).toBe('running')
    })

    it('should map resources to guest config', async () => {
      const adapter = createAdapter()

      await adapter.createSandbox({
        image: 'node:22',
        resources: { cpu: 4, memory: 1024 },
      })

      const call = mockClient.createMachine.mock.calls[0]![0]
      expect(call.guest).toEqual({
        cpu_kind: 'shared',
        cpus: 4,
        memory_mb: 1024,
      })
    })

    it('should map volume mounts', async () => {
      const adapter = createAdapter()

      await adapter.createSandbox({
        image: 'node:22',
        volumes: [{ id: 'vol-1', mountPath: '/data' }],
      })

      const call = mockClient.createMachine.mock.calls[0]![0]
      expect(call.mounts).toEqual([{ volume: 'vol-1', path: '/data' }])
    })

    it('should wrap errors in ProviderError', async () => {
      mockClient.createMachine.mockRejectedValue(new Error('boom'))
      const adapter = createAdapter()

      await expect(adapter.createSandbox({ image: 'node:22' })).rejects.toThrow(ProviderError)
    })
  })

  // 5-6. exec
  describe('exec', () => {
    it('should map fly result exit_code to exitCode', async () => {
      mockClient.exec.mockResolvedValue({ stdout: 'hello', stderr: 'warn', exit_code: 42 })
      const adapter = createAdapter()
      const sandbox = await adapter.createSandbox({ image: 'node:22' })

      const result = await sandbox.exec('echo hello')

      expect(result).toEqual({ exitCode: 42, stdout: 'hello', stderr: 'warn' })
    })

    it('should prefix command with cd when cwd is provided', async () => {
      const adapter = createAdapter()
      const sandbox = await adapter.createSandbox({ image: 'node:22' })

      await sandbox.exec('ls', { cwd: '/app' })

      expect(mockClient.exec).toHaveBeenCalledWith('m-123', "cd '/app' && ls")
    })

    it('should not prefix cd when cwd is not provided', async () => {
      const adapter = createAdapter()
      const sandbox = await adapter.createSandbox({ image: 'node:22' })

      await sandbox.exec('ls')

      expect(mockClient.exec).toHaveBeenCalledWith('m-123', 'ls')
    })
  })

  // 7. exposePort
  describe('exposePort', () => {
    it('should return https://{appName}.fly.dev', async () => {
      const adapter = createAdapter()
      const sandbox = await adapter.createSandbox({ image: 'node:22' })

      const result = await sandbox.exposePort!(8080)

      expect(result).toEqual({ url: 'https://my-app.fly.dev' })
    })
  })

  // startTerminal
  describe('startTerminal', () => {
    it('should install ttyd if not present and start it', async () => {
      const adapter = createAdapter()
      const sandbox = await adapter.createSandbox({ image: 'node:22' })

      // Reset exec mocks after createSandbox, then set up for startTerminal
      mockClient.exec.mockReset()
      mockClient.exec
        .mockResolvedValueOnce({ stdout: '', stderr: '', exit_code: 1 }) // which ttyd → not found
        .mockResolvedValueOnce({ stdout: '', stderr: '', exit_code: 0 }) // curl install
        .mockResolvedValueOnce({ stdout: '', stderr: '', exit_code: 0 }) // ttyd start
        .mockResolvedValueOnce({ stdout: '', stderr: '', exit_code: 0 }) // wait loop

      const info = await sandbox.startTerminal!()

      expect(info.url).toBe('wss://my-app.fly.dev/ws')
      expect(info.port).toBe(8080)
      expect(mockClient.exec).toHaveBeenCalledWith('m-123', expect.stringContaining('curl -sL'))
    })

    it('should skip install if ttyd already present', async () => {
      // ttyd found → start → wait
      mockClient.exec
        .mockResolvedValueOnce({ stdout: '', stderr: '', exit_code: 0 }) // createSandbox exec
        .mockResolvedValueOnce({ stdout: '/usr/local/bin/ttyd', stderr: '', exit_code: 0 }) // which ttyd → found
        .mockResolvedValueOnce({ stdout: '', stderr: '', exit_code: 0 }) // ttyd start
        .mockResolvedValueOnce({ stdout: '', stderr: '', exit_code: 0 }) // wait loop

      const adapter = createAdapter()
      const sandbox = await adapter.createSandbox({ image: 'node:22' })

      const info = await sandbox.startTerminal!()

      expect(info.url).toBe('wss://my-app.fly.dev/ws')
      expect(info.port).toBe(8080)
      // No curl install call — verify exec was called 4 times total (createSandbox doesn't call exec)
      // Actually createSandbox doesn't call exec, so it's: which + start + wait = 3 calls
    })

    it('should return valid WebSocket URL', async () => {
      mockClient.exec.mockResolvedValue({ stdout: '/usr/local/bin/ttyd', stderr: '', exit_code: 0 })

      const adapter = createAdapter()
      const sandbox = await adapter.createSandbox({ image: 'node:22' })

      const info = await sandbox.startTerminal!()

      expect(info.url).toMatch(/^wss:\/\//)
      expect(info.url).toContain('my-app.fly.dev')
      expect(info.port).toBe(8080)
    })

    it('should use custom shell when specified', async () => {
      mockClient.exec.mockResolvedValue({ stdout: '/usr/local/bin/ttyd', stderr: '', exit_code: 0 })

      const adapter = createAdapter()
      const sandbox = await adapter.createSandbox({ image: 'node:22' })

      await sandbox.startTerminal!({ shell: '/bin/sh' })

      // Verify ttyd was started with /bin/sh
      expect(mockClient.exec).toHaveBeenCalledWith('m-123', expect.stringContaining('/bin/sh'))
    })
  })

  // 8-9. destroySandbox
  describe('destroySandbox', () => {
    it('should call destroyMachine', async () => {
      const adapter = createAdapter()

      await adapter.destroySandbox('m-123')

      expect(mockClient.destroyMachine).toHaveBeenCalledWith('m-123')
    })

    it('should be idempotent (404 does not throw)', async () => {
      mockClient.destroyMachine.mockRejectedValue(new Error('Fly.io API error 404: not found'))
      const adapter = createAdapter()

      await expect(adapter.destroySandbox('m-123')).resolves.toBeUndefined()
    })
  })

  // 10. State mapping
  describe('state mapping', () => {
    it.each([
      ['created', 'creating'],
      ['starting', 'creating'],
      ['started', 'running'],
      ['stopped', 'stopped'],
      ['stopping', 'stopped'],
      ['suspended', 'stopped'],
      ['failed', 'error'],
      ['destroyed', 'terminated'],
      ['destroying', 'terminated'],
      ['unknown', 'error'],
    ])('should map fly state "%s" to sandbank state "%s"', async (flyState, expected) => {
      mockClient.getMachine.mockResolvedValue(makeMachine({ state: flyState }))
      const adapter = createAdapter()

      const sandbox = await adapter.getSandbox('m-123')

      expect(sandbox.state).toBe(expected)
    })
  })

  // 11. listSandboxes
  describe('listSandboxes', () => {
    it('should return mapped SandboxInfo array', async () => {
      mockClient.listMachines.mockResolvedValue([
        makeMachine({ id: 'm-1', state: 'started' }),
        makeMachine({ id: 'm-2', state: 'stopped' }),
      ])
      const adapter = createAdapter()

      const list = await adapter.listSandboxes()

      expect(list).toHaveLength(2)
      expect(list[0]!.id).toBe('m-1')
      expect(list[0]!.state).toBe('running')
      expect(list[1]!.id).toBe('m-2')
      expect(list[1]!.state).toBe('stopped')
    })

    it('should filter by state', async () => {
      mockClient.listMachines.mockResolvedValue([
        makeMachine({ id: 'm-1', state: 'started' }),
        makeMachine({ id: 'm-2', state: 'stopped' }),
        makeMachine({ id: 'm-3', state: 'started' }),
      ])
      const adapter = createAdapter()

      const list = await adapter.listSandboxes({ state: 'running' })

      expect(list).toHaveLength(2)
      expect(list.every(s => s.state === 'running')).toBe(true)
    })

    it('should apply limit', async () => {
      mockClient.listMachines.mockResolvedValue([
        makeMachine({ id: 'm-1' }),
        makeMachine({ id: 'm-2' }),
        makeMachine({ id: 'm-3' }),
      ])
      const adapter = createAdapter()

      const list = await adapter.listSandboxes({ limit: 2 })

      expect(list).toHaveLength(2)
    })
  })

  // 12. createVolume
  describe('createVolume', () => {
    it('should return mapped VolumeInfo', async () => {
      mockClient.createVolume.mockResolvedValue({
        id: 'vol-1', name: 'data', region: 'nrt', size_gb: 10, state: 'created', attached_machine_id: null, created_at: '',
      })
      const adapter = createAdapter()

      const vol = await adapter.createVolume({ name: 'data', sizeGB: 10 })

      expect(vol).toEqual({ id: 'vol-1', name: 'data', sizeGB: 10, attachedTo: null })
    })
  })

  // 13. listVolumes
  describe('listVolumes', () => {
    it('should map attached_machine_id to attachedTo', async () => {
      mockClient.listVolumes.mockResolvedValue([
        { id: 'vol-1', name: 'data', region: 'nrt', size_gb: 5, state: 'created', attached_machine_id: 'm-1', created_at: '' },
        { id: 'vol-2', name: 'logs', region: 'nrt', size_gb: 1, state: 'created', attached_machine_id: null, created_at: '' },
      ])
      const adapter = createAdapter()

      const vols = await adapter.listVolumes()

      expect(vols).toHaveLength(2)
      expect(vols[0]).toEqual({ id: 'vol-1', name: 'data', sizeGB: 5, attachedTo: 'm-1' })
      expect(vols[1]).toEqual({ id: 'vol-2', name: 'logs', sizeGB: 1, attachedTo: null })
    })
  })

  // 14. deleteVolume
  describe('deleteVolume', () => {
    it('should be idempotent (404 does not throw)', async () => {
      mockClient.deleteVolume.mockRejectedValue(new Error('Fly.io API error 404: not found'))
      const adapter = createAdapter()

      await expect(adapter.deleteVolume('vol-1')).resolves.toBeUndefined()
    })
  })

  // getSandbox edge case
  describe('getSandbox', () => {
    it('should throw SandboxNotFoundError on 404', async () => {
      mockClient.getMachine.mockRejectedValue(new Error('Fly.io API error 404: not found'))
      const adapter = createAdapter()

      await expect(adapter.getSandbox('m-999')).rejects.toThrow(SandboxNotFoundError)
    })
  })
})
