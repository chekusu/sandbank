import { describe, it, expect, beforeEach } from 'vitest'
import { createRequest, RpcPendingMap, resetIdCounter } from '../src/rpc.js'

describe('createRequest', () => {
  beforeEach(() => {
    resetIdCounter()
  })

  it('should create a valid JSON-RPC request', () => {
    const req = createRequest('message.send', { to: 'backend', type: 'task' })
    expect(req).toEqual({
      jsonrpc: '2.0',
      id: 1,
      method: 'message.send',
      params: { to: 'backend', type: 'task' },
    })
  })

  it('should auto-increment IDs', () => {
    const r1 = createRequest('a')
    const r2 = createRequest('b')
    expect(r2.id).toBe((r1.id as number) + 1)
  })

  it('should omit params if not provided', () => {
    const req = createRequest('context.keys')
    expect(req).not.toHaveProperty('params')
  })
})

describe('RpcPendingMap', () => {
  it('should resolve pending requests', async () => {
    const pending = new RpcPendingMap()
    const promise = pending.add(1)
    pending.resolve({ jsonrpc: '2.0', id: 1, result: { ok: true } })
    const result = await promise
    expect(result).toEqual({ ok: true })
  })

  it('should reject on RPC error', async () => {
    const pending = new RpcPendingMap()
    const promise = pending.add(1)
    pending.resolve({ jsonrpc: '2.0', id: 1, error: { code: -32000, message: 'fail' } })
    await expect(promise).rejects.toThrow('RPC error -32000: fail')
  })

  it('should reject all on rejectAll', async () => {
    const pending = new RpcPendingMap()
    const p1 = pending.add(1)
    const p2 = pending.add(2)
    pending.rejectAll('closed')
    await expect(p1).rejects.toThrow('closed')
    await expect(p2).rejects.toThrow('closed')
  })

  it('should return false for unknown response IDs', () => {
    const pending = new RpcPendingMap()
    const resolved = pending.resolve({ jsonrpc: '2.0', id: 999, result: {} })
    expect(resolved).toBe(false)
  })

  it('should return false for null ID', () => {
    const pending = new RpcPendingMap()
    const resolved = pending.resolve({ jsonrpc: '2.0', id: null as unknown as number, result: {} })
    expect(resolved).toBe(false)
  })
})
