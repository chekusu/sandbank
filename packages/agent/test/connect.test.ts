import { describe, it, expect, vi, beforeEach } from 'vitest'
import type { Transport } from '@sandbank/core'
import { resetIdCounter } from '../src/rpc.js'

// --- Mock transport module ---
const mockListeners: Array<(data: string) => void> = []
const mockTransport: Transport = {
  send: vi.fn(),
  onMessage(fn) { mockListeners.push(fn) },
  close: vi.fn(),
  get readyState() { return 'open' as const },
}

vi.mock('../src/transport.js', () => ({
  createWebSocketTransport: vi.fn(() => Promise.resolve(mockTransport)),
}))

import { connect } from '../src/connect.js'
import { createWebSocketTransport } from '../src/transport.js'

/** Simulate server sending a message to the client */
function serverSend(msg: object) {
  const data = JSON.stringify(msg)
  for (const fn of mockListeners) fn(data)
}

/**
 * Intercept the next transport.send call and auto-respond with a result.
 * Uses mockImplementationOnce so subsequent calls are unaffected.
 */
function autoReply(result: unknown = { ok: true }) {
  const sendFn = mockTransport.send as ReturnType<typeof vi.fn>
  sendFn.mockImplementationOnce((data: string) => {
    const req = JSON.parse(data)
    queueMicrotask(() => serverSend({ jsonrpc: '2.0', id: req.id, result }))
  })
}

describe('connect', () => {
  beforeEach(() => {
    vi.clearAllMocks()
    mockListeners.length = 0
    resetIdCounter()
    delete process.env['SANDBANK_WS_URL']
    delete process.env['SANDBANK_SESSION_ID']
    delete process.env['SANDBANK_SANDBOX_NAME']
    delete process.env['SANDBANK_AUTH_TOKEN']
  })

  // --- Validation ---
  it('should throw if wsUrl is missing', async () => {
    await expect(connect({})).rejects.toThrow('Missing wsUrl')
  })

  it('should throw if sessionId is missing', async () => {
    await expect(connect({ wsUrl: 'ws://localhost' })).rejects.toThrow('Missing sessionId')
  })

  it('should throw if sandboxName is missing', async () => {
    await expect(
      connect({ wsUrl: 'ws://localhost', sessionId: 's1' }),
    ).rejects.toThrow('Missing sandboxName')
  })

  // --- Env fallback ---
  it('should read options from env vars', async () => {
    process.env['SANDBANK_WS_URL'] = 'ws://env-url'
    process.env['SANDBANK_SESSION_ID'] = 'env-session'
    process.env['SANDBANK_SANDBOX_NAME'] = 'env-agent'

    autoReply({ ok: true })
    const session = await connect()
    expect(createWebSocketTransport).toHaveBeenCalledWith('ws://env-url')
    session.close()
  })

  // --- Auth ---
  it('should throw if auth fails', async () => {
    autoReply({ ok: false })
    await expect(
      connect({ wsUrl: 'ws://localhost', sessionId: 's1', sandboxName: 'agent1' }),
    ).rejects.toThrow('Authentication failed')
  })

  it('should send session.auth with correct params', async () => {
    autoReply({ ok: true })
    const session = await connect({
      wsUrl: 'ws://localhost', sessionId: 's1', sandboxName: 'agent1', token: 'tk',
    })

    const authCall = JSON.parse((mockTransport.send as ReturnType<typeof vi.fn>).mock.calls[0][0])
    expect(authCall.method).toBe('session.auth')
    expect(authCall.params).toEqual({
      sessionId: 's1', sandboxName: 'agent1', token: 'tk', role: 'agent',
    })
    session.close()
  })

  // --- Session shape ---
  it('should return a valid session on successful auth', async () => {
    autoReply({ ok: true })
    const session = await connect({
      wsUrl: 'ws://localhost', sessionId: 's1', sandboxName: 'agent1',
    })

    expect(session.send).toBeInstanceOf(Function)
    expect(session.broadcast).toBeInstanceOf(Function)
    expect(session.recv).toBeInstanceOf(Function)
    expect(session.on).toBeInstanceOf(Function)
    expect(session.complete).toBeInstanceOf(Function)
    expect(session.close).toBeInstanceOf(Function)
    expect(session.context).toBeDefined()
    session.close()
  })

  // --- session.send ---
  it('session.send should send message.send RPC', async () => {
    autoReply({ ok: true }) // auth
    const session = await connect({
      wsUrl: 'ws://localhost', sessionId: 's1', sandboxName: 'agent1',
    })

    autoReply({})
    await session.send('backend', 'task', { data: 1 }, { priority: 'steer' })

    const calls = (mockTransport.send as ReturnType<typeof vi.fn>).mock.calls
    const sendCall = JSON.parse(calls[calls.length - 1][0])
    expect(sendCall.method).toBe('message.send')
    expect(sendCall.params.to).toBe('backend')
    expect(sendCall.params.type).toBe('task')
    expect(sendCall.params.payload).toEqual({ data: 1 })
    expect(sendCall.params.priority).toBe('steer')
    session.close()
  })

  it('session.send should default priority to normal and payload to null', async () => {
    autoReply({ ok: true })
    const session = await connect({
      wsUrl: 'ws://localhost', sessionId: 's1', sandboxName: 'agent1',
    })

    autoReply({})
    await session.send('peer', 'ping')

    const calls = (mockTransport.send as ReturnType<typeof vi.fn>).mock.calls
    const sendCall = JSON.parse(calls[calls.length - 1][0])
    expect(sendCall.params.payload).toBeNull()
    expect(sendCall.params.priority).toBe('normal')
    session.close()
  })

  // --- session.broadcast ---
  it('session.broadcast should send message.broadcast RPC', async () => {
    autoReply({ ok: true })
    const session = await connect({
      wsUrl: 'ws://localhost', sessionId: 's1', sandboxName: 'agent1',
    })

    autoReply({})
    await session.broadcast('ping', { ts: 123 })

    const calls = (mockTransport.send as ReturnType<typeof vi.fn>).mock.calls
    const broadcastCall = JSON.parse(calls[calls.length - 1][0])
    expect(broadcastCall.method).toBe('message.broadcast')
    expect(broadcastCall.params.type).toBe('ping')
    session.close()
  })

  // --- session.recv ---
  it('session.recv should return messages from RPC', async () => {
    autoReply({ ok: true })
    const session = await connect({
      wsUrl: 'ws://localhost', sessionId: 's1', sandboxName: 'agent1',
    })

    autoReply({ messages: [{ from: 'x', type: 'task', payload: null }] })
    const msgs = await session.recv({ limit: 5, wait: 1000 })
    expect(msgs).toHaveLength(1)
    expect(msgs[0].from).toBe('x')
    session.close()
  })

  // --- session.on ---
  it('session.on("message") should dispatch notifications', async () => {
    autoReply({ ok: true })
    const session = await connect({
      wsUrl: 'ws://localhost', sessionId: 's1', sandboxName: 'agent1',
    })

    const cb = vi.fn()
    session.on('message', cb)

    serverSend({
      jsonrpc: '2.0', method: 'message',
      params: { from: 'peer', to: 'agent1', type: 'hello', payload: null, priority: 'normal', timestamp: '' },
    })

    expect(cb).toHaveBeenCalledTimes(1)
    expect(cb.mock.calls[0][0].from).toBe('peer')
    session.close()
  })

  it('session.on("message") unsubscribe should stop notifications', async () => {
    autoReply({ ok: true })
    const session = await connect({
      wsUrl: 'ws://localhost', sessionId: 's1', sandboxName: 'agent1',
    })

    const cb = vi.fn()
    const unsub = session.on('message', cb)

    serverSend({ jsonrpc: '2.0', method: 'message', params: { from: 'a' } })
    expect(cb).toHaveBeenCalledTimes(1)

    unsub()
    serverSend({ jsonrpc: '2.0', method: 'message', params: { from: 'b' } })
    expect(cb).toHaveBeenCalledTimes(1)
    session.close()
  })

  it('session.on for unknown event should return noop unsubscribe', async () => {
    autoReply({ ok: true })
    const session = await connect({
      wsUrl: 'ws://localhost', sessionId: 's1', sandboxName: 'agent1',
    })

    const unsub = session.on('unknown' as 'message', vi.fn())
    expect(unsub).toBeInstanceOf(Function)
    unsub() // should not throw
    session.close()
  })

  // --- session.complete ---
  it('session.complete should send sandbox.complete RPC', async () => {
    autoReply({ ok: true })
    const session = await connect({
      wsUrl: 'ws://localhost', sessionId: 's1', sandboxName: 'agent1',
    })

    autoReply({})
    await session.complete({ status: 'success', summary: 'Done' })

    const calls = (mockTransport.send as ReturnType<typeof vi.fn>).mock.calls
    const completeCall = JSON.parse(calls[calls.length - 1][0])
    expect(completeCall.method).toBe('sandbox.complete')
    expect(completeCall.params.status).toBe('success')
    expect(completeCall.params.summary).toBe('Done')
    session.close()
  })

  // --- session.close ---
  it('session.close should close transport', async () => {
    autoReply({ ok: true })
    const session = await connect({
      wsUrl: 'ws://localhost', sessionId: 's1', sandboxName: 'agent1',
    })

    session.close()
    expect(mockTransport.close).toHaveBeenCalled()
  })

  // --- Routing ---
  it('should ignore invalid JSON messages', async () => {
    autoReply({ ok: true })
    const session = await connect({
      wsUrl: 'ws://localhost', sessionId: 's1', sandboxName: 'agent1',
    })

    const cb = vi.fn()
    session.on('message', cb)

    // Push invalid JSON — should not throw or fire callback
    for (const fn of mockListeners) fn('not valid json')
    expect(cb).not.toHaveBeenCalled()
    session.close()
  })
})
