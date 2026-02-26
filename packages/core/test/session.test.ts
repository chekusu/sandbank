import { describe, it, expect, afterEach } from 'vitest'
import { createSession } from '../src/session.js'
import { createProvider } from '../src/provider.js'
import type { SandboxAdapter, AdapterSandbox, CreateConfig, ExecResult, SandboxInfo, SandboxState } from '../src/types.js'
import type { Session, SessionMessage } from '../src/session-types.js'

// --- Mock Adapter ---

function createMockAdapter(): SandboxAdapter & { sandboxes: Map<string, MockSandbox> } {
  const sandboxes = new Map<string, MockSandbox>()
  let nextId = 0

  return {
    name: 'mock',
    capabilities: new Set(),
    sandboxes,

    async createSandbox(config: CreateConfig): Promise<AdapterSandbox> {
      const id = `mock-${++nextId}`
      const sandbox: MockSandbox = {
        id,
        state: 'running',
        createdAt: new Date().toISOString(),
        env: config.env ?? {},
        async exec(command: string): Promise<ExecResult> {
          return { stdout: `executed: ${command}`, stderr: '', exitCode: 0 }
        },
      }
      sandboxes.set(id, sandbox)
      return sandbox
    },

    async getSandbox(id: string): Promise<AdapterSandbox> {
      const sb = sandboxes.get(id)
      if (!sb) throw new Error(`Not found: ${id}`)
      return sb
    },

    async listSandboxes(): Promise<SandboxInfo[]> {
      return [...sandboxes.values()].map(sb => ({
        id: sb.id,
        state: sb.state,
        createdAt: sb.createdAt,
        image: 'mock:latest',
      }))
    },

    async destroySandbox(id: string): Promise<void> {
      sandboxes.delete(id)
    },
  }
}

interface MockSandbox extends AdapterSandbox {
  env: Record<string, string>
}

let session: Session | null = null

afterEach(async () => {
  if (session) {
    await session.close()
    session = null
  }
})

describe('createSession', () => {
  it('creates session with memory relay', async () => {
    const adapter = createMockAdapter()
    const provider = createProvider(adapter)
    session = await createSession({ provider })

    expect(session.id).toBeTruthy()
  })

  it('spawns sandbox with relay env vars injected', async () => {
    const adapter = createMockAdapter()
    const provider = createProvider(adapter)
    session = await createSession({ provider })

    const sandbox = await session.spawn('backend', { image: 'node:22' })
    expect(sandbox).toBeDefined()

    // Check env vars were injected
    const mockSb = [...adapter.sandboxes.values()][0]!
    expect(mockSb.env['SANDBANK_RELAY_URL']).toBeTruthy()
    expect(mockSb.env['SANDBANK_WS_URL']).toBeTruthy()
    expect(mockSb.env['SANDBANK_SESSION_ID']).toBeTruthy()
    expect(mockSb.env['SANDBANK_SANDBOX_NAME']).toBe('backend')
  })

  it('getSandbox and listSandboxes', async () => {
    const adapter = createMockAdapter()
    const provider = createProvider(adapter)
    session = await createSession({ provider })

    await session.spawn('a', { image: 'node:22' })
    await session.spawn('b', { image: 'python:3' })

    expect(session.getSandbox('a')).toBeDefined()
    expect(session.getSandbox('nonexistent')).toBeUndefined()
    expect(session.listSandboxes()).toHaveLength(2)
  })

  it('enforces maxSandboxes limit', async () => {
    const adapter = createMockAdapter()
    const provider = createProvider(adapter)
    session = await createSession({ provider, maxSandboxes: 1 })

    await session.spawn('a', { image: 'node:22' })
    await expect(session.spawn('b', { image: 'node:22' })).rejects.toThrow(/Max sandboxes/)
  })

  it('context get/set/delete/keys via session', async () => {
    const adapter = createMockAdapter()
    const provider = createProvider(adapter)
    session = await createSession({ provider })

    await session.context.set('key1', 'value1')
    const val = await session.context.get('key1')
    expect(val).toBe('value1')

    await session.context.set('key2', 42)
    const keys = await session.context.keys()
    expect(keys).toContain('key1')
    expect(keys).toContain('key2')

    await session.context.delete('key1')
    const deleted = await session.context.get('key1')
    expect(deleted).toBeUndefined()
  })

  it('close destroys all sandboxes', async () => {
    const adapter = createMockAdapter()
    const provider = createProvider(adapter)
    session = await createSession({ provider })

    await session.spawn('a', { image: 'node:22' })
    await session.spawn('b', { image: 'node:22' })
    expect(adapter.sandboxes.size).toBe(2)

    await session.close()
    session = null
    expect(adapter.sandboxes.size).toBe(0)
  })
})

describe('session messaging', () => {
  it('send and receive messages between session and agent (via relay)', async () => {
    const adapter = createMockAdapter()
    const provider = createProvider(adapter)
    session = await createSession({ provider })

    // Spawn a sandbox
    await session.spawn('worker', { image: 'node:22' })

    // Get relay env from the spawned sandbox
    const mockSb = [...adapter.sandboxes.values()][0]!
    const wsUrl = mockSb.env['SANDBANK_WS_URL']!
    const sessionId = mockSb.env['SANDBANK_SESSION_ID']!
    const token = mockSb.env['SANDBANK_AUTH_TOKEN']!

    // Simulate agent connecting via WebSocket (using ws library)
    const WebSocket = (await import('ws')).default
    const agentWs = new WebSocket(wsUrl)
    await new Promise<void>((resolve) => agentWs.on('open', resolve))

    // Auth with token
    agentWs.send(JSON.stringify({
      jsonrpc: '2.0', id: 1, method: 'session.auth',
      params: { sessionId, sandboxName: 'worker', role: 'agent', token },
    }))
    await new Promise<void>((resolve) => agentWs.once('message', () => resolve()))

    // Setup message listener on session
    const received: SessionMessage[] = []
    session.onMessage((msg) => received.push(msg))

    // Agent sends message to orchestrator
    agentWs.send(JSON.stringify({
      jsonrpc: '2.0', id: 2, method: 'message.send',
      params: { to: 'orchestrator', type: 'result', payload: { data: 'hello' }, priority: 'normal' },
    }))

    // Wait for delivery
    await new Promise(r => setTimeout(r, 200))

    // Not all relays push to orchestrator directly — but send from session to agent should work
    session.send('worker', 'task', { code: 'do stuff' })

    // Agent receives
    const agentMsg = await new Promise<string>((resolve) => {
      agentWs.once('message', (data) => resolve(data.toString()))
    })
    const parsed = JSON.parse(agentMsg) as { method?: string; params?: Record<string, unknown> }
    expect(parsed.method).toBe('message')
    expect((parsed.params as Record<string, unknown>)['type']).toBe('task')

    agentWs.close()
  })
})

describe('session waitFor', () => {
  it('resolves when agent completes', async () => {
    const adapter = createMockAdapter()
    const provider = createProvider(adapter)
    session = await createSession({ provider })

    await session.spawn('worker', { image: 'node:22' })

    const mockSb = [...adapter.sandboxes.values()][0]!
    const wsUrl = mockSb.env['SANDBANK_WS_URL']!
    const sessionId = mockSb.env['SANDBANK_SESSION_ID']!
    const token = mockSb.env['SANDBANK_AUTH_TOKEN']!

    // Simulate agent
    const WebSocket = (await import('ws')).default
    const agentWs = new WebSocket(wsUrl)
    await new Promise<void>((resolve) => agentWs.on('open', resolve))
    agentWs.send(JSON.stringify({
      jsonrpc: '2.0', id: 1, method: 'session.auth',
      params: { sessionId, sandboxName: 'worker', role: 'agent', token },
    }))
    await new Promise<void>((resolve) => agentWs.once('message', () => resolve()))

    // Start waiting
    const waitPromise = session.waitFor('worker', 5000)

    // Agent completes
    agentWs.send(JSON.stringify({
      jsonrpc: '2.0', id: 2, method: 'sandbox.complete',
      params: { status: 'success', summary: 'Task finished' },
    }))

    const completion = await waitPromise
    expect(completion.status).toBe('success')
    expect(completion.summary).toBe('Task finished')

    agentWs.close()
  })

  it('waitFor timeout rejects', async () => {
    const adapter = createMockAdapter()
    const provider = createProvider(adapter)
    session = await createSession({ provider })

    await session.spawn('slow', { image: 'node:22' })

    await expect(session.waitFor('slow', 200)).rejects.toThrow(/Timeout/)
  })
})
