import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest'
import { EventEmitter } from 'node:events'
import type { ChildProcess } from 'node:child_process'
import { Readable, Writable } from 'node:stream'
import { readFileSync } from 'node:fs'
import { join } from 'node:path'

// --- Mock child_process.spawn ---

let spawnMock: ReturnType<typeof vi.fn>
let lastSpawnedProcess: MockChildProcess | undefined

/** Handler called when a command is received on stdin */
type StdinHandler = (cmd: Record<string, unknown>) => void

class MockChildProcess extends EventEmitter {
  stdin: Writable
  stdout: Readable
  stderr: Readable
  pid = 12345
  killed = false

  private stdoutPush: (data: string) => void
  /** Commands received on stdin */
  readonly sentCommands: Record<string, unknown>[] = []
  /** Current stdin handler — set to auto-respond or leave null to not respond */
  onCommand: StdinHandler | null = null

  constructor() {
    super()
    const self = this
    this.stdin = new Writable({
      write(chunk, _encoding, callback) {
        try {
          const parsed = JSON.parse(chunk.toString())
          self.sentCommands.push(parsed)
          if (self.onCommand) {
            self.onCommand(parsed)
          }
        } catch { /* ignore non-JSON */ }
        callback()
      },
    })
    const stdoutReadable = new Readable({ read() {} })
    this.stdout = stdoutReadable
    this.stdoutPush = (data: string) => stdoutReadable.push(data)
    this.stderr = new Readable({ read() {} })
  }

  /** Push a JSON-line message to stdout (simulating bridge output) */
  sendLine(obj: Record<string, unknown>) {
    this.stdoutPush(JSON.stringify(obj) + '\n')
  }

  /** Set up auto-respond: any stdin command gets back `response` */
  autoRespond(response: unknown) {
    this.onCommand = (cmd) => {
      queueMicrotask(() => {
        this.sendLine({ id: cmd.id, result: response })
      })
    }
  }

  /** Set up auto-error: any stdin command gets back an error */
  autoError(errorMsg: string) {
    this.onCommand = (cmd) => {
      queueMicrotask(() => {
        this.sendLine({ id: cmd.id, error: errorMsg })
      })
    }
  }

  /** Stop auto-responding */
  stopResponding() {
    this.onCommand = null
  }

  kill() {
    this.killed = true
    this.emit('exit', null)
  }
}

vi.mock('node:child_process', () => ({
  spawn: (...args: unknown[]) => spawnMock(...args),
}))

vi.mock('node:fs', async (importOriginal) => {
  const actual = await importOriginal<typeof import('node:fs')>()
  return {
    ...actual,
    writeFileSync: vi.fn(),
    unlinkSync: vi.fn(),
  }
})

// --- Import after mocks ---

import { createBoxLiteLocalClient } from '../src/local-client.js'

// --- Helpers ---

function createClient(config?: { pythonPath?: string; boxliteHome?: string }) {
  return createBoxLiteLocalClient({ mode: 'local', ...config })
}

function getProcess(): MockChildProcess {
  if (!lastSpawnedProcess) throw new Error('No process spawned yet')
  return lastSpawnedProcess
}

/**
 * Create client, trigger bridge spawn, send ready.
 * Returns with bridge ready and auto-responding to commands.
 */
async function createReadyClient(
  config?: { pythonPath?: string; boxliteHome?: string },
) {
  const client = createClient(config)

  // Kick off the bridge by starting a call
  const promise = client.listBoxes()
  await new Promise(r => setTimeout(r, 5))
  const proc = getProcess()

  // Send ready and auto-respond
  proc.sendLine({ ready: true, version: '0.1.0' })
  proc.autoRespond([])

  await promise

  return { client, proc }
}

// --- Tests ---

describe('BoxLiteLocalClient', () => {
  beforeEach(() => {
    lastSpawnedProcess = undefined
    spawnMock = vi.fn(() => {
      lastSpawnedProcess = new MockChildProcess()
      return lastSpawnedProcess as unknown as ChildProcess
    })
  })

  afterEach(() => {
    vi.restoreAllMocks()
  })

  // --- Bridge lifecycle ---

  describe('bridge startup', () => {
    it('should spawn python3 with bridge script', async () => {
      const { proc } = await createReadyClient()
      expect(spawnMock).toHaveBeenCalledTimes(1)
      const [pythonPath, args] = spawnMock.mock.calls[0]!
      expect(pythonPath).toBe('python3')
      expect(args[0]).toMatch(/boxlite-bridge.*\.py$/)
      expect(proc).toBeDefined()
    })

    it('should use custom pythonPath', async () => {
      await createReadyClient({ pythonPath: '/usr/bin/python3.12' })
      expect(spawnMock.mock.calls[0]![0]).toBe('/usr/bin/python3.12')
    })

    it('should reject if bridge signals ready=false', async () => {
      const client = createClient()
      const promise = client.listBoxes()
      await new Promise(r => setTimeout(r, 5))
      getProcess().sendLine({ ready: false, error: 'boxlite not installed' })

      await expect(promise).rejects.toThrow('BoxLite bridge init failed: boxlite not installed')
    })

    it('should reject if bridge signals ready=false with unknown error', async () => {
      const client = createClient()
      const promise = client.listBoxes()
      await new Promise(r => setTimeout(r, 5))
      getProcess().sendLine({ ready: false })

      await expect(promise).rejects.toThrow('BoxLite bridge init failed: unknown error')
    })

    it('should reject if bridge process fails to start', async () => {
      const client = createClient()
      const promise = client.listBoxes()
      await new Promise(r => setTimeout(r, 5))
      getProcess().emit('error', new Error('ENOENT'))

      await expect(promise).rejects.toThrow('Failed to start boxlite bridge: ENOENT')
    })

    it('should reject if bridge exits with non-zero code', async () => {
      const client = createClient()
      const promise = client.listBoxes()
      await new Promise(r => setTimeout(r, 5))
      getProcess().emit('exit', 1)

      await expect(promise).rejects.toThrow('BoxLite bridge error')
    })

    it('should reject if bridge exits with stderr output', async () => {
      const client = createClient()
      const promise = client.listBoxes()
      await new Promise(r => setTimeout(r, 5))
      const proc = getProcess()
      ;(proc.stderr as Readable).push('ImportError: boxlite missing')
      await new Promise(r => setTimeout(r, 10))
      proc.emit('exit', 1)

      await expect(promise).rejects.toThrow('ImportError: boxlite missing')
    })

    it('should reject pending requests when bridge crashes', async () => {
      const { client, proc } = await createReadyClient()
      proc.stopResponding()

      const promise = client.getBox('box_123')
      await new Promise(r => setTimeout(r, 10))
      proc.emit('exit', 1)

      await expect(promise).rejects.toThrow('BoxLite bridge exited unexpectedly')
    })

    it('should ignore non-JSON stdout lines', async () => {
      const client = createClient()
      const promise = client.listBoxes()
      await new Promise(r => setTimeout(r, 5))
      const proc = getProcess()
      ;(proc.stdout as Readable).push('Some non-JSON warning\n')
      proc.sendLine({ ready: true, version: '0.1.0' })
      proc.autoRespond([])
      const result = await promise
      expect(result).toEqual([])
    })

    it('should ignore response lines with no id', async () => {
      const { client, proc } = await createReadyClient()
      proc.sendLine({ result: 'stray' })

      proc.autoRespond([{ id: 'box_1' }])
      const result = await client.listBoxes()
      expect(result).toHaveLength(1)
    })

    it('should reuse bridge across calls', async () => {
      const { client } = await createReadyClient()
      await client.listBoxes()
      expect(spawnMock).toHaveBeenCalledTimes(1)
    })
  })

  // --- Box lifecycle methods ---

  describe('createBox', () => {
    it('should send create action with params', async () => {
      const { client, proc } = await createReadyClient()
      const box = { id: 'box_123', status: 'running', image: 'ubuntu:24.04', cpu: 2, memory_mb: 1024, created_at: '2026-01-01', name: null }
      proc.autoRespond(box)

      const result = await client.createBox({ image: 'ubuntu:24.04', cpu: 2, memory_mb: 1024 })

      expect(result.id).toBe('box_123')
      expect(result.status).toBe('running')
      const createCmd = proc.sentCommands.find(c => c.action === 'create')
      expect(createCmd).toBeDefined()
      expect(createCmd!.image).toBe('ubuntu:24.04')
      expect(createCmd!.cpu).toBe(2)
    })
  })

  describe('getBox', () => {
    it('should send get action with box_id', async () => {
      const { client, proc } = await createReadyClient()
      proc.autoRespond({ id: 'box_123', status: 'running' })

      const result = await client.getBox('box_123')

      expect(result.id).toBe('box_123')
      const getCmd = proc.sentCommands.find(c => c.action === 'get')
      expect(getCmd!.box_id).toBe('box_123')
    })
  })

  describe('listBoxes', () => {
    it('should send list action', async () => {
      const { client, proc } = await createReadyClient()
      proc.autoRespond([{ id: 'box_1' }, { id: 'box_2' }])

      const result = await client.listBoxes()

      expect(result).toHaveLength(2)
    })
  })

  describe('deleteBox', () => {
    it('should send destroy action', async () => {
      const { client, proc } = await createReadyClient()
      proc.autoRespond({})

      await client.deleteBox('box_123')

      const cmd = proc.sentCommands.find(c => c.action === 'destroy')
      expect(cmd!.box_id).toBe('box_123')
    })
  })

  describe('startBox', () => {
    it('should send start action', async () => {
      const { client, proc } = await createReadyClient()
      proc.autoRespond({})

      await client.startBox('box_123')

      const cmd = proc.sentCommands.find(c => c.action === 'start')
      expect(cmd!.box_id).toBe('box_123')
    })
  })

  describe('stopBox', () => {
    it('should send stop action', async () => {
      const { client, proc } = await createReadyClient()
      proc.autoRespond({})

      await client.stopBox('box_123')

      const cmd = proc.sentCommands.find(c => c.action === 'stop')
      expect(cmd!.box_id).toBe('box_123')
    })
  })

  // --- Exec ---

  describe('exec', () => {
    it('should send exec action and return mapped result', async () => {
      const { client, proc } = await createReadyClient()
      proc.autoRespond({ stdout: 'hello', stderr: '', exit_code: 0 })

      const result = await client.exec('box_123', { cmd: ['echo', 'hello'] })

      expect(result.stdout).toBe('hello')
      expect(result.stderr).toBe('')
      expect(result.exitCode).toBe(0)
    })

    it('should handle non-zero exit code', async () => {
      const { client, proc } = await createReadyClient()
      proc.autoRespond({ stdout: '', stderr: 'not found', exit_code: 127 })

      const result = await client.exec('box_123', { cmd: ['bad_cmd'] })

      expect(result.exitCode).toBe(127)
      expect(result.stderr).toBe('not found')
    })

    it('should pass cmd in bridge request', async () => {
      const { client, proc } = await createReadyClient()
      proc.autoRespond({ stdout: '', stderr: '', exit_code: 0 })

      await client.exec('box_123', { cmd: ['sleep', '10'], timeout_seconds: 60 })

      const execCmd = proc.sentCommands.find(c => c.action === 'exec')
      expect(execCmd!.cmd).toEqual(['sleep', '10'])
    })

    it('should handle missing stdout/stderr/exit_code fields', async () => {
      const { client, proc } = await createReadyClient()
      proc.autoRespond({})

      const result = await client.exec('box_123', { cmd: ['test'] })

      expect(result.stdout).toBe('')
      expect(result.stderr).toBe('')
      expect(result.exitCode).toBe(0)
    })

    it('should reject on bridge error response', async () => {
      const { client, proc } = await createReadyClient()
      proc.autoError('ValueError: Box not found: box_999')

      await expect(
        client.exec('box_999', { cmd: ['ls'] }),
      ).rejects.toThrow('BoxLite local: ValueError: Box not found: box_999')
    })
  })

  // --- execStream ---

  describe('execStream', () => {
    it('should return ReadableStream wrapping exec result', async () => {
      const { client, proc } = await createReadyClient()
      proc.autoRespond({ stdout: 'stream output', stderr: 'err', exit_code: 0 })

      const stream = await client.execStream('box_123', { cmd: ['echo', 'test'] })

      expect(stream).toBeInstanceOf(ReadableStream)
      const reader = stream.getReader()
      const chunks: string[] = []
      const decoder = new TextDecoder()
      while (true) {
        const { done, value } = await reader.read()
        if (done) break
        chunks.push(decoder.decode(value))
      }
      expect(chunks.join('')).toContain('stream output')
    })

    it('should handle exec result with only stderr', async () => {
      const { client, proc } = await createReadyClient()
      proc.autoRespond({ stdout: '', stderr: 'error output', exit_code: 1 })

      const stream = await client.execStream('box_123', { cmd: ['fail'] })
      const reader = stream.getReader()
      const chunks: string[] = []
      const decoder = new TextDecoder()
      while (true) {
        const { done, value } = await reader.read()
        if (done) break
        chunks.push(decoder.decode(value))
      }
      expect(chunks.join('')).toContain('error output')
    })

    it('should handle exec result with empty stdout and stderr', async () => {
      const { client, proc } = await createReadyClient()
      proc.autoRespond({ stdout: '', stderr: '', exit_code: 0 })

      const stream = await client.execStream('box_123', { cmd: ['true'] })
      const reader = stream.getReader()
      const { done } = await reader.read()
      expect(done).toBe(true)
    })
  })

  // --- File operations ---

  describe('uploadFiles', () => {
    it('should upload small tar via single base64 exec', async () => {
      const { client, proc } = await createReadyClient()
      proc.autoRespond({ stdout: '', stderr: '', exit_code: 0 })

      const tarData = new Uint8Array([1, 2, 3, 4])
      await client.uploadFiles('box_123', '/app', tarData)

      const uploadCmd = proc.sentCommands.find(c => {
        const cmd = c.cmd as string[] | undefined
        return c.action === 'exec' && cmd?.[2]?.includes('base64 -d')
      })
      expect(uploadCmd).toBeDefined()
      expect((uploadCmd!.cmd as string[])[2]).toContain('/app')
    })

    it('should upload large tar via chunked base64 exec', async () => {
      const { client, proc } = await createReadyClient()
      proc.autoRespond({ stdout: '', stderr: '', exit_code: 0 })

      const tarData = new Uint8Array(60000)
      await client.uploadFiles('box_123', '/tmp', tarData)

      const uploadCmds = proc.sentCommands.filter(c => {
        const cmd = c.cmd as string[] | undefined
        return c.action === 'exec' && (cmd?.[2]?.includes('printf') || cmd?.[2]?.includes('base64 -d'))
      })
      expect(uploadCmds.length).toBeGreaterThan(1)
    })
  })

  describe('downloadFiles', () => {
    it('should download via tar+base64 exec and return ReadableStream', async () => {
      const { client, proc } = await createReadyClient()
      // base64 of "hello" is "aGVsbG8="
      proc.autoRespond({ stdout: 'aGVsbG8=\n', stderr: '', exit_code: 0 })

      const stream = await client.downloadFiles('box_123', '/app')

      expect(stream).toBeInstanceOf(ReadableStream)
      const reader = stream.getReader()
      const { value } = await reader.read()
      expect(value).toBeInstanceOf(Uint8Array)
      expect(Buffer.from(value!).toString()).toBe('hello')
    })
  })

  // --- Snapshot methods ---

  describe('snapshots', () => {
    it('createSnapshot should send create_snapshot action', async () => {
      const { client, proc } = await createReadyClient()
      const mockSnap = { id: 's-1', box_id: 'box_123', name: 'snap-1', created_at: 1000, size_bytes: 500 }
      proc.autoRespond(mockSnap)

      const result = await client.createSnapshot('box_123', 'snap-1')
      expect(result).toEqual(mockSnap)
      expect(proc.sentCommands.at(-1)).toMatchObject({ action: 'create_snapshot', box_id: 'box_123', name: 'snap-1' })
    })

    it('restoreSnapshot should send restore_snapshot action', async () => {
      const { client, proc } = await createReadyClient()
      proc.autoRespond({})

      await client.restoreSnapshot('box_123', 'snap-1')
      expect(proc.sentCommands.at(-1)).toMatchObject({ action: 'restore_snapshot', box_id: 'box_123', name: 'snap-1' })
    })

    it('listSnapshots should send list_snapshots action', async () => {
      const { client, proc } = await createReadyClient()
      const mockList = [{ id: 's-1', box_id: 'box_123', name: 'snap-1', created_at: 1000, size_bytes: 500 }]
      proc.autoRespond(mockList)

      const result = await client.listSnapshots('box_123')
      expect(result).toEqual(mockList)
      expect(proc.sentCommands.at(-1)).toMatchObject({ action: 'list_snapshots', box_id: 'box_123' })
    })

    it('deleteSnapshot should send delete_snapshot action', async () => {
      const { client, proc } = await createReadyClient()
      proc.autoRespond({})

      await client.deleteSnapshot('box_123', 'snap-1')
      expect(proc.sentCommands.at(-1)).toMatchObject({ action: 'delete_snapshot', box_id: 'box_123', name: 'snap-1' })
    })
  })

  // --- Dispose ---

  describe('dispose', () => {
    it('should close stdin and wait for exit', async () => {
      const { client, proc } = await createReadyClient()
      const endSpy = vi.spyOn(proc.stdin, 'end')

      setTimeout(() => proc.emit('exit', 0), 50)
      await client.dispose!()

      expect(endSpy).toHaveBeenCalled()
    })

    it('should force-kill if bridge does not exit within timeout', async () => {
      vi.useFakeTimers()
      const client = createClient()

      const listPromise = client.listBoxes()
      await vi.advanceTimersByTimeAsync(10)
      const proc = getProcess()
      proc.sendLine({ ready: true, version: '0.1.0' })
      proc.autoRespond([])
      await vi.advanceTimersByTimeAsync(10)
      await listPromise

      const disposePromise = client.dispose!()
      await vi.advanceTimersByTimeAsync(3100)
      await disposePromise

      expect(proc.killed).toBe(true)
      vi.useRealTimers()
    })

    it('should handle dispose when bridge was never started', async () => {
      const client = createClient()
      await expect(client.dispose!()).resolves.toBeUndefined()
    })
  })

  // --- send error paths ---

  describe('send error paths', () => {
    it('should throw when bridge stdin is not writable', async () => {
      const { client, proc } = await createReadyClient()
      proc.stdin.destroy()
      await new Promise(r => setTimeout(r, 10))

      await expect(client.getBox('box_123')).rejects.toThrow('BoxLite bridge is not running')
    })

    it('should timeout if bridge never responds', async () => {
      const { client, proc } = await createReadyClient()
      proc.stopResponding()

      await expect(
        client.exec('box_123', { cmd: ['sleep', '999'], timeout_seconds: 0.01 }),
      ).rejects.toThrow('BoxLite bridge request timed out')
    }, 10_000)
  })

  // --- boxliteHome config ---

  describe('config', () => {
    it('should pass boxliteHome as env var to bridge', async () => {
      await createReadyClient({ boxliteHome: '/custom/home' })

      const spawnCall = spawnMock.mock.calls[0]!
      expect(spawnCall[2].env.BOXLITE_BRIDGE_HOME).toBe('/custom/home')
    })
  })

  describe('embedded bridge lifecycle', () => {
    it('refreshes the handle after stop and before start', () => {
      const source = readFileSync(join(import.meta.dirname, '../src/local-client.ts'), 'utf8')

      expect(source).toContain('async def _refresh_box_handle(self, box_id, started=None):')
      expect(source).toContain('await self._refresh_box_handle(box_id, False)')
      expect(source).toContain('raise RuntimeError(f"Box has no start method: {box_id}")')
      expect(source).toContain('old_sb._started = True')
    })
  })
})
