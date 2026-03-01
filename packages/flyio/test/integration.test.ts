/**
 * FlyioAdapter Integration Tests — Real Fly.io Machines API
 *
 * These tests create, exec, and destroy real Fly.io machines.
 * They require the following environment variables:
 *
 *   FLY_API_TOKEN   — Fly.io API token (from `fly tokens create`)
 *   FLY_APP_NAME    — Fly.io app name (must already exist)
 *   FLY_REGION      — Region for machines/volumes (default: 'nrt')
 *
 * If FLY_API_TOKEN is not set, all tests will be skipped.
 *
 * ⚠️  Each test run will create real machines and volumes that cost money.
 *     The afterAll hook does best-effort cleanup, but leaked resources are possible.
 */
import { describe, it, expect, afterAll } from 'vitest'
import {
  createProvider,
  withVolumes,
  withPortExpose,
  withTerminal,
  hasCapability,
  SandboxNotFoundError,
  ProviderError,

} from '@sandbank/core'
import { FlyioAdapter } from '../src/index.js'

// ─── Environment ───

const API_TOKEN = process.env['FLY_API_TOKEN'] ?? ''
const APP_NAME = process.env['FLY_APP_NAME'] ?? ''
const REGION = process.env['FLY_REGION'] ?? 'nrt'

const skip = !API_TOKEN || !APP_NAME

const adapter = new FlyioAdapter({ apiToken: API_TOKEN, appName: APP_NAME, region: REGION })
const provider = createProvider(adapter)

// Shared sandbox for most tests (created once, destroyed at the end)
let sharedSandboxId: string | null = null
const extraCleanupIds: string[] = []
const volumeCleanupIds: string[] = []

afterAll(async () => {
  // Best-effort cleanup: destroy sandboxes then volumes
  const ids = [...extraCleanupIds]
  if (sharedSandboxId) ids.push(sharedSandboxId)
  for (const id of ids) {
    try { await provider.destroy(id) } catch { /* best effort */ }
  }
  const vp = withVolumes(provider)
  if (vp) {
    for (const volId of volumeCleanupIds) {
      try { await vp.deleteVolume(volId) } catch { /* best effort */ }
    }
  }
})

describe.skipIf(skip)('FlyioAdapter integration', () => {

  // ─── Adapter identity ───

  it('adapter has correct name and capabilities', () => {
    expect(adapter.name).toBe('flyio')
    expect(hasCapability(provider, 'volumes')).toBe(true)
    expect(hasCapability(provider, 'port.expose')).toBe(true)
    expect(hasCapability(provider, 'terminal')).toBe(true)
    // Capabilities we don't support
    expect(hasCapability(provider, 'exec.stream')).toBe(false)
    expect(hasCapability(provider, 'sleep')).toBe(false)
    expect(hasCapability(provider, 'snapshot')).toBe(false)
  })

  // ─── createSandbox ───

  it('create sandbox with image + resources', async () => {
    const sandbox = await provider.create({
      image: 'ubuntu:24.04',
      resources: { cpu: 1, memory: 256 },
    })
    sharedSandboxId = sandbox.id

    expect(sandbox.id).toBeTruthy()
    expect(typeof sandbox.id).toBe('string')
    expect(sandbox.state).toBe('running')
    expect(sandbox.createdAt).toBeTruthy()
    console.log(`  created: ${sandbox.id}`)
  })

  it('create sandbox with env vars', async () => {
    const sandbox = await provider.create({
      image: 'ubuntu:24.04',
      env: { MY_VAR: 'hello_sandbank', ANOTHER: '42' },
    })
    extraCleanupIds.push(sandbox.id)

    const result = await sandbox.exec('echo "$MY_VAR $ANOTHER"')
    expect(result.exitCode).toBe(0)
    expect(result.stdout).toContain('hello_sandbank')
    expect(result.stdout).toContain('42')
    console.log('  env vars injected ok')

    await provider.destroy(sandbox.id)
    extraCleanupIds.splice(extraCleanupIds.indexOf(sandbox.id), 1)
  })

  // ─── exec ───

  it('exec basic command', async () => {
    const sandbox = await provider.get(sharedSandboxId!)
    const result = await sandbox.exec('echo "hello sandbank"')
    expect(result.exitCode).toBe(0)
    expect(result.stdout).toContain('hello sandbank')
    expect(typeof result.stderr).toBe('string')
  })

  it('exec with cwd', async () => {
    const sandbox = await provider.get(sharedSandboxId!)
    const result = await sandbox.exec('pwd', { cwd: '/tmp' })
    expect(result.exitCode).toBe(0)
    expect(result.stdout.trim()).toBe('/tmp')
  })

  it('exec non-zero exit code', async () => {
    const sandbox = await provider.get(sharedSandboxId!)
    const result = await sandbox.exec('exit 42')
    expect(result.exitCode).toBe(42)
  })

  it('exec multiline output', async () => {
    const sandbox = await provider.get(sharedSandboxId!)
    const result = await sandbox.exec('echo "line1" && echo "line2" && echo "line3"')
    expect(result.exitCode).toBe(0)
    expect(result.stdout).toContain('line1')
    expect(result.stdout).toContain('line2')
    expect(result.stdout).toContain('line3')
  })

  // ─── writeFile / readFile (via exec fallback) ───

  it('writeFile + readFile (text, UTF-8 with multibyte)', async () => {
    const sandbox = await provider.get(sharedSandboxId!)
    const content = 'Sandbank SDK test — 你好世界 🌍'
    await sandbox.writeFile('/tmp/sandbank-test.txt', content)
    const readBack = await sandbox.readFile('/tmp/sandbank-test.txt')
    expect(new TextDecoder().decode(readBack)).toBe(content)
  })

  it('writeFile + readFile (binary)', async () => {
    const sandbox = await provider.get(sharedSandboxId!)
    const data = new Uint8Array([0, 1, 2, 255, 254, 253])
    await sandbox.writeFile('/tmp/binary-test.bin', data)
    const readBack = await sandbox.readFile('/tmp/binary-test.bin')
    expect(readBack).toEqual(data)
  })

  it('writeFile + readFile (empty file)', async () => {
    const sandbox = await provider.get(sharedSandboxId!)
    await sandbox.writeFile('/tmp/empty.txt', '')
    const readBack = await sandbox.readFile('/tmp/empty.txt')
    expect(readBack.byteLength).toBe(0)
  })

  it('writeFile creates parent directories', async () => {
    const sandbox = await provider.get(sharedSandboxId!)
    await sandbox.writeFile('/tmp/deep/nested/dir/file.txt', 'nested')
    const readBack = await sandbox.readFile('/tmp/deep/nested/dir/file.txt')
    expect(new TextDecoder().decode(readBack)).toBe('nested')
  })

  it('writeFile overwrites existing file', async () => {
    const sandbox = await provider.get(sharedSandboxId!)
    await sandbox.writeFile('/tmp/overwrite.txt', 'first')
    await sandbox.writeFile('/tmp/overwrite.txt', 'second')
    const readBack = await sandbox.readFile('/tmp/overwrite.txt')
    expect(new TextDecoder().decode(readBack)).toBe('second')
  })

  // ─── getSandbox ───

  it('get() retrieves existing sandbox with correct state', async () => {
    const fetched = await provider.get(sharedSandboxId!)
    expect(fetched.id).toBe(sharedSandboxId)
    expect(fetched.state).toBe('running')
    expect(fetched.createdAt).toBeTruthy()
    // Can exec on fetched sandbox
    const result = await fetched.exec('echo alive')
    expect(result.stdout).toContain('alive')
  })

  it('get() throws SandboxNotFoundError for non-existent ID', async () => {
    try {
      await provider.get('nonexistent_machine_id_12345')
      expect.fail('should have thrown')
    } catch (err) {
      expect(err).toBeInstanceOf(SandboxNotFoundError)
      const snfErr = err as SandboxNotFoundError
      expect(snfErr.provider).toBe('flyio')
      expect(snfErr.sandboxId).toBe('nonexistent_machine_id_12345')
    }
  })

  // ─── listSandboxes ───

  it('list() includes the sandbox', async () => {
    const infos = await provider.list()
    const found = infos.find(s => s.id === sharedSandboxId)
    expect(found).toBeDefined()
    expect(found!.state).toBe('running')
    expect(found!.id).toBe(sharedSandboxId)
    expect(found!.region).toBeTruthy()
  })

  it('list() with state filter returns only matching sandboxes', async () => {
    const running = await provider.list({ state: 'running' })
    expect(running.length).toBeGreaterThan(0)
    for (const s of running) {
      expect(s.state).toBe('running')
    }

    // Filter for a state that our sandbox isn't in
    const terminated = await provider.list({ state: 'terminated' })
    expect(terminated.find(s => s.id === sharedSandboxId)).toBeUndefined()
  })

  it('list() with array state filter', async () => {
    const results = await provider.list({ state: ['running', 'stopped'] })
    for (const s of results) {
      expect(['running', 'stopped']).toContain(s.state)
    }
  })

  // ─── exposePort ───

  describe('exposePort', () => {
    it('exposePort returns a URL for a port', async () => {
      const sandbox = await provider.get(sharedSandboxId!)
      const portExpose = withPortExpose(sandbox)
      expect(portExpose).not.toBeNull()
      if (!portExpose) return

      const result = await portExpose.exposePort(8080)
      expect(result.url).toBeTruthy()
      expect(typeof result.url).toBe('string')
      expect(result.url).toContain(APP_NAME)
      console.log(`  exposePort(8080) → ${result.url}`)
    })
  })

  // ─── startTerminal ───

  describe('startTerminal', () => {
    let terminalSandboxId: string | null = null

    afterAll(async () => {
      if (terminalSandboxId) {
        try { await provider.destroy(terminalSandboxId) } catch { /* best effort */ }
      }
    })

    it('startTerminal installs ttyd and returns WebSocket URL', async () => {
      const sandbox = await provider.create({
        image: 'ubuntu:24.04',
        resources: { cpu: 1, memory: 256 },
      })
      terminalSandboxId = sandbox.id
      console.log(`  terminal sandbox created: ${sandbox.id}`)

      const terminal = withTerminal(sandbox)
      expect(terminal).not.toBeNull()
      if (!terminal) return

      const info = await terminal.startTerminal()
      expect(info.url).toMatch(/^wss?:\/\//)
      expect(info.url).toContain(APP_NAME)
      expect(info.port).toBe(8080)
      console.log(`  startTerminal → ${info.url}`)

      // Verify ttyd is actually running inside the sandbox
      const check = await sandbox.exec('pgrep -x ttyd')
      expect(check.exitCode).toBe(0)
      console.log('  ttyd process is running')
    }, 120_000)

    it('startTerminal with custom shell', async () => {
      const sandbox = await provider.get(terminalSandboxId!)
      const terminal = withTerminal(sandbox)
      if (!terminal) return

      // Kill existing ttyd first
      await sandbox.exec('pkill ttyd || true')
      await new Promise(r => setTimeout(r, 1000))

      const info = await terminal.startTerminal({ shell: '/bin/sh' })
      expect(info.url).toMatch(/^wss?:\/\//)
      expect(info.port).toBe(8080)
      console.log(`  startTerminal(sh) → ${info.url}`)
    }, 120_000)
  })

  // ─── uploadArchive / downloadArchive (via exec fallback) ───

  describe('archive operations', () => {
    it('uploadArchive extracts files into sandbox', async () => {
      const sandbox = await provider.get(sharedSandboxId!)

      // Create a tar.gz in the sandbox, then download its bytes to use as upload input
      await sandbox.exec('mkdir -p /tmp/archive-src && echo "archive-test" > /tmp/archive-src/hello.txt')
      const tarResult = await sandbox.exec('tar czf /tmp/test-archive.tar.gz -C /tmp/archive-src . && base64 /tmp/test-archive.tar.gz')
      expect(tarResult.exitCode).toBe(0)

      const clean = tarResult.stdout.replace(/\s/g, '')
      const binary = atob(clean)
      const archiveBytes = new Uint8Array(binary.length)
      for (let i = 0; i < binary.length; i++) {
        archiveBytes[i] = binary.charCodeAt(i)
      }

      // Upload the archive to a different directory
      await sandbox.uploadArchive(archiveBytes, '/tmp/archive-dest')

      // Verify the file was extracted
      const check = await sandbox.exec('cat /tmp/archive-dest/hello.txt')
      expect(check.exitCode).toBe(0)
      expect(check.stdout.trim()).toBe('archive-test')
    })

    it('downloadArchive returns a valid tar.gz stream', async () => {
      const sandbox = await provider.get(sharedSandboxId!)

      // Create some files to archive
      await sandbox.exec('mkdir -p /tmp/dl-src && echo "download-test" > /tmp/dl-src/data.txt')

      const stream = await sandbox.downloadArchive('/tmp/dl-src')
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

      // Verify it's valid by uploading it back
      const totalLength = chunks.reduce((sum, c) => sum + c.length, 0)
      const allBytes = new Uint8Array(totalLength)
      let offset = 0
      for (const chunk of chunks) {
        allBytes.set(chunk, offset)
        offset += chunk.length
      }

      await sandbox.uploadArchive(allBytes, '/tmp/dl-verify')
      const check = await sandbox.exec('cat /tmp/dl-verify/data.txt')
      expect(check.exitCode).toBe(0)
      expect(check.stdout.trim()).toBe('download-test')
    })

    it('upload → download round-trip preserves content', async () => {
      const sandbox = await provider.get(sharedSandboxId!)

      // Create source files
      await sandbox.exec('mkdir -p /tmp/rt-src && echo "round-trip" > /tmp/rt-src/file.txt && echo "second" > /tmp/rt-src/file2.txt')

      // Create a tar.gz from source
      const tarResult = await sandbox.exec('tar czf /tmp/rt.tar.gz -C /tmp/rt-src . && base64 /tmp/rt.tar.gz')
      expect(tarResult.exitCode).toBe(0)
      const clean = tarResult.stdout.replace(/\s/g, '')
      const binary = atob(clean)
      const archiveBytes = new Uint8Array(binary.length)
      for (let i = 0; i < binary.length; i++) {
        archiveBytes[i] = binary.charCodeAt(i)
      }

      // Upload to new dir
      await sandbox.uploadArchive(archiveBytes, '/tmp/rt-dest')

      // Download from that dir
      const stream = await sandbox.downloadArchive('/tmp/rt-dest')
      const reader = stream.getReader()
      const chunks: Uint8Array[] = []
      while (true) {
        const { done, value } = await reader.read()
        if (done) break
        chunks.push(value)
      }
      const totalLength = chunks.reduce((sum, c) => sum + c.length, 0)
      const downloaded = new Uint8Array(totalLength)
      let offset = 0
      for (const chunk of chunks) {
        downloaded.set(chunk, offset)
        offset += chunk.length
      }

      // Upload downloaded archive to yet another dir to verify
      await sandbox.uploadArchive(downloaded, '/tmp/rt-verify')
      const check1 = await sandbox.exec('cat /tmp/rt-verify/file.txt')
      expect(check1.stdout.trim()).toBe('round-trip')
      const check2 = await sandbox.exec('cat /tmp/rt-verify/file2.txt')
      expect(check2.stdout.trim()).toBe('second')
    })
  })

  // ─── destroySandbox ───

  it('destroy is idempotent — double destroy does not throw', async () => {
    await provider.destroy(sharedSandboxId!)
    const destroyedId = sharedSandboxId!
    sharedSandboxId = null
    // Second destroy should not throw
    await expect(provider.destroy(destroyedId)).resolves.toBeUndefined()
  })

  it('destroy non-existent sandbox does not throw', async () => {
    await expect(
      provider.destroy('nonexistent_machine_id_12345'),
    ).resolves.toBeUndefined()
  })

  // ─── Volumes ───

  describe('volumes', () => {
    it('createVolume → listVolumes → deleteVolume full lifecycle', async () => {
      const volumeProvider = withVolumes(provider)
      expect(volumeProvider).not.toBeNull()
      if (!volumeProvider) return

      // Create
      const vol = await volumeProvider.createVolume({
        name: `sb_test_${Date.now()}`,
        region: REGION,
        sizeGB: 1,
      })
      volumeCleanupIds.push(vol.id)
      expect(vol.id).toBeTruthy()
      expect(typeof vol.id).toBe('string')
      expect(vol.name).toBeTruthy()
      expect(vol.attachedTo).toBeNull()
      expect(typeof vol.sizeGB).toBe('number')
      expect(vol.sizeGB).toBeGreaterThan(0)
      console.log(`  volume created: ${vol.id}`)

      // List — should include our volume
      const volumes = await volumeProvider.listVolumes()
      const found = volumes.find(v => v.id === vol.id)
      expect(found).toBeDefined()
      expect(found!.name).toBe(vol.name)
      expect(found!.attachedTo).toBeNull()

      // Delete
      await volumeProvider.deleteVolume(vol.id)
      volumeCleanupIds.splice(volumeCleanupIds.indexOf(vol.id), 1)

      // Poll until gone (eventually consistent)
      let gone = false
      for (let i = 0; i < 10; i++) {
        await new Promise(r => setTimeout(r, 2000))
        const afterDelete = await volumeProvider.listVolumes()
        if (!afterDelete.find(v => v.id === vol.id)) {
          gone = true
          break
        }
      }
      expect(gone).toBe(true)
      console.log('  volume lifecycle ok')
    })

    it('deleteVolume is idempotent — non-existent volume does not throw', async () => {
      const volumeProvider = withVolumes(provider)
      if (!volumeProvider) return

      await expect(
        volumeProvider.deleteVolume('vol_nonexistent12345'),
      ).resolves.toBeUndefined()
    })

    it('volume mount — data is accessible inside sandbox', async () => {
      const volumeProvider = withVolumes(provider)
      if (!volumeProvider) return

      const vol = await volumeProvider.createVolume({
        name: `sb_mount_${Date.now()}`,
        region: REGION,
        sizeGB: 1,
      })
      volumeCleanupIds.push(vol.id)

      try {
        const sandbox = await provider.create({
          image: 'ubuntu:24.04',
          volumes: [{ id: vol.id, mountPath: '/workspace' }],
        })
        extraCleanupIds.push(sandbox.id)

        // Write via exec, verify mount works
        await sandbox.exec('echo "persistent" > /workspace/test.txt')
        const result = await sandbox.exec('cat /workspace/test.txt')
        expect(result.stdout).toContain('persistent')

        // Verify mount point exists
        const df = await sandbox.exec('df /workspace')
        expect(df.exitCode).toBe(0)
        console.log('  volume mount + data ok')

        await provider.destroy(sandbox.id)
        extraCleanupIds.splice(extraCleanupIds.indexOf(sandbox.id), 1)
      } finally {
        await volumeProvider.deleteVolume(vol.id)
        volumeCleanupIds.splice(volumeCleanupIds.indexOf(vol.id), 1)
      }
    })
  })

  // ─── Error wrapping ───

  describe('error wrapping', () => {
    it('createSandbox wraps errors as ProviderError', async () => {
      try {
        await provider.create({ image: 'nonexistent-image-that-will-never-exist:99.99' })
        expect.fail('should have thrown')
      } catch (err) {
        expect(err).toBeInstanceOf(ProviderError)
        expect((err as ProviderError).provider).toBe('flyio')
      }
    })
  })
})
