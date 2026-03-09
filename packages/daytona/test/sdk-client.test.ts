import { describe, it, expect, vi, beforeEach } from 'vitest'

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

import { createDaytonaSDKClient } from '../src/sdk-client.js'
import type { DaytonaClient } from '../src/types.js'

async function createClient(): Promise<DaytonaClient> {
  return createDaytonaSDKClient('test-key', 'https://api.test.com', 'us')
}

describe('createDaytonaSDKClient', () => {
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

  // --- createSandbox ---
  describe('createSandbox', () => {
    it('should create and return sandbox data', async () => {
      const client = await createClient()
      const result = await client.createSandbox({ image: 'node:22' })

      expect(result.id).toBe('sb-123')
      expect(result.state).toBe('started')
      expect(result.createdAt).toBe('2026-01-01T00:00:00Z')
      expect(mockDaytona.create).toHaveBeenCalled()
    })

    it('should pass all config options to SDK', async () => {
      const client = await createClient()
      await client.createSandbox({
        image: 'python:3.12',
        envVars: { FOO: 'bar' },
        resources: { cpu: 2, memory: 1024 },
        volumes: [{ volumeId: 'vol-1', mountPath: '/data' }],
        autoDeleteInterval: 30,
        timeout: 60,
      })

      const [params, opts] = mockDaytona.create.mock.calls[0]
      expect(params.envVars).toEqual({ FOO: 'bar' })
      expect(params.resources).toEqual({ cpu: 2, memory: 1024 })
      expect(params.volumes).toEqual([{ volumeId: 'vol-1', mountPath: '/data' }])
      expect(params.autoDeleteInterval).toBe(30)
      expect(opts).toEqual({ timeout: 60 })
    })

    it('should not pass timeout option when not set', async () => {
      const client = await createClient()
      await client.createSandbox({ image: 'node:22' })
      const [, opts] = mockDaytona.create.mock.calls[0]
      expect(opts).toBeUndefined()
    })

    it('should cache created sandbox for subsequent operations', async () => {
      const sb = freshSandbox()
      mockDaytona.create.mockResolvedValue(sb)

      const client = await createClient()
      await client.createSandbox({ image: 'node:22' })
      // exec should use cached sandbox, not call get()
      await client.exec('sb-123', 'ls')

      expect(mockDaytona.get).not.toHaveBeenCalled()
      expect(sb.process.executeCommand).toHaveBeenCalledWith('ls', undefined, undefined, undefined)
    })
  })

  // --- getSandbox ---
  describe('getSandbox', () => {
    it('should return sandbox data', async () => {
      const client = await createClient()
      const result = await client.getSandbox('sb-123')

      expect(result.id).toBe('sb-123')
      expect(mockDaytona.get).toHaveBeenCalledWith('sb-123')
    })

    it('should always fetch fresh data (not use cache)', async () => {
      const client = await createClient()
      await client.getSandbox('sb-123')
      await client.getSandbox('sb-123')

      expect(mockDaytona.get).toHaveBeenCalledTimes(2)
    })

    it('should use fallback createdAt when missing', async () => {
      mockDaytona.get.mockResolvedValue(freshSandbox({ createdAt: undefined }))
      const client = await createClient()
      const result = await client.getSandbox('sb-123')

      expect(result.createdAt).toBeTruthy() // ISO string fallback
    })
  })

  // --- listSandboxes ---
  describe('listSandboxes', () => {
    it('should return mapped sandbox data', async () => {
      mockDaytona.list.mockResolvedValue({
        items: [
          freshSandbox({ id: 'sb-1', state: 'started' }),
          freshSandbox({ id: 'sb-2', state: 'stopped' }),
        ],
      })

      const client = await createClient()
      const list = await client.listSandboxes()
      expect(list).toHaveLength(2)
      expect(list[0].id).toBe('sb-1')
    })

    it('should pass limit to SDK', async () => {
      mockDaytona.list.mockResolvedValue({ items: [] })
      const client = await createClient()
      await client.listSandboxes(5)
      expect(mockDaytona.list).toHaveBeenCalledWith(undefined, undefined, 5)
    })
  })

  // --- deleteSandbox ---
  describe('deleteSandbox', () => {
    it('should get then delete sandbox', async () => {
      const client = await createClient()
      await client.deleteSandbox('sb-123')
      expect(mockDaytona.get).toHaveBeenCalledWith('sb-123')
      expect(mockDaytona.delete).toHaveBeenCalled()
    })

    it('should evict cache on delete', async () => {
      const sb = freshSandbox()
      mockDaytona.create.mockResolvedValue(sb)

      const client = await createClient()
      await client.createSandbox({ image: 'node:22' })
      await client.deleteSandbox('sb-123')
      // Next exec should call get() since cache was evicted
      await client.exec('sb-123', 'ls')

      expect(mockDaytona.get).toHaveBeenCalledTimes(2) // once for delete, once for resolve
    })
  })

  // --- exec ---
  describe('exec', () => {
    it('should call executeCommand with all params', async () => {
      const sb = freshSandbox()
      sb.process.executeCommand.mockResolvedValue({
        exitCode: 0, result: 'fallback', artifacts: { stdout: 'hello world' },
      })
      mockDaytona.get.mockResolvedValue(sb)

      const client = await createClient()
      const result = await client.exec('sb-123', 'echo hello', '/app', 5000)

      expect(result.exitCode).toBe(0)
      expect(result.stdout).toBe('hello world')
      expect(sb.process.executeCommand).toHaveBeenCalledWith('echo hello', '/app', undefined, 5000)
    })

    it('should fall back to result when artifacts.stdout is missing', async () => {
      const sb = freshSandbox()
      sb.process.executeCommand.mockResolvedValue({ exitCode: 0, result: 'fallback output' })
      mockDaytona.get.mockResolvedValue(sb)

      const client = await createClient()
      const result = await client.exec('sb-123', 'ls')
      expect(result.stdout).toBe('fallback output')
    })

    it('should return empty string when both artifacts and result are missing', async () => {
      const sb = freshSandbox()
      sb.process.executeCommand.mockResolvedValue({ exitCode: 0 })
      mockDaytona.get.mockResolvedValue(sb)

      const client = await createClient()
      const result = await client.exec('sb-123', 'true')
      expect(result.stdout).toBe('')
    })
  })

  // --- writeFile ---
  describe('writeFile', () => {
    it('should convert string to Buffer and upload', async () => {
      const sb = freshSandbox()
      mockDaytona.get.mockResolvedValue(sb)

      const client = await createClient()
      await client.writeFile('sb-123', '/app/file.txt', 'content')

      expect(sb.fs.uploadFile).toHaveBeenCalled()
      const buf = sb.fs.uploadFile.mock.calls[0][0] as Buffer
      expect(buf.toString()).toBe('content')
      expect(sb.fs.uploadFile.mock.calls[0][1]).toBe('/app/file.txt')
    })

    it('should convert Uint8Array to Buffer', async () => {
      const sb = freshSandbox()
      mockDaytona.get.mockResolvedValue(sb)

      const client = await createClient()
      const bytes = new TextEncoder().encode('binary data')
      await client.writeFile('sb-123', '/app/bin', bytes)

      const buf = sb.fs.uploadFile.mock.calls[0][0] as Buffer
      expect(buf.toString()).toBe('binary data')
    })
  })

  // --- readFile ---
  describe('readFile', () => {
    it('should return Uint8Array', async () => {
      const sb = freshSandbox()
      sb.fs.downloadFile.mockResolvedValue(Buffer.from('file content'))
      mockDaytona.get.mockResolvedValue(sb)

      const client = await createClient()
      const result = await client.readFile('sb-123', '/app/file.txt')

      expect(result).toBeInstanceOf(Uint8Array)
      expect(new TextDecoder().decode(result)).toBe('file content')
    })
  })

  // --- getPreviewUrl ---
  describe('getPreviewUrl', () => {
    it('should return preview URL from SDK', async () => {
      const sb = freshSandbox()
      sb.getPreviewLink.mockResolvedValue({ url: 'https://preview.example.com' })
      mockDaytona.get.mockResolvedValue(sb)

      const client = await createClient()
      const url = await client.getPreviewUrl('sb-123', 3000)

      expect(url).toBe('https://preview.example.com')
      expect(sb.getPreviewLink).toHaveBeenCalledWith(3000)
    })
  })

  // --- Volume operations ---
  describe('createVolume', () => {
    it('should create and return volume data', async () => {
      mockDaytona.volume.create.mockResolvedValue({ id: 'vol-1', name: 'data' })

      const client = await createClient()
      const vol = await client.createVolume('data')

      expect(vol.id).toBe('vol-1')
      expect(vol.name).toBe('data')
      expect(mockDaytona.volume.create).toHaveBeenCalledWith('data')
    })
  })

  describe('deleteVolume', () => {
    it('should find and delete volume', async () => {
      const vol = { id: 'vol-1', name: 'data' }
      mockDaytona.volume.list.mockResolvedValue([vol])

      const client = await createClient()
      await client.deleteVolume('vol-1')

      expect(mockDaytona.volume.delete).toHaveBeenCalledWith(vol)
    })

    it('should be idempotent when volume not found', async () => {
      mockDaytona.volume.list.mockResolvedValue([])

      const client = await createClient()
      await client.deleteVolume('nonexistent')
      expect(mockDaytona.volume.delete).not.toHaveBeenCalled()
    })
  })

  describe('listVolumes', () => {
    it('should return mapped volumes', async () => {
      mockDaytona.volume.list.mockResolvedValue([
        { id: 'vol-1', name: 'data', state: 'ready' },
        { id: 'vol-2', name: 'logs' },
      ])

      const client = await createClient()
      const vols = await client.listVolumes()

      expect(vols).toHaveLength(2)
      expect(vols[0]).toEqual({ id: 'vol-1', name: 'data', state: 'ready' })
      expect(vols[1]).toEqual({ id: 'vol-2', name: 'logs', state: undefined })
    })
  })
})
