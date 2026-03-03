import { describe, it, expect, afterAll } from 'vitest'
import {
  createProvider,
  withSleep,
  withSnapshot,
  withPortExpose,
  withTerminal,
  withStreaming,
  hasCapability,
  SandboxNotFoundError,
  ProviderError,
} from '@sandbank/core'
import { BoxLiteAdapter } from '../src/index.js'

const API_TOKEN = process.env['BOXLITE_API_TOKEN'] ?? ''
const API_URL = process.env['BOXLITE_API_URL'] ?? ''
const CLIENT_ID = process.env['BOXLITE_CLIENT_ID'] ?? ''
const CLIENT_SECRET = process.env['BOXLITE_CLIENT_SECRET'] ?? ''
const PREFIX = process.env['BOXLITE_PREFIX'] ?? 'default'
// Skip if no API URL or neither auth method provided
const skip = !API_URL || (!API_TOKEN && (!CLIENT_ID || !CLIENT_SECRET))

const adapter = new BoxLiteAdapter({
  apiUrl: API_URL,
  prefix: PREFIX,
  ...(API_TOKEN ? { apiToken: API_TOKEN } : { clientId: CLIENT_ID, clientSecret: CLIENT_SECRET }),
})
const provider = createProvider(adapter)

// Shared sandbox for most tests (created once, destroyed at the end)
let sharedSandboxId: string | null = null
const extraCleanupIds: string[] = []

afterAll(async () => {
  const ids = [...extraCleanupIds]
  if (sharedSandboxId) ids.push(sharedSandboxId)
  for (const id of ids) {
    try { await provider.destroy(id) } catch { /* best effort */ }
  }
})

describe.skipIf(skip)('BoxLiteAdapter integration', () => {
  // ─── Adapter identity ───

  it('adapter has correct name and capabilities', () => {
    expect(adapter.name).toBe('boxlite')
    expect(hasCapability(provider, 'exec.stream')).toBe(true)
    expect(hasCapability(provider, 'terminal')).toBe(true)
    expect(hasCapability(provider, 'sleep')).toBe(true)
    expect(hasCapability(provider, 'snapshot')).toBe(true)
    expect(hasCapability(provider, 'port.expose')).toBe(true)
    // Capabilities we don't support
    expect(hasCapability(provider, 'volumes')).toBe(false)
  })

  // ─── createSandbox ───

  it('create sandbox with image + resources', async () => {
    const sandbox = await provider.create({
      image: 'ubuntu:24.04',
      resources: { cpu: 1, memory: 512 },
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

  it('exec with cwd via cd fallback', async () => {
    const sandbox = await provider.get(sharedSandboxId!)
    // working_dir may not be supported by all runtimes, verify via cd
    const result = await sandbox.exec('cd /tmp && pwd')
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
    const content = 'Sandbank SDK test — 你好世界'
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
    const result = await fetched.exec('echo alive')
    expect(result.stdout).toContain('alive')
  })

  it('get() throws SandboxNotFoundError for non-existent ID', async () => {
    try {
      await provider.get('nonexistent-box-id-00000')
      expect.fail('should have thrown')
    } catch (err) {
      expect(err).toBeInstanceOf(SandboxNotFoundError)
      const snfErr = err as SandboxNotFoundError
      expect(snfErr.provider).toBe('boxlite')
    }
  })

  // ─── listSandboxes ───

  it('list() includes the sandbox', async () => {
    const infos = await provider.list()
    const found = infos.find(s => s.id === sharedSandboxId)
    expect(found).toBeDefined()
    expect(found!.state).toBe('running')
  })

  it('list() with state filter returns only matching sandboxes', async () => {
    const running = await provider.list({ state: 'running' })
    expect(running.length).toBeGreaterThan(0)
    for (const s of running) {
      expect(s.state).toBe('running')
    }
  })

  // ─── exec.stream ───

  describe('exec.stream', () => {
    it('execStream returns readable stream with output', async () => {
      const sandbox = await provider.get(sharedSandboxId!)
      const streamable = withStreaming(sandbox)
      expect(streamable).not.toBeNull()
      if (!streamable) return

      const stream = await streamable.execStream('echo stream-test')
      const reader = stream.getReader()
      let collected = ''
      while (true) {
        const { done, value } = await reader.read()
        if (done) break
        collected += new TextDecoder().decode(value)
      }
      expect(collected).toContain('stream-test')
    })
  })

  // ─── snapshot ───

  describe('snapshot', () => {
    it('create and restore snapshot', async () => {
      const sandbox = await provider.get(sharedSandboxId!)
      const snapshotable = withSnapshot(sandbox)
      expect(snapshotable).not.toBeNull()
      if (!snapshotable) return

      // Write a file, snapshot, modify, restore, verify
      await sandbox.writeFile('/tmp/snap-test.txt', 'before-snapshot')
      const { snapshotId } = await snapshotable.createSnapshot('test-snap')
      expect(snapshotId).toBeTruthy()
      console.log(`  snapshot created: ${snapshotId}`)

      await sandbox.writeFile('/tmp/snap-test.txt', 'after-modification')
      await snapshotable.restoreSnapshot(snapshotId)

      const readBack = await sandbox.readFile('/tmp/snap-test.txt')
      expect(new TextDecoder().decode(readBack)).toBe('before-snapshot')
      console.log('  snapshot restore verified')
    })
  })

  // ─── sleep / wake ───

  describe('sleep / wake', () => {
    let sleepSandboxId: string | null = null

    afterAll(async () => {
      if (sleepSandboxId) {
        try { await provider.destroy(sleepSandboxId) } catch { /* best effort */ }
      }
    })

    it('sleep stops the sandbox, wake starts it', async () => {
      const sandbox = await provider.create({ image: 'ubuntu:24.04' })
      sleepSandboxId = sandbox.id

      const sleepable = withSleep(sandbox)
      expect(sleepable).not.toBeNull()
      if (!sleepable) return

      await sleepable.sleep()
      const afterSleep = await provider.get(sandbox.id)
      expect(afterSleep.state).toBe('stopped')

      await sleepable.wake()
      // Wait a bit for the box to start
      await new Promise(r => setTimeout(r, 3000))
      const afterWake = await provider.get(sandbox.id)
      expect(afterWake.state).toBe('running')
      console.log('  sleep/wake cycle ok')
    }, 60_000)
  })

  // ─── exposePort ───

  describe('exposePort', () => {
    it('exposePort returns a URL', async () => {
      const sandbox = await provider.get(sharedSandboxId!)
      const portExpose = withPortExpose(sandbox)
      expect(portExpose).not.toBeNull()
      if (!portExpose) return

      const result = await portExpose.exposePort(8080)
      expect(result.url).toBeTruthy()
      expect(typeof result.url).toBe('string')
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
      const sandbox = await provider.create({ image: 'ubuntu:24.04' })
      terminalSandboxId = sandbox.id

      const terminal = withTerminal(sandbox)
      expect(terminal).not.toBeNull()
      if (!terminal) return

      const info = await terminal.startTerminal()
      expect(info.url).toMatch(/^wss?:\/\//)
      expect(info.url).toContain('/ws')
      expect(info.port).toBe(7681)
      console.log(`  startTerminal → ${info.url}`)

      // Verify ttyd is actually running
      const check = await sandbox.exec('pgrep -x ttyd')
      expect(check.exitCode).toBe(0)
    }, 120_000)
  })

  // ─── uploadArchive / downloadArchive ───

  describe('archive operations', () => {
    it('uploadArchive extracts files into sandbox', async () => {
      const sandbox = await provider.get(sharedSandboxId!)

      await sandbox.exec('mkdir -p /tmp/archive-src && echo "archive-test" > /tmp/archive-src/hello.txt')
      const tarResult = await sandbox.exec('tar czf /tmp/test-archive.tar.gz -C /tmp/archive-src . && base64 /tmp/test-archive.tar.gz')
      expect(tarResult.exitCode).toBe(0)

      const clean = tarResult.stdout.replace(/\s/g, '')
      const binary = atob(clean)
      const archiveBytes = new Uint8Array(binary.length)
      for (let i = 0; i < binary.length; i++) {
        archiveBytes[i] = binary.charCodeAt(i)
      }

      await sandbox.uploadArchive(archiveBytes, '/tmp/archive-dest')

      const check = await sandbox.exec('cat /tmp/archive-dest/hello.txt')
      expect(check.exitCode).toBe(0)
      expect(check.stdout.trim()).toBe('archive-test')
    })

    it('downloadArchive returns a valid stream', async () => {
      const sandbox = await provider.get(sharedSandboxId!)

      await sandbox.exec('mkdir -p /tmp/dl-src && echo "download-test" > /tmp/dl-src/data.txt')

      const stream = await sandbox.downloadArchive('/tmp/dl-src')
      expect(stream).toBeInstanceOf(ReadableStream)

      const reader = stream.getReader()
      const chunks: Uint8Array[] = []
      while (true) {
        const { done, value } = await reader.read()
        if (done) break
        chunks.push(value)
      }
      expect(chunks.length).toBeGreaterThan(0)
    })
  })

  // ─── destroySandbox ───

  it('destroy is idempotent — double destroy does not throw', async () => {
    await provider.destroy(sharedSandboxId!)
    const destroyedId = sharedSandboxId!
    sharedSandboxId = null
    await expect(provider.destroy(destroyedId)).resolves.toBeUndefined()
  })

  it('destroy non-existent sandbox does not throw', async () => {
    await expect(
      provider.destroy('nonexistent-box-00000'),
    ).resolves.toBeUndefined()
  })

  // ─── Error wrapping ───

  describe('error wrapping', () => {
    it('createSandbox wraps errors as ProviderError', async () => {
      try {
        await provider.create({ image: 'nonexistent-image-that-will-never-exist:99.99' })
        expect.fail('should have thrown')
      } catch (err) {
        expect(err).toBeInstanceOf(ProviderError)
        expect((err as ProviderError).provider).toBe('boxlite')
      }
    })
  })
})
