/**
 * Integration test for CloudflareAdapter.
 *
 * Unlike Daytona (REST API reachable from Node.js), Cloudflare Sandbox SDK
 * requires a DurableObjectNamespace binding only available in the Workers runtime.
 * This test uses a stateful mock that simulates real CF Sandbox SDK behavior
 * (filesystem, env vars, process exec, backups) and tests the adapter through
 * the core createProvider() pipeline end-to-end.
 */
import { describe, it, expect, vi, beforeEach, afterAll } from 'vitest'
import {
  createProvider,
  withVolumes,
  withPortExpose,
  withStreaming,
  withSnapshot,
  hasCapability,
  SandboxNotFoundError,
  ProviderError,
} from '@sandbank/core'

// --- Stateful Sandbox Mock ---
// Simulates a real CF Sandbox container: filesystem, env vars, exec, backup/restore

function createStatefulSandbox() {
  const fs = new Map<string, string>()
  let envVars: Record<string, string> = {}
  let destroyed = false
  const backups = new Map<string, Map<string, string>>()
  let backupCounter = 0
  const mountedBuckets = new Map<string, { bucket: string; options: unknown }>()

  return {
    exec: vi.fn(async (command: string, opts?: { timeout?: number; cwd?: string }) => {
      if (destroyed) throw new Error('Container destroyed')

      // Simple command simulation
      if (command.startsWith('echo ')) {
        // Handle env var substitution
        let output = command.slice(5).replace(/^["']|["']$/g, '')
        output = output.replace(/\$(\w+)/g, (_, name) => envVars[name] ?? '')
        return { success: true, exitCode: 0, stdout: output + '\n', stderr: '' }
      }
      if (command === 'pwd') {
        return { success: true, exitCode: 0, stdout: (opts?.cwd ?? '/') + '\n', stderr: '' }
      }
      if (command.startsWith('cat ')) {
        const path = command.slice(4).trim()
        const content = fs.get(path)
        if (content === undefined) {
          return { success: false, exitCode: 1, stdout: '', stderr: `cat: ${path}: No such file or directory` }
        }
        return { success: true, exitCode: 0, stdout: content, stderr: '' }
      }
      if (command === 'exit 42') {
        return { success: false, exitCode: 42, stdout: '', stderr: '' }
      }
      if (command === 'uname -a') {
        return { success: true, exitCode: 0, stdout: 'Linux cloudflare-sandbox 6.1.0 #1 SMP x86_64 GNU/Linux\n', stderr: '' }
      }
      if (command === 'ls /tmp') {
        const files = Array.from(fs.keys())
          .filter(k => k.startsWith('/tmp/'))
          .map(k => k.split('/').pop())
        return { success: true, exitCode: 0, stdout: files.join('\n') + '\n', stderr: '' }
      }
      // mkdir -p
      if (command.startsWith('mkdir -p ')) {
        return { success: true, exitCode: 0, stdout: '', stderr: '' }
      }
      // printf '...' | base64 -d > <path> (used by archive upload)
      const printfMatch = command.match(/^printf '%s' '(.*)' \| base64 -d > (.+)$/)
      if (printfMatch) {
        const b64 = printfMatch[1]!.replace(/'\\''/, "'")
        const path = printfMatch[2]!
        const decoded = atob(b64)
        fs.set(path, decoded)
        return { success: true, exitCode: 0, stdout: '', stderr: '' }
      }
      // tar xzf <archive> -C <dir> (simulate by marking extraction done)
      if (command.startsWith('tar xzf ') && command.includes(' -C ')) {
        return { success: true, exitCode: 0, stdout: '', stderr: '' }
      }
      // tar czf <archive> -C <dir> . (simulate creating an archive)
      const tarCzfMatch = command.match(/^tar czf (.+) -C '?([^']+)'? \.$/)
      if (tarCzfMatch) {
        const archivePath = tarCzfMatch[1]!
        fs.set(archivePath, 'fake-tar-content')
        return { success: true, exitCode: 0, stdout: '', stderr: '' }
      }
      // base64 <path> (used by archive download)
      const base64Match = command.match(/^base64 (.+)$/)
      if (base64Match) {
        const path = base64Match[1]!
        const content = fs.get(path)
        if (content === undefined) {
          return { success: false, exitCode: 1, stdout: '', stderr: `base64: ${path}: No such file or directory` }
        }
        return { success: true, exitCode: 0, stdout: btoa(content) + '\n', stderr: '' }
      }
      // rm -f <path>
      if (command.startsWith('rm -f ')) {
        const path = command.slice(6).trim()
        fs.delete(path)
        return { success: true, exitCode: 0, stdout: '', stderr: '' }
      }
      // Default: succeed
      return { success: true, exitCode: 0, stdout: '', stderr: '' }
    }),

    writeFile: vi.fn(async (path: string, content: string, opts?: { encoding?: string }) => {
      if (destroyed) throw new Error('Container destroyed')
      if (opts?.encoding === 'base64') {
        // base64 input → decode to raw binary string for storage
        fs.set(path, atob(content))
      } else {
        // utf-8 input → convert to raw binary string (byte-per-char) for storage
        const encoder = new TextEncoder()
        const bytes = encoder.encode(content)
        let binary = ''
        for (let i = 0; i < bytes.length; i++) {
          binary += String.fromCharCode(bytes[i]!)
        }
        fs.set(path, binary)
      }
      return { success: true, path }
    }),

    readFile: vi.fn(async (path: string, opts?: { encoding?: string }) => {
      if (destroyed) throw new Error('Container destroyed')
      const rawBinary = fs.get(path)
      if (rawBinary === undefined) {
        throw new Error(`File not found: ${path}`)
      }
      if (opts?.encoding === 'base64') {
        // raw binary string → base64 (each char is one byte, safe for btoa)
        return { success: true, path, content: btoa(rawBinary), encoding: 'base64' }
      }
      return { success: true, path, content: rawBinary, encoding: 'utf-8' }
    }),

    execStream: vi.fn(async (command: string) => {
      if (destroyed) throw new Error('Container destroyed')
      const encoder = new TextEncoder()
      return new ReadableStream<Uint8Array>({
        start(controller) {
          controller.enqueue(encoder.encode(`$ ${command}\nstream output\n`))
          controller.close()
        },
      })
    }),

    exposePort: vi.fn(async (port: number, opts: { hostname: string }) => {
      if (destroyed) throw new Error('Container destroyed')
      return {
        port,
        url: `https://${opts.hostname}:${port}`,
        name: `port-${port}`,
      }
    }),

    setEnvVars: vi.fn(async (vars: Record<string, string>) => {
      if (destroyed) throw new Error('Container destroyed')
      envVars = { ...envVars, ...vars }
    }),

    mountBucket: vi.fn(async (bucket: string, mountPath: string, options: unknown) => {
      if (destroyed) throw new Error('Container destroyed')
      mountedBuckets.set(mountPath, { bucket, options })
    }),

    unmountBucket: vi.fn(async (mountPath: string) => {
      mountedBuckets.delete(mountPath)
    }),

    createBackup: vi.fn(async (opts: { dir: string; name?: string }) => {
      if (destroyed) throw new Error('Container destroyed')
      const id = `backup-${++backupCounter}`
      // Snapshot the filesystem state
      backups.set(id, new Map(fs))
      return { id, dir: opts.dir }
    }),

    restoreBackup: vi.fn(async (backup: { id: string; dir: string }) => {
      if (destroyed) throw new Error('Container destroyed')
      const snapshot = backups.get(backup.id)
      if (!snapshot) throw new Error(`Backup not found: ${backup.id}`)
      // Restore filesystem state
      fs.clear()
      for (const [k, v] of snapshot) {
        fs.set(k, v)
      }
      return { success: true, dir: backup.dir, id: backup.id }
    }),

    destroy: vi.fn(async () => {
      destroyed = true
      fs.clear()
      envVars = {}
    }),

    // Internal helpers for assertions
    _fs: fs,
    _envVars: () => envVars,
    _destroyed: () => destroyed,
    _mountedBuckets: mountedBuckets,
  }
}

// --- Mock setup ---

let currentSandbox: ReturnType<typeof createStatefulSandbox>
const sandboxInstances = new Map<string, ReturnType<typeof createStatefulSandbox>>()

const mockGetSandbox = vi.fn((_ns: unknown, externalId: string, _opts?: unknown) => {
  let instance = sandboxInstances.get(externalId)
  if (!instance) {
    instance = createStatefulSandbox()
    sandboxInstances.set(externalId, instance)
  }
  currentSandbox = instance
  return instance
})

vi.mock('@cloudflare/sandbox', () => ({
  getSandbox: (...args: unknown[]) => mockGetSandbox(...args),
}))

import { CloudflareAdapter, type CloudflareAdapterConfig } from '../src/adapter.js'

// --- Test Suite ---

describe('CloudflareAdapter integration', () => {
  const baseConfig: CloudflareAdapterConfig = {
    namespace: {} as CloudflareAdapterConfig['namespace'],
    hostname: 'integration.example.com',
    sleepAfter: '30m',
    storage: {
      endpoint: 'https://account123.r2.cloudflarestorage.com',
      credentials: { accessKeyId: 'test-key', secretAccessKey: 'test-secret' },
      provider: 'r2',
    },
  }

  let adapter: CloudflareAdapter
  let provider: ReturnType<typeof createProvider>
  let sharedSandboxId: string | null = null
  const extraCleanupIds: string[] = []

  beforeEach(() => {
    vi.clearAllMocks()
    sandboxInstances.clear()
    adapter = new CloudflareAdapter(baseConfig)
    provider = createProvider(adapter)
    sharedSandboxId = null
    extraCleanupIds.length = 0
  })

  afterAll(() => {
    vi.restoreAllMocks()
  })

  // ─── Adapter identity & capabilities ───

  it('adapter has correct name and capabilities', () => {
    expect(adapter.name).toBe('cloudflare')
    expect(hasCapability(provider, 'exec.stream')).toBe(true)
    expect(hasCapability(provider, 'terminal')).toBe(true)
    expect(hasCapability(provider, 'port.expose')).toBe(true)
    expect(hasCapability(provider, 'snapshot')).toBe(true)
    expect(hasCapability(provider, 'volumes')).toBe(true)
    // Capabilities we don't support
    expect(hasCapability(provider, 'sleep')).toBe(false)
  })

  it('adapter without storage does not have volumes capability', () => {
    const noStorageAdapter = new CloudflareAdapter({
      namespace: {} as CloudflareAdapterConfig['namespace'],
      hostname: 'test.example.com',
    })
    const noStorageProvider = createProvider(noStorageAdapter)
    expect(hasCapability(noStorageProvider, 'volumes')).toBe(false)
    expect(withVolumes(noStorageProvider)).toBeNull()
  })

  // ─── Full lifecycle: create → use → destroy ───

  describe('sandbox lifecycle', () => {
    it('create sandbox with image', async () => {
      const sandbox = await provider.create({ image: 'node:22-slim' })
      sharedSandboxId = sandbox.id

      expect(sandbox.id).toMatch(/^cf-/)
      expect(sandbox.state).toBe('running')
      expect(sandbox.createdAt).toBeTruthy()
      expect(new Date(sandbox.createdAt).getTime()).not.toBeNaN()
    })

    it('create sandbox with env vars and verify injection', async () => {
      const sandbox = await provider.create({
        image: 'ubuntu:latest',
        env: { MY_VAR: 'hello_sandbank', NODE_ENV: 'test' },
      })
      extraCleanupIds.push(sandbox.id)

      // Verify setEnvVars was called on the CF SDK
      expect(currentSandbox.setEnvVars).toHaveBeenCalledWith({
        MY_VAR: 'hello_sandbank',
        NODE_ENV: 'test',
      })

      // Verify env vars are usable via exec
      const result = await sandbox.exec('echo $MY_VAR')
      expect(result.exitCode).toBe(0)
      expect(result.stdout).toContain('hello_sandbank')
    })

    it('create sandbox with volumes triggers mountBucket', async () => {
      const sandbox = await provider.create({
        image: 'ubuntu:latest',
        volumes: [
          { id: 'data-bucket', mountPath: '/data' },
          { id: 'cache-bucket', mountPath: '/cache' },
        ],
      })
      extraCleanupIds.push(sandbox.id)

      expect(currentSandbox.mountBucket).toHaveBeenCalledTimes(2)
      expect(currentSandbox.mountBucket).toHaveBeenCalledWith('data-bucket', '/data', {
        endpoint: baseConfig.storage!.endpoint,
        provider: 'r2',
        credentials: baseConfig.storage!.credentials,
      })
      expect(currentSandbox.mountBucket).toHaveBeenCalledWith('cache-bucket', '/cache', {
        endpoint: baseConfig.storage!.endpoint,
        provider: 'r2',
        credentials: baseConfig.storage!.credentials,
      })
    })
  })

  // ─── exec ───

  describe('exec', () => {
    it('exec basic command', async () => {
      const sandbox = await provider.create({ image: 'node:22' })
      const result = await sandbox.exec('echo "hello sandbank"')
      expect(result.exitCode).toBe(0)
      expect(result.stdout).toContain('hello sandbank')
      expect(typeof result.stderr).toBe('string')
    })

    it('exec with cwd', async () => {
      const sandbox = await provider.create({ image: 'node:22' })
      const result = await sandbox.exec('pwd', { cwd: '/tmp' })
      expect(result.exitCode).toBe(0)
      expect(result.stdout.trim()).toBe('/tmp')
    })

    it('exec non-zero exit code', async () => {
      const sandbox = await provider.create({ image: 'node:22' })
      const result = await sandbox.exec('exit 42')
      expect(result.exitCode).toBe(42)
    })

    it('exec with timeout option', async () => {
      const sandbox = await provider.create({ image: 'node:22' })
      const result = await sandbox.exec('echo fast', { timeout: 5000 })
      expect(result.exitCode).toBe(0)
      expect(result.stdout).toContain('fast')
      // Verify timeout was forwarded to SDK
      expect(currentSandbox.exec).toHaveBeenCalledWith('echo fast', { timeout: 5000, cwd: undefined })
    })

    it('exec system command', async () => {
      const sandbox = await provider.create({ image: 'node:22' })
      const result = await sandbox.exec('uname -a')
      expect(result.exitCode).toBe(0)
      expect(result.stdout).toContain('Linux')
    })
  })

  // ─── writeFile / readFile ───

  describe('writeFile / readFile', () => {
    it('text roundtrip (UTF-8)', async () => {
      const sandbox = await provider.create({ image: 'node:22' })
      const content = 'Sandbank SDK test — 你好世界'
      await sandbox.writeFile('/tmp/test.txt', content)

      // Verify writeFile called with utf-8 encoding
      expect(currentSandbox.writeFile).toHaveBeenCalledWith(
        '/tmp/test.txt',
        content,
        { encoding: 'utf-8' },
      )

      const readBack = await sandbox.readFile('/tmp/test.txt')
      expect(new TextDecoder().decode(readBack)).toBe(content)
    })

    it('binary roundtrip', async () => {
      const sandbox = await provider.create({ image: 'node:22' })
      const data = new Uint8Array([0, 1, 2, 127, 128, 255])
      await sandbox.writeFile('/tmp/binary.bin', data)

      // Verify writeFile called with base64 encoding (string content)
      expect(currentSandbox.writeFile).toHaveBeenCalledWith(
        '/tmp/binary.bin',
        expect.any(String),
        { encoding: 'base64' },
      )

      const readBack = await sandbox.readFile('/tmp/binary.bin')
      expect(readBack).toEqual(data)
    })

    it('empty file roundtrip', async () => {
      const sandbox = await provider.create({ image: 'node:22' })
      await sandbox.writeFile('/tmp/empty.txt', '')

      const readBack = await sandbox.readFile('/tmp/empty.txt')
      expect(readBack.byteLength).toBe(0)
    })

    it('overwrite existing file', async () => {
      const sandbox = await provider.create({ image: 'node:22' })
      await sandbox.writeFile('/tmp/overwrite.txt', 'first')
      await sandbox.writeFile('/tmp/overwrite.txt', 'second')

      const readBack = await sandbox.readFile('/tmp/overwrite.txt')
      expect(new TextDecoder().decode(readBack)).toBe('second')
    })
  })

  // ─── uploadArchive / downloadArchive (via exec fallback) ───

  describe('archive operations', () => {
    it('uploadArchive calls exec with base64 and tar commands', async () => {
      const sandbox = await provider.create({ image: 'node:22' })
      const data = new Uint8Array([1, 2, 3, 4])

      await sandbox.uploadArchive(data, '/tmp/dest')

      // Verify exec was called with archive-related commands
      const execCalls = currentSandbox.exec.mock.calls.map((c: unknown[]) => c[0] as string)
      expect(execCalls.some((c: string) => c.includes('base64 -d'))).toBe(true)
      expect(execCalls.some((c: string) => c.includes('tar xzf'))).toBe(true)
      expect(execCalls.some((c: string) => c.includes('rm -f'))).toBe(true)
    })

    it('downloadArchive returns a ReadableStream', async () => {
      const sandbox = await provider.create({ image: 'node:22' })

      // Pre-populate a fake tar file so base64 command succeeds
      currentSandbox._fs.set('/tmp/_sb_archive.tar.gz', 'fake-tar-content')

      const stream = await sandbox.downloadArchive('/tmp/src')
      expect(stream).toBeInstanceOf(ReadableStream)

      // Read the stream
      const reader = stream.getReader()
      const chunks: Uint8Array[] = []
      while (true) {
        const { done, value } = await reader.read()
        if (done) break
        chunks.push(value)
      }
      expect(chunks.length).toBeGreaterThan(0)
    })

    it('upload → download round-trip via exec fallback', async () => {
      const sandbox = await provider.create({ image: 'node:22' })
      const originalData = new Uint8Array([10, 20, 30, 40, 50])

      // Upload
      await sandbox.uploadArchive(originalData, '/tmp/rt-dest')

      // The tar xzf mock doesn't actually extract, but we can verify
      // the tar.gz was written to the temp file by the printf|base64 command
      const execCalls = currentSandbox.exec.mock.calls.map((c: unknown[]) => c[0] as string)
      expect(execCalls.some((c: string) => c.includes("tar xzf /tmp/_sb_archive.tar.gz -C '/tmp/rt-dest'"))).toBe(true)
    })
  })

  // ─── execStream ───

  describe('execStream', () => {
    it('returns a readable stream with output', async () => {
      const sandbox = await provider.create({ image: 'node:22' })
      const streamable = withStreaming(sandbox)
      expect(streamable).not.toBeNull()
      if (!streamable) return

      const stream = await streamable.execStream('ls -la')
      expect(stream).toBeInstanceOf(ReadableStream)

      // Read the stream
      const reader = stream.getReader()
      const chunks: Uint8Array[] = []
      while (true) {
        const { done, value } = await reader.read()
        if (done) break
        chunks.push(value)
      }

      const output = new TextDecoder().decode(new Uint8Array(
        chunks.reduce((acc, c) => [...acc, ...c], [] as number[]),
      ))
      expect(output).toContain('stream output')
    })
  })

  // ─── exposePort ───

  describe('exposePort', () => {
    it('returns a URL with correct hostname and port', async () => {
      const sandbox = await provider.create({ image: 'node:22' })
      const portExpose = withPortExpose(sandbox)
      expect(portExpose).not.toBeNull()
      if (!portExpose) return

      const result = await portExpose.exposePort(3000)
      expect(result.url).toBe('https://integration.example.com:3000')
      expect(typeof result.url).toBe('string')
    })

    it('can expose multiple ports', async () => {
      const sandbox = await provider.create({ image: 'node:22' })
      const portExpose = withPortExpose(sandbox)
      if (!portExpose) return

      const result1 = await portExpose.exposePort(3000)
      const result2 = await portExpose.exposePort(8080)

      expect(result1.url).toBe('https://integration.example.com:3000')
      expect(result2.url).toBe('https://integration.example.com:8080')
      expect(currentSandbox.exposePort).toHaveBeenCalledTimes(2)
    })
  })

  // ─── snapshot ───

  describe('snapshot', () => {
    it('create snapshot → modify files → restore snapshot', async () => {
      const sandbox = await provider.create({ image: 'node:22' })
      const snapshotable = withSnapshot(sandbox)
      expect(snapshotable).not.toBeNull()
      if (!snapshotable) return

      // Write initial state
      await sandbox.writeFile('/tmp/state.txt', 'original')

      // Create snapshot
      const { snapshotId } = await snapshotable.createSnapshot('before-change')
      expect(snapshotId).toMatch(/^snap-/)

      // Modify state
      await sandbox.writeFile('/tmp/state.txt', 'modified')
      const modified = await sandbox.readFile('/tmp/state.txt')
      expect(new TextDecoder().decode(modified)).toBe('modified')

      // Restore snapshot
      await snapshotable.restoreSnapshot(snapshotId)

      // Verify state is restored
      const restored = await sandbox.readFile('/tmp/state.txt')
      expect(new TextDecoder().decode(restored)).toBe('original')
    })

    it('create multiple snapshots and restore specific one', async () => {
      const sandbox = await provider.create({ image: 'node:22' })
      const snapshotable = withSnapshot(sandbox)
      if (!snapshotable) return

      await sandbox.writeFile('/tmp/v.txt', 'v1')
      const snap1 = await snapshotable.createSnapshot('v1')

      await sandbox.writeFile('/tmp/v.txt', 'v2')
      const snap2 = await snapshotable.createSnapshot('v2')

      await sandbox.writeFile('/tmp/v.txt', 'v3')

      // Restore to v1
      await snapshotable.restoreSnapshot(snap1.snapshotId)
      const content = new TextDecoder().decode(await sandbox.readFile('/tmp/v.txt'))
      expect(content).toBe('v1')

      // Restore to v2
      await snapshotable.restoreSnapshot(snap2.snapshotId)
      const content2 = new TextDecoder().decode(await sandbox.readFile('/tmp/v.txt'))
      expect(content2).toBe('v2')
    })

    it('restore non-existent snapshot throws SandboxNotFoundError', async () => {
      const sandbox = await provider.create({ image: 'node:22' })
      const snapshotable = withSnapshot(sandbox)
      if (!snapshotable) return

      await expect(snapshotable.restoreSnapshot('nonexistent')).rejects.toThrow(SandboxNotFoundError)
    })
  })

  // ─── getSandbox ───

  describe('getSandbox', () => {
    it('get() retrieves existing sandbox that can exec', async () => {
      const created = await provider.create({ image: 'node:22' })

      const fetched = await provider.get(created.id)
      expect(fetched.id).toBe(created.id)
      expect(fetched.state).toBe('running')

      const result = await fetched.exec('echo alive')
      expect(result.stdout).toContain('alive')
    })

    it('get() throws SandboxNotFoundError for non-existent ID', async () => {
      await expect(provider.get('cf-nonexistent')).rejects.toThrow(SandboxNotFoundError)
    })

    it('get() throws SandboxNotFoundError after sandbox is destroyed', async () => {
      const sandbox = await provider.create({ image: 'node:22' })
      await provider.destroy(sandbox.id)
      await expect(provider.get(sandbox.id)).rejects.toThrow(SandboxNotFoundError)
    })
  })

  // ─── listSandboxes ───

  describe('listSandboxes', () => {
    it('list() includes created sandboxes', async () => {
      await provider.create({ image: 'node:22' })
      await provider.create({ image: 'python:3.12' })

      const infos = await provider.list()
      expect(infos).toHaveLength(2)
      expect(infos.every(s => s.state === 'running')).toBe(true)
    })

    it('list() with state filter returns only matching', async () => {
      const s1 = await provider.create({ image: 'node:22' })
      await provider.create({ image: 'python:3.12' })
      await provider.destroy(s1.id)

      const running = await provider.list({ state: 'running' })
      expect(running).toHaveLength(1)

      const terminated = await provider.list({ state: 'terminated' })
      expect(terminated).toHaveLength(1)
      expect(terminated[0]!.id).toBe(s1.id)
    })

    it('list() with array state filter', async () => {
      const s1 = await provider.create({ image: 'node:22' })
      await provider.create({ image: 'python:3.12' })
      await provider.destroy(s1.id)

      const results = await provider.list({ state: ['running', 'terminated'] })
      expect(results).toHaveLength(2)
    })

    it('list() with limit', async () => {
      await provider.create({ image: 'a' })
      await provider.create({ image: 'b' })
      await provider.create({ image: 'c' })

      const results = await provider.list({ limit: 2 })
      expect(results).toHaveLength(2)
    })
  })

  // ─── destroySandbox ───

  describe('destroySandbox', () => {
    it('destroy marks sandbox as terminated', async () => {
      const sandbox = await provider.create({ image: 'node:22' })
      await provider.destroy(sandbox.id)

      expect(currentSandbox.destroy).toHaveBeenCalled()

      const list = await provider.list({ state: 'terminated' })
      expect(list.find(s => s.id === sandbox.id)).toBeDefined()
    })

    it('destroy is idempotent — double destroy does not throw', async () => {
      const sandbox = await provider.create({ image: 'node:22' })
      await provider.destroy(sandbox.id)
      await expect(provider.destroy(sandbox.id)).resolves.toBeUndefined()
    })

    it('destroy non-existent sandbox does not throw', async () => {
      await expect(provider.destroy('cf-nonexistent')).resolves.toBeUndefined()
    })
  })

  // ─── Volumes ───

  describe('volumes', () => {
    it('createVolume → listVolumes → deleteVolume lifecycle', async () => {
      const volumeProvider = withVolumes(provider)
      expect(volumeProvider).not.toBeNull()
      if (!volumeProvider) return

      // Create
      const vol = await volumeProvider.createVolume({ name: 'my-r2-bucket', sizeGB: 10 })
      expect(vol.id).toBe('my-r2-bucket')
      expect(vol.name).toBe('my-r2-bucket')
      expect(vol.sizeGB).toBe(10)
      expect(vol.attachedTo).toBeNull()

      // List
      const volumes = await volumeProvider.listVolumes()
      expect(volumes).toHaveLength(1)
      expect(volumes[0]!.id).toBe('my-r2-bucket')

      // Delete
      await volumeProvider.deleteVolume('my-r2-bucket')
      const afterDelete = await volumeProvider.listVolumes()
      expect(afterDelete).toHaveLength(0)
    })

    it('deleteVolume is idempotent', async () => {
      const volumeProvider = withVolumes(provider)
      if (!volumeProvider) return

      await expect(volumeProvider.deleteVolume('nonexistent')).resolves.toBeUndefined()
    })

    it('multiple volumes tracked correctly', async () => {
      const volumeProvider = withVolumes(provider)
      if (!volumeProvider) return

      await volumeProvider.createVolume({ name: 'bucket-a' })
      await volumeProvider.createVolume({ name: 'bucket-b' })
      await volumeProvider.createVolume({ name: 'bucket-c' })

      const volumes = await volumeProvider.listVolumes()
      expect(volumes).toHaveLength(3)

      await volumeProvider.deleteVolume('bucket-b')
      const after = await volumeProvider.listVolumes()
      expect(after).toHaveLength(2)
      expect(after.map(v => v.name).sort()).toEqual(['bucket-a', 'bucket-c'])
    })
  })

  // ─── Cross-cutting: capability helper integration ───

  describe('capability helpers', () => {
    it('withStreaming returns StreamableSandbox', async () => {
      const sandbox = await provider.create({ image: 'node:22' })
      const streamable = withStreaming(sandbox)
      expect(streamable).not.toBeNull()
      expect(typeof streamable!.execStream).toBe('function')
    })

    it('withPortExpose returns PortExposeSandbox', async () => {
      const sandbox = await provider.create({ image: 'node:22' })
      const portExpose = withPortExpose(sandbox)
      expect(portExpose).not.toBeNull()
      expect(typeof portExpose!.exposePort).toBe('function')
    })

    it('withSnapshot returns SnapshotSandbox', async () => {
      const sandbox = await provider.create({ image: 'node:22' })
      const snapshotable = withSnapshot(sandbox)
      expect(snapshotable).not.toBeNull()
      expect(typeof snapshotable!.createSnapshot).toBe('function')
      expect(typeof snapshotable!.restoreSnapshot).toBe('function')
    })

    it('withVolumes returns VolumeProvider', () => {
      const volumeProvider = withVolumes(provider)
      expect(volumeProvider).not.toBeNull()
      expect(typeof volumeProvider!.createVolume).toBe('function')
      expect(typeof volumeProvider!.deleteVolume).toBe('function')
      expect(typeof volumeProvider!.listVolumes).toBe('function')
    })
  })

  // ─── Error handling ───

  describe('error wrapping', () => {
    it('createSandbox wraps SDK errors as ProviderError', async () => {
      mockGetSandbox.mockImplementationOnce(() => { throw new Error('namespace binding failed') })
      await expect(provider.create({ image: 'bad-image' })).rejects.toThrow(ProviderError)
    })

    it('ProviderError includes provider name', async () => {
      mockGetSandbox.mockImplementationOnce(() => { throw new Error('boom') })
      try {
        await provider.create({ image: 'bad' })
        expect.fail('should have thrown')
      } catch (err) {
        expect(err).toBeInstanceOf(ProviderError)
        expect((err as ProviderError).provider).toBe('cloudflare')
      }
    })
  })

  // ─── Sandbox isolation ───

  describe('sandbox isolation', () => {
    it('each sandbox has independent filesystem', async () => {
      const sandbox1 = await provider.create({ image: 'node:22' })
      const sandbox2 = await provider.create({ image: 'node:22' })

      await sandbox1.writeFile('/tmp/isolated.txt', 'sandbox1')
      await sandbox2.writeFile('/tmp/isolated.txt', 'sandbox2')

      const read1 = new TextDecoder().decode(await sandbox1.readFile('/tmp/isolated.txt'))
      const read2 = new TextDecoder().decode(await sandbox2.readFile('/tmp/isolated.txt'))

      expect(read1).toBe('sandbox1')
      expect(read2).toBe('sandbox2')
    })

    it('each sandbox has independent env vars', async () => {
      await provider.create({
        image: 'node:22',
        env: { ROLE: 'worker' },
      })
      const sandbox1EnvCall = currentSandbox.setEnvVars.mock.calls[0]

      await provider.create({
        image: 'node:22',
        env: { ROLE: 'manager' },
      })
      const sandbox2EnvCall = currentSandbox.setEnvVars.mock.calls[0]

      expect(sandbox1EnvCall).toEqual([{ ROLE: 'worker' }])
      expect(sandbox2EnvCall).toEqual([{ ROLE: 'manager' }])
    })
  })

  // ─── getSandbox reconnection ───

  describe('reconnection', () => {
    it('getSandbox creates fresh SDK connection', async () => {
      const sandbox = await provider.create({ image: 'node:22' })
      const createCallCount = mockGetSandbox.mock.calls.length

      // get() should call getSandbox SDK function again
      await provider.get(sandbox.id)
      expect(mockGetSandbox.mock.calls.length).toBeGreaterThan(createCallCount)
    })

    it('reconnected sandbox can execute commands', async () => {
      const created = await provider.create({ image: 'node:22' })
      const reconnected = await provider.get(created.id)

      const result = await reconnected.exec('echo reconnected')
      expect(result.exitCode).toBe(0)
      expect(result.stdout).toContain('reconnected')
    })
  })
})
