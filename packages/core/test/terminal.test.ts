import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest'
import { connectTerminal } from '../src/terminal.js'
import type { TerminalInfo } from '../src/types.js'

/**
 * Mock WebSocket that simulates ttyd binary protocol.
 */
class MockWebSocket {
  static instances: MockWebSocket[] = []

  binaryType = 'arraybuffer'
  readyState = 0 // CONNECTING

  private eventListeners = new Map<string, Set<(event: unknown) => void>>()

  constructor(public url: string) {
    MockWebSocket.instances.push(this)
  }

  addEventListener(type: string, fn: (event: unknown) => void): void {
    if (!this.eventListeners.has(type)) {
      this.eventListeners.set(type, new Set())
    }
    this.eventListeners.get(type)!.add(fn)
  }

  send = vi.fn()
  close = vi.fn(() => {
    this.readyState = 3
    this.emit('close', {})
  })

  // Test helpers
  emit(type: string, event: unknown): void {
    for (const fn of this.eventListeners.get(type) ?? []) fn(event)
  }

  simulateOpen(): void {
    this.readyState = 1
    this.emit('open', {})
  }

  simulateOutput(text: string): void {
    const encoder = new TextEncoder()
    const payload = encoder.encode(text)
    const frame = new Uint8Array(1 + payload.length)
    frame[0] = 0 // MSG_OUTPUT
    frame.set(payload, 1)
    this.emit('message', { data: frame.buffer })
  }

  simulateClose(): void {
    this.readyState = 3
    this.emit('close', {})
  }

  simulateError(): void {
    this.emit('error', { message: 'connection refused' })
  }
}

const info: TerminalInfo = { url: 'wss://sandbox.example.com/ws', port: 7681 }

describe('connectTerminal', () => {
  beforeEach(() => {
    MockWebSocket.instances = []
    vi.stubGlobal('WebSocket', MockWebSocket)
  })

  afterEach(() => {
    vi.unstubAllGlobals()
  })

  it('creates WebSocket connection with correct url', () => {
    connectTerminal(info)
    expect(MockWebSocket.instances).toHaveLength(1)
    expect(MockWebSocket.instances[0]!.url).toBe(info.url)
  })

  it('starts in connecting state', () => {
    const session = connectTerminal(info)
    expect(session.state).toBe('connecting')
  })

  it('transitions to open state on WebSocket open', async () => {
    const session = connectTerminal(info)
    MockWebSocket.instances[0]!.simulateOpen()
    await session.ready
    expect(session.state).toBe('open')
  })

  it('ready resolves when connection opens', async () => {
    const session = connectTerminal(info)
    const ws = MockWebSocket.instances[0]!

    let resolved = false
    session.ready.then(() => { resolved = true })

    // Not yet resolved
    await Promise.resolve()
    expect(resolved).toBe(false)

    // Open connection
    ws.simulateOpen()
    await session.ready
    expect(resolved).toBe(true)
  })

  it('ready rejects on connection error before open', async () => {
    const session = connectTerminal(info)
    const ws = MockWebSocket.instances[0]!
    ws.simulateError()
    await expect(session.ready).rejects.toThrow('WebSocket connection failed')
  })

  describe('write', () => {
    it('sends input frame with MSG_INPUT prefix', async () => {
      const session = connectTerminal(info)
      const ws = MockWebSocket.instances[0]!
      ws.simulateOpen()
      await session.ready

      session.write('ls\n')

      expect(ws.send).toHaveBeenCalledOnce()
      const frame = ws.send.mock.calls[0]![0] as Uint8Array
      expect(frame[0]).toBe(0) // MSG_INPUT
      const text = new TextDecoder().decode(frame.subarray(1))
      expect(text).toBe('ls\n')
    })

    it('does nothing when not open', () => {
      const session = connectTerminal(info)
      const ws = MockWebSocket.instances[0]!
      session.write('test')
      expect(ws.send).not.toHaveBeenCalled()
    })
  })

  describe('onData', () => {
    it('receives terminal output', async () => {
      const session = connectTerminal(info)
      const ws = MockWebSocket.instances[0]!
      ws.simulateOpen()
      await session.ready

      const received: string[] = []
      session.onData((data) => received.push(data))

      ws.simulateOutput('hello world')
      expect(received).toEqual(['hello world'])
    })

    it('supports multiple listeners', async () => {
      const session = connectTerminal(info)
      const ws = MockWebSocket.instances[0]!
      ws.simulateOpen()
      await session.ready

      const a: string[] = []
      const b: string[] = []
      session.onData((data) => a.push(data))
      session.onData((data) => b.push(data))

      ws.simulateOutput('test')
      expect(a).toEqual(['test'])
      expect(b).toEqual(['test'])
    })

    it('dispose removes listener', async () => {
      const session = connectTerminal(info)
      const ws = MockWebSocket.instances[0]!
      ws.simulateOpen()
      await session.ready

      const received: string[] = []
      const disposable = session.onData((data) => received.push(data))

      ws.simulateOutput('first')
      disposable.dispose()
      ws.simulateOutput('second')

      expect(received).toEqual(['first'])
    })
  })

  describe('resize', () => {
    it('sends resize frame with MSG_RESIZE prefix', async () => {
      const session = connectTerminal(info)
      const ws = MockWebSocket.instances[0]!
      ws.simulateOpen()
      await session.ready

      session.resize(120, 40)

      expect(ws.send).toHaveBeenCalledOnce()
      const frame = ws.send.mock.calls[0]![0] as Uint8Array
      expect(frame[0]).toBe(1) // MSG_RESIZE
      const json = new TextDecoder().decode(frame.subarray(1))
      expect(JSON.parse(json)).toEqual({ columns: 120, rows: 40 })
    })
  })

  describe('close', () => {
    it('closes WebSocket and transitions to closed state', async () => {
      const session = connectTerminal(info)
      const ws = MockWebSocket.instances[0]!
      ws.simulateOpen()
      await session.ready

      session.close()
      expect(ws.close).toHaveBeenCalledOnce()
      expect(session.state).toBe('closed')
    })

    it('is idempotent', async () => {
      const session = connectTerminal(info)
      const ws = MockWebSocket.instances[0]!
      ws.simulateOpen()
      await session.ready

      session.close()
      session.close()
      expect(ws.close).toHaveBeenCalledOnce()
    })

    it('transitions to closed on server disconnect', async () => {
      const session = connectTerminal(info)
      const ws = MockWebSocket.instances[0]!
      ws.simulateOpen()
      await session.ready

      ws.simulateClose()
      expect(session.state).toBe('closed')
    })
  })
})
