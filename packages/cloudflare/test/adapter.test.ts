import { describe, it, expect, vi, beforeEach } from 'vitest'
import type { AdapterSandbox, VolumeInfo } from '@sandbank/core'
import { SandboxNotFoundError, ProviderError } from '@sandbank/core'

// --- Mock @cloudflare/sandbox ---

const mockSandbox = {
  exec: vi.fn(),
  writeFile: vi.fn(),
  readFile: vi.fn(),
  execStream: vi.fn(),
  exposePort: vi.fn(),
  setEnvVars: vi.fn(),
  mountBucket: vi.fn(),
  unmountBucket: vi.fn(),
  destroy: vi.fn(),
  createBackup: vi.fn(),
  restoreBackup: vi.fn(),
}

const mockGetSandbox = vi.fn(() => mockSandbox)

vi.mock('@cloudflare/sandbox', () => ({
  getSandbox: (...args: unknown[]) => mockGetSandbox(...args),
}))

// --- Import after mock ---

import { CloudflareAdapter, type CloudflareAdapterConfig } from '../src/adapter.js'

// --- Helpers ---

function createConfig(overrides?: Partial<CloudflareAdapterConfig>): CloudflareAdapterConfig {
  return {
    namespace: {} as CloudflareAdapterConfig['namespace'],
    hostname: 'test.example.com',
    ...overrides,
  }
}

function resetMocks() {
  vi.clearAllMocks()
  mockSandbox.exec.mockResolvedValue({ success: true, exitCode: 0, stdout: '', stderr: '' })
  mockSandbox.writeFile.mockResolvedValue(undefined)
  mockSandbox.readFile.mockResolvedValue(btoa('hello'))
  mockSandbox.execStream.mockResolvedValue(new ReadableStream())
  mockSandbox.exposePort.mockResolvedValue({ port: 3000, url: 'https://test.example.com:3000', name: 'test' })
  mockSandbox.setEnvVars.mockResolvedValue(undefined)
  mockSandbox.mountBucket.mockResolvedValue(undefined)
  mockSandbox.unmountBucket.mockResolvedValue(undefined)
  mockSandbox.destroy.mockResolvedValue(undefined)
  mockSandbox.createBackup.mockResolvedValue({ id: 'backup-1' })
  mockSandbox.restoreBackup.mockResolvedValue(undefined)
  mockGetSandbox.mockReturnValue(mockSandbox)
}

// --- Tests ---

describe('CloudflareAdapter', () => {
  beforeEach(resetMocks)

  // --- Capabilities ---

  describe('capabilities', () => {
    it('should declare exec.stream, port.expose, snapshot without storage', () => {
      const adapter = new CloudflareAdapter(createConfig())
      expect(adapter.capabilities).toEqual(new Set(['exec.stream', 'port.expose', 'snapshot']))
    })

    it('should include volumes when storage is configured', () => {
      const adapter = new CloudflareAdapter(createConfig({
        storage: { endpoint: 'https://r2.example.com' },
      }))
      expect(adapter.capabilities).toEqual(new Set(['exec.stream', 'port.expose', 'snapshot', 'volumes']))
    })

    it('should have name "cloudflare"', () => {
      const adapter = new CloudflareAdapter(createConfig())
      expect(adapter.name).toBe('cloudflare')
    })
  })

  // --- createSandbox ---

  describe('createSandbox', () => {
    it('should call getSandbox with namespace and externalId', async () => {
      const config = createConfig()
      const adapter = new CloudflareAdapter(config)

      const sandbox = await adapter.createSandbox({ image: 'node:22' })

      expect(mockGetSandbox).toHaveBeenCalledWith(
        config.namespace,
        expect.any(String),
        expect.any(Object),
      )
      expect(sandbox.id).toMatch(/^cf-/)
      expect(sandbox.state).toBe('running')
      expect(sandbox.createdAt).toBeTruthy()
    })

    it('should call setEnvVars when env is provided', async () => {
      const adapter = new CloudflareAdapter(createConfig())
      const env = { NODE_ENV: 'production', FOO: 'bar' }

      await adapter.createSandbox({ image: 'node:22', env })

      expect(mockSandbox.setEnvVars).toHaveBeenCalledWith(env)
    })

    it('should not call setEnvVars when env is empty', async () => {
      const adapter = new CloudflareAdapter(createConfig())

      await adapter.createSandbox({ image: 'node:22', env: {} })

      expect(mockSandbox.setEnvVars).not.toHaveBeenCalled()
    })

    it('should not call setEnvVars when env is undefined', async () => {
      const adapter = new CloudflareAdapter(createConfig())

      await adapter.createSandbox({ image: 'node:22' })

      expect(mockSandbox.setEnvVars).not.toHaveBeenCalled()
    })

    it('should call mountBucket when volumes and storage are configured', async () => {
      const storage = {
        endpoint: 'https://account.r2.cloudflarestorage.com',
        credentials: { accessKeyId: 'key', secretAccessKey: 'secret' },
        provider: 'r2' as const,
      }
      const adapter = new CloudflareAdapter(createConfig({ storage }))

      await adapter.createSandbox({
        image: 'node:22',
        volumes: [{ id: 'my-bucket', mountPath: '/data' }],
      })

      expect(mockSandbox.mountBucket).toHaveBeenCalledWith('my-bucket', '/data', {
        endpoint: storage.endpoint,
        provider: 'r2',
        credentials: storage.credentials,
      })
    })

    it('should not call mountBucket when no storage configured', async () => {
      const adapter = new CloudflareAdapter(createConfig())

      await adapter.createSandbox({
        image: 'node:22',
        volumes: [{ id: 'my-bucket', mountPath: '/data' }],
      })

      expect(mockSandbox.mountBucket).not.toHaveBeenCalled()
    })

    it('should pass sleepAfter option to getSandbox', async () => {
      const adapter = new CloudflareAdapter(createConfig({ sleepAfter: '30m' }))

      await adapter.createSandbox({ image: 'node:22' })

      expect(mockGetSandbox).toHaveBeenCalledWith(
        expect.anything(),
        expect.any(String),
        expect.objectContaining({ sleepAfter: '30m' }),
      )
    })

    it('should wrap provider errors in ProviderError', async () => {
      mockGetSandbox.mockImplementation(() => { throw new Error('namespace error') })
      const adapter = new CloudflareAdapter(createConfig())

      await expect(adapter.createSandbox({ image: 'node:22' })).rejects.toThrow(ProviderError)
    })
  })

  // --- getSandbox ---

  describe('getSandbox', () => {
    it('should return a previously created sandbox', async () => {
      const adapter = new CloudflareAdapter(createConfig())
      const created = await adapter.createSandbox({ image: 'node:22' })

      const retrieved = await adapter.getSandbox(created.id)

      expect(retrieved.id).toBe(created.id)
      expect(retrieved.state).toBe('running')
    })

    it('should throw SandboxNotFoundError for unknown id', async () => {
      const adapter = new CloudflareAdapter(createConfig())

      await expect(adapter.getSandbox('unknown-id')).rejects.toThrow(SandboxNotFoundError)
    })

    it('should throw SandboxNotFoundError for terminated sandbox', async () => {
      const adapter = new CloudflareAdapter(createConfig())
      const created = await adapter.createSandbox({ image: 'node:22' })
      await adapter.destroySandbox(created.id)

      await expect(adapter.getSandbox(created.id)).rejects.toThrow(SandboxNotFoundError)
    })

    it('should reconnect via getSandbox SDK call', async () => {
      const adapter = new CloudflareAdapter(createConfig())
      const created = await adapter.createSandbox({ image: 'node:22' })
      mockGetSandbox.mockClear()

      await adapter.getSandbox(created.id)

      expect(mockGetSandbox).toHaveBeenCalledTimes(1)
    })
  })

  // --- listSandboxes ---

  describe('listSandboxes', () => {
    it('should track created sandboxes', async () => {
      const adapter = new CloudflareAdapter(createConfig())
      await adapter.createSandbox({ image: 'node:22' })
      await adapter.createSandbox({ image: 'python:3.12' })

      const list = await adapter.listSandboxes()

      expect(list).toHaveLength(2)
      expect(list.every(s => s.state === 'running')).toBe(true)
    })

    it('should filter by state', async () => {
      const adapter = new CloudflareAdapter(createConfig())
      const s1 = await adapter.createSandbox({ image: 'node:22' })
      await adapter.createSandbox({ image: 'python:3.12' })
      await adapter.destroySandbox(s1.id)

      const running = await adapter.listSandboxes({ state: 'running' })
      const terminated = await adapter.listSandboxes({ state: 'terminated' })

      expect(running).toHaveLength(1)
      expect(terminated).toHaveLength(1)
    })

    it('should apply limit', async () => {
      const adapter = new CloudflareAdapter(createConfig())
      await adapter.createSandbox({ image: 'node:22' })
      await adapter.createSandbox({ image: 'node:22' })
      await adapter.createSandbox({ image: 'node:22' })

      const list = await adapter.listSandboxes({ limit: 2 })

      expect(list).toHaveLength(2)
    })

    it('should return empty image for CF sandboxes', async () => {
      const adapter = new CloudflareAdapter(createConfig())
      await adapter.createSandbox({ image: 'node:22' })

      const list = await adapter.listSandboxes()

      expect(list[0]!.image).toBe('')
    })
  })

  // --- destroySandbox ---

  describe('destroySandbox', () => {
    it('should call sandbox.destroy()', async () => {
      const adapter = new CloudflareAdapter(createConfig())
      const created = await adapter.createSandbox({ image: 'node:22' })

      await adapter.destroySandbox(created.id)

      expect(mockSandbox.destroy).toHaveBeenCalled()
    })

    it('should be idempotent for unknown id', async () => {
      const adapter = new CloudflareAdapter(createConfig())

      await expect(adapter.destroySandbox('nonexistent')).resolves.toBeUndefined()
    })

    it('should be idempotent for already terminated sandbox', async () => {
      const adapter = new CloudflareAdapter(createConfig())
      const created = await adapter.createSandbox({ image: 'node:22' })
      await adapter.destroySandbox(created.id)
      mockSandbox.destroy.mockClear()

      await adapter.destroySandbox(created.id)

      expect(mockSandbox.destroy).not.toHaveBeenCalled()
    })

    it('should mark state as terminated', async () => {
      const adapter = new CloudflareAdapter(createConfig())
      const created = await adapter.createSandbox({ image: 'node:22' })
      await adapter.destroySandbox(created.id)

      const list = await adapter.listSandboxes({ state: 'terminated' })
      expect(list).toHaveLength(1)
      expect(list[0]!.id).toBe(created.id)
    })

    it('should swallow destroy errors (idempotent)', async () => {
      const adapter = new CloudflareAdapter(createConfig())
      const created = await adapter.createSandbox({ image: 'node:22' })
      mockSandbox.destroy.mockRejectedValue(new Error('already destroyed'))

      await expect(adapter.destroySandbox(created.id)).resolves.toBeUndefined()
    })
  })

  // --- exec ---

  describe('exec', () => {
    it('should forward command and return ExecResult', async () => {
      mockSandbox.exec.mockResolvedValue({ success: true, exitCode: 0, stdout: 'hello', stderr: '' })
      const adapter = new CloudflareAdapter(createConfig())
      const sandbox = await adapter.createSandbox({ image: 'node:22' })

      const result = await sandbox.exec('echo hello')

      expect(mockSandbox.exec).toHaveBeenCalledWith('echo hello', { timeout: undefined, cwd: undefined })
      expect(result).toEqual({ exitCode: 0, stdout: 'hello', stderr: '' })
    })

    it('should pass timeout and cwd options', async () => {
      mockSandbox.exec.mockResolvedValue({ success: true, exitCode: 0, stdout: '', stderr: '' })
      const adapter = new CloudflareAdapter(createConfig())
      const sandbox = await adapter.createSandbox({ image: 'node:22' })

      await sandbox.exec('ls', { timeout: 5000, cwd: '/tmp' })

      expect(mockSandbox.exec).toHaveBeenCalledWith('ls', { timeout: 5000, cwd: '/tmp' })
    })

    it('should handle failed commands', async () => {
      mockSandbox.exec.mockResolvedValue({ success: false, exitCode: 1, stdout: '', stderr: 'error msg' })
      const adapter = new CloudflareAdapter(createConfig())
      const sandbox = await adapter.createSandbox({ image: 'node:22' })

      const result = await sandbox.exec('bad-cmd')

      expect(result.exitCode).toBe(1)
      expect(result.stderr).toBe('error msg')
    })

    it('should infer exitCode from success when exitCode is undefined', async () => {
      mockSandbox.exec.mockResolvedValue({ success: false, stdout: '', stderr: '' })
      const adapter = new CloudflareAdapter(createConfig())
      const sandbox = await adapter.createSandbox({ image: 'node:22' })

      const result = await sandbox.exec('fail')

      expect(result.exitCode).toBe(1)
    })
  })

  // --- writeFile / readFile ---

  describe('writeFile', () => {
    it('should call sandbox.writeFile with utf-8 for string content', async () => {
      const adapter = new CloudflareAdapter(createConfig())
      const sandbox = await adapter.createSandbox({ image: 'node:22' })

      await sandbox.writeFile!('/tmp/test.txt', 'content')

      expect(mockSandbox.writeFile).toHaveBeenCalledWith('/tmp/test.txt', 'content', { encoding: 'utf-8' })
    })

    it('should call sandbox.writeFile with base64 string for Uint8Array content', async () => {
      const adapter = new CloudflareAdapter(createConfig())
      const sandbox = await adapter.createSandbox({ image: 'node:22' })
      const bytes = new Uint8Array([1, 2, 3])

      await sandbox.writeFile!('/tmp/test.bin', bytes)

      // CF SDK writeFile only accepts string; Uint8Array is converted to base64
      expect(mockSandbox.writeFile).toHaveBeenCalledWith('/tmp/test.bin', btoa(String.fromCharCode(1, 2, 3)), { encoding: 'base64' })
    })
  })

  describe('readFile', () => {
    it('should return Uint8Array from base64 response', async () => {
      const original = 'hello world'
      mockSandbox.readFile.mockResolvedValue(btoa(original))
      const adapter = new CloudflareAdapter(createConfig())
      const sandbox = await adapter.createSandbox({ image: 'node:22' })

      const result = await sandbox.readFile!('/tmp/test.txt')

      expect(mockSandbox.readFile).toHaveBeenCalledWith('/tmp/test.txt', { encoding: 'base64' })
      expect(result).toBeInstanceOf(Uint8Array)
      expect(new TextDecoder().decode(result)).toBe(original)
    })

    it('should handle object response with content field', async () => {
      mockSandbox.readFile.mockResolvedValue({ content: btoa('data'), encoding: 'base64' })
      const adapter = new CloudflareAdapter(createConfig())
      const sandbox = await adapter.createSandbox({ image: 'node:22' })

      const result = await sandbox.readFile!('/tmp/file')

      expect(new TextDecoder().decode(result)).toBe('data')
    })
  })

  // --- execStream ---

  describe('execStream', () => {
    it('should return ReadableStream from sandbox.execStream', async () => {
      const stream = new ReadableStream()
      mockSandbox.execStream.mockResolvedValue(stream)
      const adapter = new CloudflareAdapter(createConfig())
      const sandbox = await adapter.createSandbox({ image: 'node:22' })

      const result = await sandbox.execStream!('ls -la')

      expect(mockSandbox.execStream).toHaveBeenCalledWith('ls -la')
      expect(result).toBe(stream)
    })
  })

  // --- exposePort ---

  describe('exposePort', () => {
    it('should pass hostname and return url', async () => {
      mockSandbox.exposePort.mockResolvedValue({ port: 8080, url: 'https://test.example.com:8080', name: 'web' })
      const adapter = new CloudflareAdapter(createConfig({ hostname: 'test.example.com' }))
      const sandbox = await adapter.createSandbox({ image: 'node:22' })

      const result = await sandbox.exposePort!(8080)

      expect(mockSandbox.exposePort).toHaveBeenCalledWith(8080, { hostname: 'test.example.com' })
      expect(result).toEqual({ url: 'https://test.example.com:8080' })
    })
  })

  // --- snapshot ---

  describe('createSnapshot / restoreSnapshot', () => {
    it('should create a snapshot and return snapshotId', async () => {
      const adapter = new CloudflareAdapter(createConfig())
      const sandbox = await adapter.createSandbox({ image: 'node:22' })

      const result = await sandbox.createSnapshot!('my-backup')

      expect(mockSandbox.createBackup).toHaveBeenCalledWith({ dir: '/', name: 'my-backup' })
      expect(result.snapshotId).toMatch(/^snap-/)
    })

    it('should restore a previously created snapshot', async () => {
      const backupObj = { id: 'backup-123', data: 'backup-data' }
      mockSandbox.createBackup.mockResolvedValue(backupObj)
      const adapter = new CloudflareAdapter(createConfig())
      const sandbox = await adapter.createSandbox({ image: 'node:22' })

      const { snapshotId } = await sandbox.createSnapshot!()
      await sandbox.restoreSnapshot!(snapshotId)

      expect(mockSandbox.restoreBackup).toHaveBeenCalledWith(backupObj)
    })

    it('should throw SandboxNotFoundError for unknown snapshotId', async () => {
      const adapter = new CloudflareAdapter(createConfig())
      const sandbox = await adapter.createSandbox({ image: 'node:22' })

      await expect(sandbox.restoreSnapshot!('nonexistent')).rejects.toThrow(SandboxNotFoundError)
    })
  })

  // --- Volume operations ---

  describe('createVolume', () => {
    it('should register a volume and return VolumeInfo', async () => {
      const adapter = new CloudflareAdapter(createConfig({
        storage: { endpoint: 'https://r2.example.com' },
      }))

      const vol = await adapter.createVolume({ name: 'my-bucket', sizeGB: 10 })

      expect(vol).toEqual({
        id: 'my-bucket',
        name: 'my-bucket',
        sizeGB: 10,
        attachedTo: null,
      })
    })

    it('should default sizeGB to 0 if not provided', async () => {
      const adapter = new CloudflareAdapter(createConfig({
        storage: { endpoint: 'https://r2.example.com' },
      }))

      const vol = await adapter.createVolume({ name: 'bucket' })

      expect(vol.sizeGB).toBe(0)
    })
  })

  describe('deleteVolume', () => {
    it('should remove from tracking', async () => {
      const adapter = new CloudflareAdapter(createConfig({
        storage: { endpoint: 'https://r2.example.com' },
      }))
      await adapter.createVolume({ name: 'my-bucket' })

      await adapter.deleteVolume('my-bucket')

      const volumes = await adapter.listVolumes()
      expect(volumes).toHaveLength(0)
    })

    it('should be idempotent for nonexistent volume', async () => {
      const adapter = new CloudflareAdapter(createConfig({
        storage: { endpoint: 'https://r2.example.com' },
      }))

      await expect(adapter.deleteVolume('nonexistent')).resolves.toBeUndefined()
    })
  })

  describe('listVolumes', () => {
    it('should return tracked volumes', async () => {
      const adapter = new CloudflareAdapter(createConfig({
        storage: { endpoint: 'https://r2.example.com' },
      }))
      await adapter.createVolume({ name: 'bucket-a' })
      await adapter.createVolume({ name: 'bucket-b' })

      const volumes = await adapter.listVolumes()

      expect(volumes).toHaveLength(2)
      expect(volumes.map(v => v.name).sort()).toEqual(['bucket-a', 'bucket-b'])
    })

    it('should return empty array initially', async () => {
      const adapter = new CloudflareAdapter(createConfig())

      const volumes = await adapter.listVolumes()

      expect(volumes).toEqual([])
    })
  })

  // --- Retry logic ---

  describe('retry on CONTAINER_NOT_READY', () => {
    it('should retry exec on CONTAINER_NOT_READY and succeed', async () => {
      let callCount = 0
      mockSandbox.exec.mockImplementation(async () => {
        callCount++
        if (callCount === 1) throw new Error('CONTAINER_NOT_READY')
        return { success: true, exitCode: 0, stdout: 'ok', stderr: '' }
      })

      const adapter = new CloudflareAdapter(createConfig())
      const sandbox = await adapter.createSandbox({ image: 'node:22' })

      const result = await sandbox.exec('echo hello')

      expect(result.stdout).toBe('ok')
      expect(callCount).toBe(2)
    })
  })
})
