import { describe, it, expect, afterAll } from 'vitest'
import { createProvider, withVolumes, hasCapability } from '@sandbank/core'
import { DaytonaAdapter } from '../src/index.js'

const API_KEY = process.env['DAYTONA_API_KEY'] ?? ''
const API_URL = process.env['DAYTONA_API_URL'] ?? 'https://app.daytona.io/api'

const adapter = new DaytonaAdapter({ apiKey: API_KEY, apiUrl: API_URL })
const provider = createProvider(adapter)

// Shared sandbox for most tests (created once, destroyed in afterAll)
let sharedSandboxId: string | null = null
const extraCleanupIds: string[] = []

afterAll(async () => {
  const ids = [...extraCleanupIds]
  if (sharedSandboxId) ids.push(sharedSandboxId)
  for (const id of ids) {
    try { await provider.destroy(id) } catch { /* best effort */ }
  }
})

describe('DaytonaAdapter integration', () => {
  it('adapter has correct name and capabilities', () => {
    expect(adapter.name).toBe('daytona')
    expect(hasCapability(provider, 'volumes')).toBe(true)
    expect(hasCapability(provider, 'exec.stream')).toBe(true)
    expect(hasCapability(provider, 'port.expose')).toBe(true)
  })

  it('create sandbox', async () => {
    const sandbox = await provider.create({
      image: 'ubuntu:latest',
      resources: { cpu: 1, memory: 1, disk: 5 },
      autoDestroyMinutes: 10,
    })
    sharedSandboxId = sandbox.id

    expect(sandbox.id).toBeTruthy()
    expect(sandbox.state).toBe('running')
    console.log(`  created: ${sandbox.id}`)
  })

  it('exec basic command', async () => {
    const sandbox = await provider.get(sharedSandboxId!)
    const result = await sandbox.exec('echo "hello sandbank"')
    expect(result.exitCode).toBe(0)
    expect(result.stdout).toContain('hello sandbank')
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

  it('writeFile + readFile (text, UTF-8)', async () => {
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

  it('get() retrieves existing sandbox', async () => {
    const fetched = await provider.get(sharedSandboxId!)
    expect(fetched.id).toBe(sharedSandboxId)
    expect(fetched.state).toBe('running')
    const result = await fetched.exec('echo alive')
    expect(result.stdout).toContain('alive')
  })

  it('list() includes the sandbox', async () => {
    const infos = await provider.list()
    const found = infos.find(s => s.id === sharedSandboxId)
    expect(found).toBeDefined()
    expect(found!.state).toBe('running')
  })

  it('destroy shared sandbox', async () => {
    await provider.destroy(sharedSandboxId!)
    const destroyedId = sharedSandboxId!
    sharedSandboxId = null
    // Second destroy should not throw (idempotent)
    await expect(provider.destroy(destroyedId)).resolves.toBeUndefined()
  })

  describe('volumes', () => {
    it('createVolume → listVolumes → deleteVolume', async () => {
      const volumeProvider = withVolumes(provider)
      expect(volumeProvider).not.toBeNull()
      if (!volumeProvider) return

      const vol = await volumeProvider.createVolume({ name: `sandbank-test-${Date.now()}` })
      expect(vol.id).toBeTruthy()
      expect(vol.attachedTo).toBeNull()
      console.log(`  volume created: ${vol.id}`)

      const volumes = await volumeProvider.listVolumes()
      expect(volumes.find(v => v.id === vol.id)).toBeDefined()

      await volumeProvider.deleteVolume(vol.id)

      // Volume deletion is eventually consistent — poll until gone
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

    it('volume mount on sandbox', async () => {
      const volumeProvider = withVolumes(provider)
      if (!volumeProvider) return

      const vol = await volumeProvider.createVolume({ name: `sandbank-mount-${Date.now()}` })

      try {
        const sandbox = await provider.create({
          image: 'ubuntu:latest',
          autoDestroyMinutes: 5,
          volumes: [{ id: vol.id, mountPath: '/workspace' }],
        })
        extraCleanupIds.push(sandbox.id)

        await sandbox.exec('echo "persistent" > /workspace/test.txt')
        const result = await sandbox.exec('cat /workspace/test.txt')
        expect(result.stdout).toContain('persistent')
        console.log('  volume mount + write ok')

        await provider.destroy(sandbox.id)
        extraCleanupIds.splice(extraCleanupIds.indexOf(sandbox.id), 1)
      } finally {
        await volumeProvider.deleteVolume(vol.id)
      }
    })
  })
})
