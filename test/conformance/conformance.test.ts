/**
 * Cross-Provider Conformance Tests
 *
 * Proves that the same set of operations behaves consistently across different
 * providers, and that hot-swapping providers requires zero application code changes.
 *
 * Environment variables:
 *   DAYTONA_API_KEY  + DAYTONA_API_URL (optional) → Daytona provider
 *   E2E_WORKER_URL                                → Cloudflare provider (via HTTP adapter)
 *   FLY_API_TOKEN + FLY_APP_NAME                  → Fly.io provider
 *
 * - None set     → all tests skip
 * - One set      → that provider's conformance tests run; hot-swap skips
 * - 2+ set       → full suite including hot-swap
 */
import { describe, it, expect, beforeAll, afterAll } from 'vitest'
import { createProvider } from '@sandbank/core'
import type { SandboxProvider, Sandbox } from '@sandbank/core'
import { CloudflareHttpAdapter } from './cloudflare-http-adapter.js'

interface ProviderEntry {
  name: string
  provider: SandboxProvider
}

// ---------------------------------------------------------------------------
// Build the list of available providers from environment variables
// ---------------------------------------------------------------------------

const providers: ProviderEntry[] = []

if (process.env.DAYTONA_API_KEY) {
  // Dynamic import to avoid hard dependency when Daytona isn't available
  const { DaytonaAdapter } = await import('@sandbank/daytona')
  const adapter = new DaytonaAdapter({
    apiKey: process.env.DAYTONA_API_KEY,
    apiUrl: process.env.DAYTONA_API_URL,
  })
  providers.push({ name: 'daytona', provider: createProvider(adapter) })
}

if (process.env.E2E_WORKER_URL) {
  const adapter = new CloudflareHttpAdapter({
    workerUrl: process.env.E2E_WORKER_URL,
  })
  providers.push({ name: 'cloudflare', provider: createProvider(adapter) })
}

if (process.env.FLY_API_TOKEN && process.env.FLY_APP_NAME) {
  const { FlyioAdapter } = await import('@sandbank/flyio')
  const adapter = new FlyioAdapter({
    apiToken: process.env.FLY_API_TOKEN,
    appName: process.env.FLY_APP_NAME,
    region: process.env.FLY_REGION,
  })
  providers.push({ name: 'flyio', provider: createProvider(adapter) })
}

// ---------------------------------------------------------------------------
// Parameterized conformance tests — each provider runs the same suite
// ---------------------------------------------------------------------------

for (const entry of providers) {
  describe(`conformance: ${entry.name}`, () => {
    let sandbox: Sandbox

    beforeAll(async () => {
      sandbox = await entry.provider.create({ image: 'ubuntu:24.04' })
    })

    afterAll(async () => {
      if (sandbox) {
        await entry.provider.destroy(sandbox.id)
      }
    })

    // -- Identity --

    it('provider.name is a non-empty string', () => {
      expect(entry.provider.name).toBeTruthy()
      expect(typeof entry.provider.name).toBe('string')
    })

    it('capabilities is a Set', () => {
      expect(entry.provider.capabilities).toBeInstanceOf(Set)
    })

    // -- Sandbox properties --

    it('sandbox.id is a non-empty string', () => {
      expect(sandbox.id).toBeTruthy()
      expect(typeof sandbox.id).toBe('string')
    })

    it('sandbox.state is running', () => {
      expect(sandbox.state).toBe('running')
    })

    it('sandbox.createdAt is a valid ISO date', () => {
      expect(sandbox.createdAt).toBeTruthy()
      const parsed = new Date(sandbox.createdAt)
      expect(parsed.getTime()).not.toBeNaN()
    })

    // -- Exec --

    it('echo returns exitCode 0 and correct stdout', async () => {
      const result = await sandbox.exec('echo hello-sandbank')
      expect(result.exitCode).toBe(0)
      expect(result.stdout.trim()).toBe('hello-sandbank')
    })

    it('non-zero exit code (ls /nonexistent-path-xyz)', async () => {
      const result = await sandbox.exec('ls /nonexistent-path-xyz')
      expect(result.exitCode).not.toBe(0)
    })

    it('cwd option is respected', async () => {
      const result = await sandbox.exec('pwd', { cwd: '/tmp' })
      expect(result.exitCode).toBe(0)
      expect(result.stdout.trim()).toBe('/tmp')
    })

    it('stderr is a string (may be empty for some providers)', async () => {
      const result = await sandbox.exec('ls /nonexistent-path-xyz')
      expect(typeof result.stderr).toBe('string')
    })

    it('multi-line output is preserved', async () => {
      const result = await sandbox.exec('printf "line1\\nline2\\nline3"')
      expect(result.exitCode).toBe(0)
      const lines = result.stdout.trim().split('\n')
      expect(lines).toEqual(['line1', 'line2', 'line3'])
    })

    // -- writeFile + readFile --

    it('text round-trip', async () => {
      const text = 'Hello from conformance test!'
      await sandbox.writeFile('/tmp/conformance-text.txt', text)
      const bytes = await sandbox.readFile('/tmp/conformance-text.txt')
      const decoded = new TextDecoder().decode(bytes)
      expect(decoded).toBe(text)
    })

    it('binary round-trip', async () => {
      const data = new Uint8Array([0, 1, 2, 127, 128, 255])
      await sandbox.writeFile('/tmp/conformance-binary.bin', data)
      const read = await sandbox.readFile('/tmp/conformance-binary.bin')
      expect(new Uint8Array(read)).toEqual(data)
    })

    it('overwrite existing file', async () => {
      await sandbox.writeFile('/tmp/conformance-overwrite.txt', 'first')
      await sandbox.writeFile('/tmp/conformance-overwrite.txt', 'second')
      const bytes = await sandbox.readFile('/tmp/conformance-overwrite.txt')
      expect(new TextDecoder().decode(bytes)).toBe('second')
    })

    it('written file is visible via exec cat', async () => {
      const content = 'visible-via-cat'
      await sandbox.writeFile('/tmp/conformance-cat.txt', content)
      const result = await sandbox.exec('cat /tmp/conformance-cat.txt')
      expect(result.exitCode).toBe(0)
      expect(result.stdout.trim()).toBe(content)
    })

    // -- Lifecycle --

    it('destroy is idempotent (double destroy does not throw)', async () => {
      const ephemeral = await entry.provider.create({ image: 'ubuntu:24.04' })
      await entry.provider.destroy(ephemeral.id)
      // Second destroy should not throw
      await expect(entry.provider.destroy(ephemeral.id)).resolves.not.toThrow()
    })

    // -- Capability: exec.stream --

    it('stream output contains expected content', async () => {
      if (!entry.provider.capabilities.has('exec.stream')) return

      const streamable = sandbox as import('@sandbank/core').StreamableSandbox
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

    // -- Capability: terminal --

    it('startTerminal returns { url, port }', async () => {
      if (!entry.provider.capabilities.has('terminal')) return

      const terminal = sandbox as import('@sandbank/core').TerminalSandbox
      const info = await terminal.startTerminal()
      expect(typeof info.url).toBe('string')
      expect(info.url.length).toBeGreaterThan(0)
      expect(typeof info.port).toBe('number')
      expect(info.port).toBeGreaterThan(0)
    })

    // -- Capability: port.expose --

    it('exposePort returns a URL string', async () => {
      if (!entry.provider.capabilities.has('port.expose')) return

      const exposable = sandbox as import('@sandbank/core').PortExposeSandbox
      const { url } = await exposable.exposePort(8080)
      expect(typeof url).toBe('string')
      expect(url.length).toBeGreaterThan(0)
    })
  })
}

// ---------------------------------------------------------------------------
// Hot-swap tests — require both providers to be available
// ---------------------------------------------------------------------------

describe('hot-swap: switch providers mid-session', () => {
  const needsBoth = providers.length >= 2

  let sandboxA: Sandbox
  let sandboxB: Sandbox

  beforeAll(async () => {
    if (!needsBoth) return
    sandboxA = await providers[0].provider.create({ image: 'ubuntu:24.04' })
    sandboxB = await providers[1].provider.create({ image: 'ubuntu:24.04' })
  })

  afterAll(async () => {
    if (!needsBoth) return
    if (sandboxA) await providers[0].provider.destroy(sandboxA.id).catch(() => {})
    if (sandboxB) await providers[1].provider.destroy(sandboxB.id).catch(() => {})
  })

  it('provider-agnostic function produces identical results', { skip: !needsBoth }, async () => {
    // Same application logic, different providers
    async function appLogic(sb: Sandbox): Promise<string> {
      await sb.writeFile('/tmp/app.txt', 'provider-agnostic')
      const result = await sb.exec('cat /tmp/app.txt')
      return result.stdout.trim()
    }

    const resultA = await appLogic(sandboxA)
    const resultB = await appLogic(sandboxB)
    expect(resultA).toBe('provider-agnostic')
    expect(resultB).toBe('provider-agnostic')
    expect(resultA).toBe(resultB)
  })

  it('sandboxes from different providers are isolated', { skip: !needsBoth }, async () => {
    await sandboxA.writeFile('/tmp/isolation-a.txt', 'from-provider-a')
    await sandboxB.writeFile('/tmp/isolation-b.txt', 'from-provider-b')

    // Each sandbox only sees its own file
    const resultA = await sandboxA.exec('cat /tmp/isolation-a.txt')
    expect(resultA.stdout.trim()).toBe('from-provider-a')

    const checkB = await sandboxA.exec('cat /tmp/isolation-b.txt')
    expect(checkB.exitCode).not.toBe(0)

    const resultB = await sandboxB.exec('cat /tmp/isolation-b.txt')
    expect(resultB.stdout.trim()).toBe('from-provider-b')

    const checkA = await sandboxB.exec('cat /tmp/isolation-a.txt')
    expect(checkA.exitCode).not.toBe(0)
  })

  it('ExecResult structure is identical across providers', { skip: !needsBoth }, async () => {
    const resultA = await sandboxA.exec('echo conformance')
    const resultB = await sandboxB.exec('echo conformance')

    // Same field names
    expect(Object.keys(resultA).sort()).toEqual(Object.keys(resultB).sort())

    // Same types
    expect(typeof resultA.exitCode).toBe(typeof resultB.exitCode)
    expect(typeof resultA.stdout).toBe(typeof resultB.stdout)
    expect(typeof resultA.stderr).toBe(typeof resultB.stderr)

    // Same values for deterministic command
    expect(resultA.exitCode).toBe(0)
    expect(resultB.exitCode).toBe(0)
    expect(resultA.stdout.trim()).toBe(resultB.stdout.trim())
  })

  it('capabilities Sets differ in content but share format', { skip: !needsBoth }, async () => {
    const capsA = providers[0].provider.capabilities
    const capsB = providers[1].provider.capabilities

    expect(capsA).toBeInstanceOf(Set)
    expect(capsB).toBeInstanceOf(Set)

    // Both should have some capabilities
    expect(capsA.size).toBeGreaterThan(0)
    expect(capsB.size).toBeGreaterThan(0)

    // They share at least one common capability
    const shared = [...capsA].filter((c) => capsB.has(c))
    expect(shared.length).toBeGreaterThan(0)
  })
})

// ---------------------------------------------------------------------------
// Skip message when no providers are configured
// ---------------------------------------------------------------------------

if (providers.length === 0) {
  describe('conformance (skipped)', () => {
    it('no providers configured — set DAYTONA_API_KEY, E2E_WORKER_URL, and/or FLY_API_TOKEN + FLY_APP_NAME', () => {
      expect(true).toBe(true)
    })
  })
}
