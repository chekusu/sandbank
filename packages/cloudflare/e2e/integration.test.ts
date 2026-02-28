import { describe, it, expect, beforeAll, afterAll } from 'vitest'
import { execSync, spawn, type ChildProcess } from 'node:child_process'
import { setTimeout as sleep } from 'node:timers/promises'

// --- Configuration ---
// E2E_WORKER_URL → test against a remote Cloudflare deployment.
// Without it, falls back to local wrangler dev.

const REMOTE_URL = process.env.E2E_WORKER_URL
const WORKER_PORT = 8799
const BASE_URL = REMOTE_URL ?? `http://localhost:${WORKER_PORT}`
const USE_LOCAL = !REMOTE_URL
const WRANGLER_STARTUP_TIMEOUT = 90_000
const WRANGLER_POLL_INTERVAL = 1_000

// --- Docker check (only needed for local mode) ---

function isDockerAvailable(): boolean {
  if (!USE_LOCAL) return true
  try {
    execSync('docker info', { stdio: 'ignore', timeout: 10_000 })
    return true
  } catch {
    return false
  }
}

// --- HTTP helpers ---

async function workerFetch(path: string, options?: RequestInit): Promise<Response> {
  return fetch(`${BASE_URL}${path}`, options)
}

async function workerPost<T = unknown>(path: string, body: unknown): Promise<T> {
  const res = await workerFetch(path, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(body),
  })
  if (!res.ok) {
    const err = await res.json().catch(() => ({ error: res.statusText }))
    throw new Error(`Worker ${path} failed (${res.status}): ${JSON.stringify(err)}`)
  }
  return res.json() as Promise<T>
}

// --- Wrangler process management ---

let wranglerProc: ChildProcess | null = null

async function startWrangler(): Promise<void> {
  console.log('[e2e] Starting wrangler dev...')

  wranglerProc = spawn(
    'npx',
    ['wrangler', 'dev', '--port', String(WORKER_PORT), '--config', 'e2e/wrangler.jsonc'],
    {
      cwd: new URL('..', import.meta.url).pathname,
      stdio: ['ignore', 'pipe', 'pipe'],
      env: { ...process.env, WRANGLER_SEND_METRICS: 'false' },
    },
  )

  let stdout = ''
  let stderr = ''
  wranglerProc.stdout?.on('data', (chunk: Buffer) => {
    stdout += chunk.toString()
    if (process.env.E2E_DEBUG) process.stdout.write(chunk)
  })
  wranglerProc.stderr?.on('data', (chunk: Buffer) => {
    stderr += chunk.toString()
    if (process.env.E2E_DEBUG) process.stderr.write(chunk)
  })

  const deadline = Date.now() + WRANGLER_STARTUP_TIMEOUT
  while (Date.now() < deadline) {
    try {
      const res = await fetch(`${BASE_URL}/health`)
      if (res.ok) {
        console.log('[e2e] Wrangler is ready')
        return
      }
    } catch {
      // not ready yet
    }
    if (wranglerProc.exitCode !== null) {
      throw new Error(
        `Wrangler exited with code ${wranglerProc.exitCode}\nstdout: ${stdout}\nstderr: ${stderr}`,
      )
    }
    await sleep(WRANGLER_POLL_INTERVAL)
  }

  wranglerProc.kill('SIGTERM')
  throw new Error(`Wrangler did not become ready within ${WRANGLER_STARTUP_TIMEOUT}ms\nstdout: ${stdout}\nstderr: ${stderr}`)
}

function stopWrangler(): void {
  if (wranglerProc && wranglerProc.exitCode === null) {
    console.log('[e2e] Stopping wrangler dev...')
    wranglerProc.kill('SIGTERM')
    wranglerProc = null
  }
}

// --- Sandbox helpers ---

async function createSandbox(): Promise<string> {
  const result = await workerPost<{ id: string }>('/create', { image: 'default' })
  return result.id
}

// Poll until the container is ready to accept exec commands.
async function waitForReady(id: string, maxAttempts = 30, delayMs = 3_000): Promise<void> {
  for (let i = 0; i < maxAttempts; i++) {
    try {
      const controller = new AbortController()
      const timeout = setTimeout(() => controller.abort(), 15_000)
      const res = await workerFetch('/exec', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ id, command: 'echo ready' }),
        signal: controller.signal,
      })
      clearTimeout(timeout)
      if (res.ok) return
      console.log(`[e2e] Poll ${i}: status ${res.status}`)
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err)
      if (i % 5 === 0) console.log(`[e2e] Poll ${i}: ${msg.slice(0, 80)}`)
    }
    await sleep(delayMs)
  }
  throw new Error(`Sandbox ${id} did not become ready after ${maxAttempts * delayMs / 1000}s`)
}

// --- Tests ---

const dockerAvailable = isDockerAvailable()
const describeE2e = dockerAvailable ? describe : describe.skip

describeE2e('CloudflareAdapter e2e', () => {
  // Single shared sandbox for all operational tests.
  // CF container startup can take 30-60s, so we only do it once.
  let sandboxId: string

  beforeAll(async () => {
    if (USE_LOCAL) {
      await startWrangler()
    } else {
      const res = await fetch(`${BASE_URL}/health`)
      if (!res.ok) throw new Error(`Remote worker not reachable at ${BASE_URL}`)
      console.log(`[e2e] Using remote worker at ${BASE_URL}`)
    }

    // Create and warm up the shared sandbox
    console.log('[e2e] Creating sandbox...')
    sandboxId = await createSandbox()
    console.log(`[e2e] Sandbox created: ${sandboxId}`)
    await waitForReady(sandboxId)
    console.log('[e2e] Sandbox is ready')
  }, 180_000) // 3 minutes for wrangler startup + container provisioning

  afterAll(async () => {
    await workerPost('/destroy', { id: sandboxId }).catch(() => {})
    if (USE_LOCAL) stopWrangler()
  })

  // --- Sandbox lifecycle ---

  describe('sandbox lifecycle', () => {
    it('should create and destroy a sandbox', async () => {
      const id = await createSandbox()
      expect(id).toBeTruthy()
      expect(typeof id).toBe('string')
      const result = await workerPost<{ ok: boolean }>('/destroy', { id })
      expect(result.ok).toBe(true)
    })

    it('should destroy idempotently', async () => {
      const id = await createSandbox()
      await workerPost('/destroy', { id })
      const result = await workerPost<{ ok: boolean }>('/destroy', { id })
      expect(result.ok).toBe(true)
    })
  })

  // --- exec ---

  describe('exec', () => {
    it('should execute a basic command', async () => {
      const result = await workerPost<{ exitCode: number; stdout: string; stderr: string }>(
        '/exec',
        { id: sandboxId, command: 'echo hello' },
      )
      expect(result.exitCode).toBe(0)
      expect(result.stdout.trim()).toBe('hello')
    })

    it('should handle non-zero exit code', async () => {
      const result = await workerPost<{ exitCode: number; stdout: string; stderr: string }>(
        '/exec',
        { id: sandboxId, command: 'ls /nonexistent-path-xyz' },
      )
      expect(result.exitCode).not.toBe(0)
    })

    it('should support cwd option', async () => {
      const result = await workerPost<{ exitCode: number; stdout: string; stderr: string }>(
        '/exec',
        { id: sandboxId, command: 'pwd', cwd: '/tmp' },
      )
      expect(result.exitCode).toBe(0)
      expect(result.stdout.trim()).toBe('/tmp')
    })

    it('should capture stderr', async () => {
      const result = await workerPost<{ exitCode: number; stdout: string; stderr: string }>(
        '/exec',
        { id: sandboxId, command: 'echo error >&2' },
      )
      expect(result.stderr.trim()).toBe('error')
    })

    it('should handle multi-line output', async () => {
      const result = await workerPost<{ exitCode: number; stdout: string }>(
        '/exec',
        { id: sandboxId, command: 'echo line1 && echo line2 && echo line3' },
      )
      expect(result.exitCode).toBe(0)
      const lines = result.stdout.trim().split('\n')
      expect(lines).toHaveLength(3)
      expect(lines).toEqual(['line1', 'line2', 'line3'])
    })
  })

  // --- writeFile / readFile ---

  describe('writeFile + readFile', () => {
    it('should round-trip text content', async () => {
      const content = 'Hello, Sandbank!'
      await workerPost('/write-file', {
        id: sandboxId,
        path: '/tmp/test.txt',
        content,
      })

      const result = await workerPost<{ content: string }>('/read-file', {
        id: sandboxId,
        path: '/tmp/test.txt',
      })

      const decoded = Buffer.from(result.content, 'base64').toString('utf-8')
      expect(decoded).toBe(content)
    })

    it('should round-trip binary content', async () => {
      const bytes = new Uint8Array(256)
      for (let i = 0; i < 256; i++) bytes[i] = i

      let binary = ''
      for (let i = 0; i < bytes.length; i++) {
        binary += String.fromCharCode(bytes[i]!)
      }
      const b64Content = btoa(binary)

      await workerPost('/write-file', {
        id: sandboxId,
        path: '/tmp/test.bin',
        content: b64Content,
        binary: true,
      })

      const result = await workerPost<{ content: string }>('/read-file', {
        id: sandboxId,
        path: '/tmp/test.bin',
      })

      const readBinary = atob(result.content)
      const readBytes = new Uint8Array(readBinary.length)
      for (let i = 0; i < readBinary.length; i++) {
        readBytes[i] = readBinary.charCodeAt(i)
      }
      expect(readBytes).toEqual(bytes)
    })

    it('should overwrite existing file', async () => {
      await workerPost('/write-file', {
        id: sandboxId,
        path: '/tmp/overwrite.txt',
        content: 'first',
      })
      await workerPost('/write-file', {
        id: sandboxId,
        path: '/tmp/overwrite.txt',
        content: 'second',
      })

      const result = await workerPost<{ content: string }>('/read-file', {
        id: sandboxId,
        path: '/tmp/overwrite.txt',
      })
      const decoded = Buffer.from(result.content, 'base64').toString('utf-8')
      expect(decoded).toBe('second')
    })

    it('should verify file via exec', async () => {
      await workerPost('/write-file', {
        id: sandboxId,
        path: '/tmp/verify.txt',
        content: 'verify-me',
      })

      const result = await workerPost<{ exitCode: number; stdout: string }>(
        '/exec',
        { id: sandboxId, command: 'cat /tmp/verify.txt' },
      )
      expect(result.exitCode).toBe(0)
      expect(result.stdout.trim()).toBe('verify-me')
    })
  })

  // --- execStream ---

  describe('execStream', () => {
    it('should stream command output', async () => {
      const res = await workerFetch('/exec-stream', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ id: sandboxId, command: 'echo streaming-test' }),
      })
      expect(res.ok).toBe(true)
      expect(res.body).toBeTruthy()

      const reader = res.body!.getReader()
      const chunks: Uint8Array[] = []
      while (true) {
        const { done, value } = await reader.read()
        if (done) break
        chunks.push(value)
      }

      const text = new TextDecoder().decode(
        new Uint8Array(chunks.reduce((acc, c) => [...acc, ...c], [] as number[])),
      )
      expect(text).toContain('streaming-test')
    })
  })

  // --- startTerminal ---

  describe('startTerminal', () => {
    it('should install ttyd and return WebSocket URL', async () => {
      const result = await workerPost<{ url: string; port: number }>(
        '/start-terminal',
        { id: sandboxId },
      )
      expect(result.url).toBeTruthy()
      expect(typeof result.url).toBe('string')
      expect(result.url).toContain('/ws')
      expect(result.port).toBe(7681)
      console.log(`  startTerminal → ${result.url}`)

      // Verify ttyd is running inside the sandbox
      const check = await workerPost<{ exitCode: number; stdout: string }>(
        '/exec',
        { id: sandboxId, command: 'pgrep -x ttyd' },
      )
      expect(check.exitCode).toBe(0)
      console.log('  ttyd process is running')
    }, 60_000)

    it('should support custom shell', async () => {
      // Kill existing ttyd first
      await workerPost('/exec', { id: sandboxId, command: 'pkill ttyd || true' })
      await new Promise(r => setTimeout(r, 1000))

      const result = await workerPost<{ url: string; port: number }>(
        '/start-terminal',
        { id: sandboxId, shell: '/bin/sh' },
      )
      expect(result.url).toBeTruthy()
      expect(result.port).toBe(7681)
    }, 60_000)
  })

  // --- error handling ---

  describe('error handling', () => {
    it('should return 404 for unknown route', async () => {
      const res = await workerFetch('/unknown-route')
      expect(res.status).toBe(404)
    })
  })
})
