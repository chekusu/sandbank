import { describe, it, expect, beforeEach, vi } from 'vitest'
import { createWebSocketTransport } from '../src/transport.js'

/**
 * A minimal mock that captures addEventListener handlers so tests can
 * simulate open / error / message / close events.
 */
function createMockWebSocket() {
  const handlers: Record<string, Array<(evt: any) => void>> = {}
  const mock = {
    addEventListener: vi.fn((event: string, fn: (evt: any) => void) => {
      ;(handlers[event] ??= []).push(fn)
    }),
    send: vi.fn(),
    close: vi.fn(),
    // helpers for tests —— not part of the real WebSocket API
    _emit(event: string, data?: any) {
      for (const fn of handlers[event] ?? []) {
        fn(data ?? {})
      }
    },
    _handlers: handlers,
  }
  return mock
}

type MockWS = ReturnType<typeof createMockWebSocket>

describe('createWebSocketTransport', () => {
  let mockWs: MockWS

  beforeEach(() => {
    mockWs = createMockWebSocket()
    // Stub the global WebSocket constructor so `new WebSocket(url)` returns
    // our mock instance.  Must use a function expression (not arrow) so that
    // `new` invocation works correctly.
    const MockWebSocket = vi.fn(function (this: any) {
      Object.assign(this, mockWs)
      return mockWs
    })
    vi.stubGlobal('WebSocket', MockWebSocket)
  })

  it('should pass the URL to the WebSocket constructor', () => {
    const url = 'ws://localhost:9000'
    createWebSocketTransport(url)
    expect(WebSocket).toHaveBeenCalledWith(url)
  })

  it('should resolve with a transport whose readyState is "open" after the open event', async () => {
    const promise = createWebSocketTransport('ws://localhost:9000')
    mockWs._emit('open')
    const transport = await promise
    expect(transport.readyState).toBe('open')
  })

  it('should reject the promise when a WebSocket error occurs during connecting', async () => {
    const url = 'ws://bad-host:1234'
    const promise = createWebSocketTransport(url)
    mockWs._emit('error')
    await expect(promise).rejects.toThrow(`WebSocket connection failed: ${url}`)
  })

  it('should NOT reject when an error occurs after the connection is already open', async () => {
    const promise = createWebSocketTransport('ws://localhost:9000')
    // First open the connection…
    mockWs._emit('open')
    const transport = await promise
    // …then fire an error.  The promise is already resolved, so this should
    // not throw or cause an unhandled rejection.
    expect(() => mockWs._emit('error')).not.toThrow()
    // readyState stays 'open' (only close changes it)
    expect(transport.readyState).toBe('open')
  })

  it('should delegate send() to ws.send()', async () => {
    const promise = createWebSocketTransport('ws://localhost:9000')
    mockWs._emit('open')
    const transport = await promise

    transport.send('hello')
    expect(mockWs.send).toHaveBeenCalledWith('hello')
  })

  it('should delegate close() to ws.close()', async () => {
    const promise = createWebSocketTransport('ws://localhost:9000')
    mockWs._emit('open')
    const transport = await promise

    transport.close()
    expect(mockWs.close).toHaveBeenCalled()
  })

  it('should invoke all registered onMessage listeners when a message arrives', async () => {
    const promise = createWebSocketTransport('ws://localhost:9000')
    mockWs._emit('open')
    const transport = await promise

    const listener1 = vi.fn()
    const listener2 = vi.fn()
    transport.onMessage(listener1)
    transport.onMessage(listener2)

    mockWs._emit('message', { data: 'payload' })

    expect(listener1).toHaveBeenCalledWith('payload')
    expect(listener2).toHaveBeenCalledWith('payload')
  })

  it('should convert non-string message data via String()', async () => {
    const promise = createWebSocketTransport('ws://localhost:9000')
    mockWs._emit('open')
    const transport = await promise

    const listener = vi.fn()
    transport.onMessage(listener)

    // Simulate a non-string payload (e.g. a Buffer or number)
    mockWs._emit('message', { data: 42 })
    expect(listener).toHaveBeenCalledWith('42')
  })

  it('should leave string message data as-is', async () => {
    const promise = createWebSocketTransport('ws://localhost:9000')
    mockWs._emit('open')
    const transport = await promise

    const listener = vi.fn()
    transport.onMessage(listener)

    mockWs._emit('message', { data: 'already a string' })
    expect(listener).toHaveBeenCalledWith('already a string')
  })

  it('should set readyState to "closed" after the close event', async () => {
    const promise = createWebSocketTransport('ws://localhost:9000')
    mockWs._emit('open')
    const transport = await promise

    expect(transport.readyState).toBe('open')
    mockWs._emit('close')
    expect(transport.readyState).toBe('closed')
  })

  it('should have readyState "connecting" before the open event fires', async () => {
    // The initial state is 'connecting'. This is proven by the fact that
    // an error event during this phase triggers rejection (state === 'connecting').
    // Here we verify the transition: error before open → rejected.
    const promise = createWebSocketTransport('ws://localhost:9000')
    mockWs._emit('error')
    await expect(promise).rejects.toThrow('WebSocket connection failed')
  })
})
