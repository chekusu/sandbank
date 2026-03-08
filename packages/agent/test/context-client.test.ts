import { describe, it, expect, vi, beforeEach } from 'vitest'
import type { Transport } from '@sandbank.dev/core'
import { RpcPendingMap } from '../src/rpc.js'
import { createWsContextClient } from '../src/context-client.js'

function createMockTransport() {
  const listeners: Array<(data: string) => void> = []
  const transport: Transport = {
    send: vi.fn(),
    onMessage(fn) { listeners.push(fn) },
    close: vi.fn(),
    get readyState() { return 'open' as const },
  }
  return {
    transport,
    /** Simulate server sending a message */
    emit(msg: object) {
      const data = JSON.stringify(msg)
      for (const fn of listeners) fn(data)
    },
    /** Push raw string to listeners (for invalid JSON testing) */
    emitRaw(data: string) {
      for (const fn of listeners) fn(data)
    },
  }
}

describe('createWsContextClient', () => {
  let mock: ReturnType<typeof createMockTransport>
  let pending: RpcPendingMap

  beforeEach(() => {
    mock = createMockTransport()
    pending = new RpcPendingMap()
  })

  it('get() should send context.get RPC and return value', async () => {
    const ctx = createWsContextClient(mock.transport, pending)
    const promise = ctx.get('mykey')

    const sent = JSON.parse((mock.transport.send as ReturnType<typeof vi.fn>).mock.calls[0][0])
    expect(sent.method).toBe('context.get')
    expect(sent.params).toEqual({ key: 'mykey' })

    pending.resolve({ jsonrpc: '2.0', id: sent.id, result: { value: 42 } })
    expect(await promise).toBe(42)
  })

  it('get() should return undefined when value is null', async () => {
    const ctx = createWsContextClient(mock.transport, pending)
    const promise = ctx.get('missing')

    const sent = JSON.parse((mock.transport.send as ReturnType<typeof vi.fn>).mock.calls[0][0])
    pending.resolve({ jsonrpc: '2.0', id: sent.id, result: { value: null } })
    expect(await promise).toBeUndefined()
  })

  it('set() should send context.set RPC', async () => {
    const ctx = createWsContextClient(mock.transport, pending)
    const promise = ctx.set('key1', { data: 'hello' })

    const sent = JSON.parse((mock.transport.send as ReturnType<typeof vi.fn>).mock.calls[0][0])
    expect(sent.method).toBe('context.set')
    expect(sent.params).toEqual({ key: 'key1', value: { data: 'hello' } })

    pending.resolve({ jsonrpc: '2.0', id: sent.id, result: {} })
    await promise
  })

  it('delete() should send context.delete RPC', async () => {
    const ctx = createWsContextClient(mock.transport, pending)
    const promise = ctx.delete('key1')

    const sent = JSON.parse((mock.transport.send as ReturnType<typeof vi.fn>).mock.calls[0][0])
    expect(sent.method).toBe('context.delete')
    expect(sent.params).toEqual({ key: 'key1' })

    pending.resolve({ jsonrpc: '2.0', id: sent.id, result: {} })
    await promise
  })

  it('keys() should send context.keys RPC and return array', async () => {
    const ctx = createWsContextClient(mock.transport, pending)
    const promise = ctx.keys()

    const sent = JSON.parse((mock.transport.send as ReturnType<typeof vi.fn>).mock.calls[0][0])
    expect(sent.method).toBe('context.keys')

    pending.resolve({ jsonrpc: '2.0', id: sent.id, result: { keys: ['a', 'b'] } })
    expect(await promise).toEqual(['a', 'b'])
  })

  it('watch() should fire callback on context.changed notification', () => {
    const ctx = createWsContextClient(mock.transport, pending)
    const cb = vi.fn()
    ctx.watch('mykey', cb)

    mock.emit({ jsonrpc: '2.0', method: 'context.changed', params: { key: 'mykey', value: 'new-val' } })
    expect(cb).toHaveBeenCalledWith('new-val')
  })

  it('watch() should not fire for different key', () => {
    const ctx = createWsContextClient(mock.transport, pending)
    const cb = vi.fn()
    ctx.watch('mykey', cb)

    mock.emit({ jsonrpc: '2.0', method: 'context.changed', params: { key: 'other', value: 99 } })
    expect(cb).not.toHaveBeenCalled()
  })

  it('watch() unsubscribe should stop notifications', () => {
    const ctx = createWsContextClient(mock.transport, pending)
    const cb = vi.fn()
    const unsub = ctx.watch('mykey', cb)

    mock.emit({ jsonrpc: '2.0', method: 'context.changed', params: { key: 'mykey', value: 1 } })
    expect(cb).toHaveBeenCalledTimes(1)

    unsub()
    mock.emit({ jsonrpc: '2.0', method: 'context.changed', params: { key: 'mykey', value: 2 } })
    expect(cb).toHaveBeenCalledTimes(1)
  })

  it('watchAll() should fire for any key change', () => {
    const ctx = createWsContextClient(mock.transport, pending)
    const cb = vi.fn()
    ctx.watchAll(cb)

    mock.emit({ jsonrpc: '2.0', method: 'context.changed', params: { key: 'a', value: 1 } })
    mock.emit({ jsonrpc: '2.0', method: 'context.changed', params: { key: 'b', value: 2 } })
    expect(cb).toHaveBeenCalledTimes(2)
    expect(cb).toHaveBeenCalledWith('a', 1)
    expect(cb).toHaveBeenCalledWith('b', 2)
  })

  it('watchAll() unsubscribe should stop notifications', () => {
    const ctx = createWsContextClient(mock.transport, pending)
    const cb = vi.fn()
    const unsub = ctx.watchAll(cb)

    mock.emit({ jsonrpc: '2.0', method: 'context.changed', params: { key: 'a', value: 1 } })
    unsub()
    mock.emit({ jsonrpc: '2.0', method: 'context.changed', params: { key: 'b', value: 2 } })
    expect(cb).toHaveBeenCalledTimes(1)
  })

  it('should ignore non-JSON messages gracefully', () => {
    const ctx = createWsContextClient(mock.transport, pending)
    const cb = vi.fn()
    ctx.watchAll(cb)

    mock.emitRaw('not valid json {{{')
    expect(cb).not.toHaveBeenCalled()
  })

  it('should ignore irrelevant notifications', () => {
    const ctx = createWsContextClient(mock.transport, pending)
    const cb = vi.fn()
    ctx.watchAll(cb)

    mock.emit({ jsonrpc: '2.0', method: 'message', params: { from: 'peer' } })
    expect(cb).not.toHaveBeenCalled()
  })
})
