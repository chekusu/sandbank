import { describe, it, expect } from 'vitest'
import type { JsonRpcRequest } from '@sandbank/core'
import { handleRpc, handleAuth } from '../src/protocol.js'
import { SessionStore } from '../src/session-store.js'
import type { ConnectedClient } from '../src/types.js'

function makeClient(overrides: Partial<{ sessionId: string; sandboxName: string | null; role: 'orchestrator' | 'agent' }> = {}) {
  return {
    sessionId: overrides.sessionId ?? 'test-session',
    sandboxName: overrides.sandboxName ?? null,
    role: overrides.role ?? 'orchestrator',
  }
}

function rpc(method: string, params?: Record<string, unknown>, id = 1): JsonRpcRequest {
  return { jsonrpc: '2.0', id, method, ...(params ? { params } : {}) }
}

describe('protocol', () => {
  describe('session.register', () => {
    it('should register a sandbox', () => {
      const store = new SessionStore()
      store.createSession('s1')

      const result = handleRpc(store, rpc('session.register', { name: 'backend', sandboxId: 'sb-1' }), makeClient({ sessionId: 's1' }))
      expect(result).toEqual({ jsonrpc: '2.0', id: 1, result: { ok: true } })

      const session = store.getSession('s1')!
      expect(session.sandboxes.has('backend')).toBe(true)
    })

    it('should error on missing params', () => {
      const store = new SessionStore()
      store.createSession('s1')

      const result = handleRpc(store, rpc('session.register', {}), makeClient({ sessionId: 's1' }))
      expect(result).toHaveProperty('error')
    })
  })

  describe('message.send', () => {
    it('should send a message', () => {
      const store = new SessionStore()
      const session = store.createSession('s1')
      store.registerSandbox('s1', 'backend', 'sb-1')

      const result = handleRpc(
        store,
        rpc('message.send', { to: 'backend', type: 'task', payload: { x: 1 } }),
        makeClient({ sessionId: 's1' }),
      )
      expect(result).toEqual({ jsonrpc: '2.0', id: 1, result: { ok: true } })

      const msgs = store.drainQueue(session, 'backend')
      expect(msgs).toHaveLength(1)
      expect(msgs[0]!.type).toBe('task')
      expect(msgs[0]!.priority).toBe('normal')
    })

    it('should send steer message', () => {
      const store = new SessionStore()
      const session = store.createSession('s1')
      store.registerSandbox('s1', 'backend', 'sb-1')

      handleRpc(
        store,
        rpc('message.send', { to: 'backend', type: 'urgent', payload: null, priority: 'steer' }),
        makeClient({ sessionId: 's1' }),
      )

      const msgs = store.drainQueue(session, 'backend')
      expect(msgs[0]!.priority).toBe('steer')
    })
  })

  describe('message.recv', () => {
    it('should receive messages immediately', () => {
      const store = new SessionStore()
      const session = store.createSession('s1')
      store.registerSandbox('s1', 'backend', 'sb-1')

      store.enqueueMessage(session, 'backend', {
        from: 'orchestrator', to: 'backend', type: 'task', payload: null,
        priority: 'normal', timestamp: new Date().toISOString(),
      })

      const result = handleRpc(
        store,
        rpc('message.recv', { limit: 10 }),
        makeClient({ sessionId: 's1', sandboxName: 'backend', role: 'agent' }),
      )

      expect(result).toHaveProperty('result')
      const r = (result as { result: { messages: unknown[] } }).result
      expect(r.messages).toHaveLength(1)
    })

    it('should error without sandbox name', () => {
      const store = new SessionStore()
      store.createSession('s1')

      const result = handleRpc(
        store,
        rpc('message.recv'),
        makeClient({ sessionId: 's1', sandboxName: null }),
      )
      expect(result).toHaveProperty('error')
    })
  })

  describe('context operations', () => {
    it('should set and get context', () => {
      const store = new SessionStore()
      store.createSession('s1')

      handleRpc(store, rpc('context.set', { key: 'k1', value: 'v1' }), makeClient({ sessionId: 's1' }))
      const result = handleRpc(store, rpc('context.get', { key: 'k1' }, 2), makeClient({ sessionId: 's1' }))

      expect(result).toEqual({ jsonrpc: '2.0', id: 2, result: { value: 'v1' } })
    })

    it('should delete context', () => {
      const store = new SessionStore()
      store.createSession('s1')

      handleRpc(store, rpc('context.set', { key: 'k1', value: 'v1' }), makeClient({ sessionId: 's1' }))
      handleRpc(store, rpc('context.delete', { key: 'k1' }, 2), makeClient({ sessionId: 's1' }))
      const result = handleRpc(store, rpc('context.get', { key: 'k1' }, 3), makeClient({ sessionId: 's1' }))

      expect(result).toEqual({ jsonrpc: '2.0', id: 3, result: { value: null } })
    })

    it('should list context keys', () => {
      const store = new SessionStore()
      store.createSession('s1')

      handleRpc(store, rpc('context.set', { key: 'a', value: 1 }), makeClient({ sessionId: 's1' }))
      handleRpc(store, rpc('context.set', { key: 'b', value: 2 }, 2), makeClient({ sessionId: 's1' }))

      const result = handleRpc(store, rpc('context.keys', undefined, 3), makeClient({ sessionId: 's1' }))
      expect(result).toEqual({ jsonrpc: '2.0', id: 3, result: { keys: ['a', 'b'] } })
    })
  })

  describe('sandbox.complete', () => {
    it('should mark sandbox as complete', () => {
      const store = new SessionStore()
      const session = store.createSession('s1')
      store.registerSandbox('s1', 'backend', 'sb-1')

      const result = handleRpc(
        store,
        rpc('sandbox.complete', { status: 'success', summary: 'Done' }),
        makeClient({ sessionId: 's1', sandboxName: 'backend', role: 'agent' }),
      )
      expect(result).toEqual({ jsonrpc: '2.0', id: 1, result: { ok: true } })

      const entry = session.sandboxes.get('backend')!
      expect(entry.state).toBe('completed')
    })
  })

  describe('unknown method', () => {
    it('should return method not found error', () => {
      const store = new SessionStore()
      store.createSession('s1')

      const result = handleRpc(store, rpc('unknown.method'), makeClient({ sessionId: 's1' }))
      expect(result).toHaveProperty('error')
      expect((result as { error: { code: number } }).error.code).toBe(-32601)
    })
  })
})
