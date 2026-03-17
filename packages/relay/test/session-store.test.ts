import { describe, it, expect, vi, afterEach } from 'vitest'
import { SessionStore } from '../src/session-store.js'

describe('SessionStore', () => {
  const stores: SessionStore[] = []

  function createStore(opts?: ConstructorParameters<typeof SessionStore>[0]) {
    const s = new SessionStore({ sessionTtlMs: 0, ...opts }) // disable sweep timer by default in tests
    stores.push(s)
    return s
  }

  afterEach(() => {
    for (const s of stores) s.dispose()
    stores.length = 0
  })

  it('should create and retrieve sessions', () => {
    const store = createStore()
    const session = store.createSession('s1')
    expect(session.id).toBe('s1')
    expect(store.getSession('s1')).toBe(session)
  })

  it('should set createdAt and lastActivityAt on create', () => {
    const store = createStore()
    const before = Date.now()
    const session = store.createSession('s1')
    const after = Date.now()
    expect(session.createdAt).toBeGreaterThanOrEqual(before)
    expect(session.createdAt).toBeLessThanOrEqual(after)
    expect(session.lastActivityAt).toBe(session.createdAt)
  })

  it('should return undefined for missing sessions', () => {
    const store = createStore()
    expect(store.getSession('missing')).toBeUndefined()
  })

  it('should getOrCreate', () => {
    const store = createStore()
    const s1 = store.getOrCreateSession('s1')
    const s2 = store.getOrCreateSession('s1')
    expect(s1).toBe(s2)
  })

  it('should track size', () => {
    const store = createStore()
    expect(store.size).toBe(0)
    store.createSession('s1')
    expect(store.size).toBe(1)
    store.createSession('s2')
    expect(store.size).toBe(2)
    store.deleteSession('s1')
    expect(store.size).toBe(1)
  })

  it('should register sandboxes', () => {
    const store = createStore()
    store.createSession('s1')
    store.registerSandbox('s1', 'backend', 'sb-123')

    const session = store.getSession('s1')!
    expect(session.sandboxes.get('backend')).toEqual({
      name: 'backend',
      sandboxId: 'sb-123',
      state: 'running',
    })
    expect(session.messageQueues.has('backend')).toBe(true)
  })

  it('should throw when registering to non-existent session', () => {
    const store = createStore()
    expect(() => store.registerSandbox('missing', 'x', 'y')).toThrow('Session not found')
  })

  it('should enforce maxSandboxesPerSession limit', () => {
    const store = createStore({ maxSandboxesPerSession: 2 })
    store.createSession('s1')
    store.registerSandbox('s1', 'a', 'sb-a')
    store.registerSandbox('s1', 'b', 'sb-b')

    expect(() => store.registerSandbox('s1', 'c', 'sb-c')).toThrow('Max sandboxes per session')
  })

  describe('message routing', () => {
    it('should enqueue and drain messages', () => {
      const store = createStore()
      const session = store.createSession('s1')
      store.registerSandbox('s1', 'backend', 'sb-1')

      store.enqueueMessage(session, 'backend', {
        from: 'orchestrator',
        to: 'backend',
        type: 'task',
        payload: { action: 'build' },
        priority: 'normal',
        timestamp: '2024-01-01T00:00:00Z',
      })

      const msgs = store.drainQueue(session, 'backend')
      expect(msgs).toHaveLength(1)
      expect(msgs[0]!.type).toBe('task')

      // Queue should be empty after drain
      const msgs2 = store.drainQueue(session, 'backend')
      expect(msgs2).toHaveLength(0)
    })

    it('should prioritize steer messages', () => {
      const store = createStore()
      const session = store.createSession('s1')
      store.registerSandbox('s1', 'backend', 'sb-1')

      store.enqueueMessage(session, 'backend', {
        from: 'orchestrator', to: 'backend',
        type: 'normal-task', payload: null, priority: 'normal',
        timestamp: '2024-01-01T00:00:00Z',
      })
      store.enqueueMessage(session, 'backend', {
        from: 'orchestrator', to: 'backend',
        type: 'urgent-task', payload: null, priority: 'steer',
        timestamp: '2024-01-01T00:00:01Z',
      })
      store.enqueueMessage(session, 'backend', {
        from: 'orchestrator', to: 'backend',
        type: 'another-normal', payload: null, priority: 'normal',
        timestamp: '2024-01-01T00:00:02Z',
      })

      const msgs = store.drainQueue(session, 'backend')
      expect(msgs).toHaveLength(3)
      expect(msgs[0]!.type).toBe('urgent-task')
      expect(msgs[0]!.priority).toBe('steer')
    })

    it('should respect drain limit', () => {
      const store = createStore()
      const session = store.createSession('s1')
      store.registerSandbox('s1', 'backend', 'sb-1')

      for (let i = 0; i < 5; i++) {
        store.enqueueMessage(session, 'backend', {
          from: 'orchestrator', to: 'backend',
          type: `msg-${i}`, payload: null, priority: 'normal',
          timestamp: new Date().toISOString(),
        })
      }

      const msgs = store.drainQueue(session, 'backend', 2)
      expect(msgs).toHaveLength(2)

      const remaining = store.drainQueue(session, 'backend')
      expect(remaining).toHaveLength(3)
    })

    it('should broadcast to all except sender', () => {
      const store = createStore()
      const session = store.createSession('s1')
      store.registerSandbox('s1', 'frontend', 'sb-1')
      store.registerSandbox('s1', 'backend', 'sb-2')
      store.registerSandbox('s1', 'devops', 'sb-3')

      store.broadcastMessage(session, {
        from: 'frontend', to: null,
        type: 'update', payload: { v: 1 }, priority: 'normal',
        timestamp: new Date().toISOString(),
      }, 'frontend')

      // frontend should not get the message
      expect(store.drainQueue(session, 'frontend')).toHaveLength(0)
      // backend and devops should
      expect(store.drainQueue(session, 'backend')).toHaveLength(1)
      expect(store.drainQueue(session, 'devops')).toHaveLength(1)
    })
  })

  describe('long polling', () => {
    it('should return immediately if queue has messages', async () => {
      const store = createStore()
      const session = store.createSession('s1')
      store.registerSandbox('s1', 'backend', 'sb-1')

      store.enqueueMessage(session, 'backend', {
        from: 'orchestrator', to: 'backend',
        type: 'task', payload: null, priority: 'normal',
        timestamp: new Date().toISOString(),
      })

      const msgs = await store.waitForMessages(session, 'backend', 5000, 100)
      expect(msgs).toHaveLength(1)
    })

    it('should wait and receive new messages', async () => {
      const store = createStore()
      const session = store.createSession('s1')
      store.registerSandbox('s1', 'backend', 'sb-1')

      // Start waiting
      const promise = store.waitForMessages(session, 'backend', 5000, 100)

      // Enqueue after a delay
      setTimeout(() => {
        store.enqueueMessage(session, 'backend', {
          from: 'orchestrator', to: 'backend',
          type: 'delayed-task', payload: null, priority: 'normal',
          timestamp: new Date().toISOString(),
        })
      }, 50)

      const msgs = await promise
      expect(msgs).toHaveLength(1)
      expect(msgs[0]!.type).toBe('delayed-task')
    })

    it('should return empty on timeout', async () => {
      const store = createStore()
      const session = store.createSession('s1')
      store.registerSandbox('s1', 'backend', 'sb-1')

      const msgs = await store.waitForMessages(session, 'backend', 50, 100)
      expect(msgs).toHaveLength(0)
    })
  })

  describe('sandbox completion', () => {
    it('should mark sandbox as completed', () => {
      const store = createStore()
      const session = store.createSession('s1')
      store.registerSandbox('s1', 'backend', 'sb-1')

      store.completeSandbox(session, 'backend', 'success', 'All done')

      const entry = session.sandboxes.get('backend')!
      expect(entry.state).toBe('completed')
      expect(entry.completion).toMatchObject({
        status: 'success',
        summary: 'All done',
      })
    })
  })

  describe('session deletion', () => {
    it('should clean up on delete', () => {
      const store = createStore()
      store.createSession('s1')
      store.deleteSession('s1')
      expect(store.getSession('s1')).toBeUndefined()
      expect(store.getContext('s1')).toBeUndefined()
    })
  })

  describe('TTL and eviction', () => {
    it('should evict idle sessions with no connected clients', () => {
      const store = createStore({ sessionTtlMs: 100 })
      const session = store.createSession('s1')

      // Manually set lastActivityAt to the past
      session.lastActivityAt = Date.now() - 200

      const evicted = store.sweep()
      expect(evicted).toBe(1)
      expect(store.getSession('s1')).toBeUndefined()
      expect(store.size).toBe(0)
    })

    it('should not evict sessions that are still active', () => {
      const store = createStore({ sessionTtlMs: 1000 })
      store.createSession('s1')

      const evicted = store.sweep()
      expect(evicted).toBe(0)
      expect(store.getSession('s1')).toBeDefined()
    })

    it('should not evict sessions with connected clients even if idle', () => {
      const store = createStore({ sessionTtlMs: 100 })
      const session = store.createSession('s1')
      session.lastActivityAt = Date.now() - 200

      // Add a fake connected client
      session.clients.add({
        ws: { readyState: 1, OPEN: 1, close: vi.fn(), send: vi.fn() } as any,
        sessionId: 's1',
        sandboxName: 'test',
        role: 'agent',
      })

      const evicted = store.sweep()
      expect(evicted).toBe(0)
      expect(store.getSession('s1')).toBeDefined()
    })

    it('should touch session on activity', () => {
      const store = createStore({ sessionTtlMs: 1000 })
      const session = store.createSession('s1')
      const initialActivity = session.lastActivityAt

      // Simulate some time passing
      session.lastActivityAt = initialActivity - 500

      store.registerSandbox('s1', 'backend', 'sb-1')
      expect(session.lastActivityAt).toBeGreaterThan(initialActivity - 500)
    })

    it('should enforce maxSessions limit', () => {
      const store = createStore({ maxSessions: 2, sessionTtlMs: 100 })
      store.createSession('s1')
      store.createSession('s2')

      // Third session should throw (neither is expired yet)
      expect(() => store.createSession('s3')).toThrow('Max sessions reached')
    })

    it('should auto-evict expired sessions when maxSessions reached', () => {
      const store = createStore({ maxSessions: 2, sessionTtlMs: 100 })
      const s1 = store.createSession('s1')
      store.createSession('s2')

      // Expire s1
      s1.lastActivityAt = Date.now() - 200

      // Should succeed by evicting s1
      const s3 = store.createSession('s3')
      expect(s3.id).toBe('s3')
      expect(store.getSession('s1')).toBeUndefined()
      expect(store.size).toBe(2)
    })
  })

  describe('unregisterSandbox', () => {
    it('should remove sandbox entry', () => {
      const store = createStore()
      store.createSession('s1')
      store.registerSandbox('s1', 'backend', 'sb-1')

      store.unregisterSandbox('s1', 'backend')

      const session = store.getSession('s1')!
      expect(session.sandboxes.has('backend')).toBe(false)
    })

    it('should clean message queue', () => {
      const store = createStore()
      const session = store.createSession('s1')
      store.registerSandbox('s1', 'backend', 'sb-1')

      store.enqueueMessage(session, 'backend', {
        from: 'orchestrator', to: 'backend',
        type: 'task', payload: null, priority: 'normal',
        timestamp: new Date().toISOString(),
      })

      store.unregisterSandbox('s1', 'backend')
      expect(session.messageQueues.has('backend')).toBe(false)
    })

    it('should resolve poll waiters with empty array', async () => {
      const store = createStore()
      const session = store.createSession('s1')
      store.registerSandbox('s1', 'backend', 'sb-1')

      const promise = store.waitForMessages(session, 'backend', 5000, 100)
      store.unregisterSandbox('s1', 'backend')

      const msgs = await promise
      expect(msgs).toHaveLength(0)
      expect(session.pollWaiters.has('backend')).toBe(false)
    })

    it('should disconnect WS client for that sandbox', () => {
      const store = createStore()
      const session = store.createSession('s1')
      store.registerSandbox('s1', 'backend', 'sb-1')

      const closeFn = vi.fn()
      session.clients.add({
        ws: { readyState: 1, OPEN: 1, close: closeFn, send: vi.fn() } as any,
        sessionId: 's1',
        sandboxName: 'backend',
        role: 'agent',
      })
      // Other sandbox client should not be affected
      const otherCloseFn = vi.fn()
      session.clients.add({
        ws: { readyState: 1, OPEN: 1, close: otherCloseFn, send: vi.fn() } as any,
        sessionId: 's1',
        sandboxName: 'frontend',
        role: 'agent',
      })

      store.unregisterSandbox('s1', 'backend')

      expect(closeFn).toHaveBeenCalledWith(1000, 'sandbox unregistered')
      expect(otherCloseFn).not.toHaveBeenCalled()
    })

    it('should be idempotent for missing sandbox', () => {
      const store = createStore()
      store.createSession('s1')

      // Should not throw
      expect(() => store.unregisterSandbox('s1', 'nonexistent')).not.toThrow()
    })

    it('should be idempotent for missing session', () => {
      const store = createStore()

      // Should not throw
      expect(() => store.unregisterSandbox('missing', 'backend')).not.toThrow()
    })
  })

  describe('message queue limits', () => {
    it('should drop oldest normal message when queue is full', () => {
      const store = createStore({ maxQueueSize: 3 })
      const session = store.createSession('s1')
      store.registerSandbox('s1', 'backend', 'sb-1')

      // Fill queue
      for (let i = 0; i < 3; i++) {
        store.enqueueMessage(session, 'backend', {
          from: 'orchestrator', to: 'backend',
          type: `msg-${i}`, payload: null, priority: 'normal',
          timestamp: new Date().toISOString(),
        })
      }

      // Add one more — should drop msg-0
      store.enqueueMessage(session, 'backend', {
        from: 'orchestrator', to: 'backend',
        type: 'msg-3', payload: null, priority: 'normal',
        timestamp: new Date().toISOString(),
      })

      const msgs = store.drainQueue(session, 'backend')
      expect(msgs).toHaveLength(3)
      expect(msgs[0]!.type).toBe('msg-1')
      expect(msgs[2]!.type).toBe('msg-3')
    })

    it('should preserve steer messages when dropping for queue overflow', () => {
      const store = createStore({ maxQueueSize: 2 })
      const session = store.createSession('s1')
      store.registerSandbox('s1', 'backend', 'sb-1')

      // Add a steer message and a normal message
      store.enqueueMessage(session, 'backend', {
        from: 'orchestrator', to: 'backend',
        type: 'steer-msg', payload: null, priority: 'steer',
        timestamp: new Date().toISOString(),
      })
      store.enqueueMessage(session, 'backend', {
        from: 'orchestrator', to: 'backend',
        type: 'normal-msg', payload: null, priority: 'normal',
        timestamp: new Date().toISOString(),
      })

      // Overflow — should drop the normal message, keep steer
      store.enqueueMessage(session, 'backend', {
        from: 'orchestrator', to: 'backend',
        type: 'new-msg', payload: null, priority: 'normal',
        timestamp: new Date().toISOString(),
      })

      const msgs = store.drainQueue(session, 'backend')
      expect(msgs).toHaveLength(2)
      // steer should be first after drain sorting
      expect(msgs[0]!.type).toBe('steer-msg')
      expect(msgs[0]!.priority).toBe('steer')
    })
  })

  describe('WS push dequeue (Phase 2)', () => {
    it('should remove message from queue after successful WS push', () => {
      const store = createStore()
      const session = store.createSession('s1')
      store.registerSandbox('s1', 'backend', 'sb-1')

      // Add a connected WS client for 'backend'
      session.clients.add({
        ws: { readyState: 1, OPEN: 1, close: vi.fn(), send: vi.fn() } as any,
        sessionId: 's1',
        sandboxName: 'backend',
        role: 'agent',
      })

      store.enqueueMessage(session, 'backend', {
        from: 'orchestrator', to: 'backend',
        type: 'task', payload: null, priority: 'normal',
        timestamp: new Date().toISOString(),
      })

      // Queue should be empty — message was pushed via WS and removed
      const msgs = store.drainQueue(session, 'backend')
      expect(msgs).toHaveLength(0)
    })

    it('should keep message in queue when no WS client is online', () => {
      const store = createStore()
      const session = store.createSession('s1')
      store.registerSandbox('s1', 'backend', 'sb-1')

      // No WS client connected
      store.enqueueMessage(session, 'backend', {
        from: 'orchestrator', to: 'backend',
        type: 'task', payload: null, priority: 'normal',
        timestamp: new Date().toISOString(),
      })

      // Message should remain for polling
      const msgs = store.drainQueue(session, 'backend')
      expect(msgs).toHaveLength(1)
    })
  })

  describe('orchestrator durable queue (Phase 3)', () => {
    it('should queue message for orchestrator when offline', () => {
      const store = createStore()
      const session = store.createSession('s1')
      store.registerSandbox('s1', 'backend', 'sb-1')

      // No orchestrator connected — send from sandbox to orchestrator
      store.enqueueMessage(session, 'orchestrator-target', {
        from: 'backend', to: 'orchestrator',
        type: 'browser.open', payload: { url: 'https://example.com' }, priority: 'normal',
        timestamp: new Date().toISOString(),
      })

      // Message should be in orchestratorQueue
      expect(session.orchestratorQueue).toHaveLength(1)
      expect(session.orchestratorQueue[0]!.type).toBe('browser.open')
    })

    it('should dequeue orchestrator message after successful WS push', () => {
      const store = createStore()
      const session = store.createSession('s1')
      store.registerSandbox('s1', 'backend', 'sb-1')

      // Connect orchestrator
      session.clients.add({
        ws: { readyState: 1, OPEN: 1, close: vi.fn(), send: vi.fn() } as any,
        sessionId: 's1',
        sandboxName: null,
        role: 'orchestrator',
      })

      store.enqueueMessage(session, 'orchestrator-target', {
        from: 'backend', to: 'orchestrator',
        type: 'browser.open', payload: null, priority: 'normal',
        timestamp: new Date().toISOString(),
      })

      // Queue should be empty — message was pushed and removed
      expect(session.orchestratorQueue).toHaveLength(0)
    })

    it('should allow orchestrator to pull messages via drainOrchestratorQueue', () => {
      const store = createStore()
      const session = store.createSession('s1')

      // Manually push to orchestrator queue (simulating offline accumulation)
      session.orchestratorQueue.push({
        from: 'backend', to: 'orchestrator',
        type: 'browser.open', payload: null, priority: 'normal',
        timestamp: new Date().toISOString(),
      })
      session.orchestratorQueue.push({
        from: 'backend', to: 'orchestrator',
        type: 'browser.click', payload: null, priority: 'normal',
        timestamp: new Date().toISOString(),
      })

      const msgs = store.drainOrchestratorQueue(session, 100)
      expect(msgs).toHaveLength(2)
      expect(session.orchestratorQueue).toHaveLength(0)
    })

    it('should respect maxQueueSize for orchestrator queue', () => {
      const store = createStore({ maxQueueSize: 2 })
      const session = store.createSession('s1')
      store.registerSandbox('s1', 'backend', 'sb-1')

      // No orchestrator connected — messages queue up
      for (let i = 0; i < 3; i++) {
        store.enqueueMessage(session, 'unknown-target', {
          from: 'backend', to: 'orchestrator',
          type: `msg-${i}`, payload: null, priority: 'normal',
          timestamp: new Date().toISOString(),
        })
      }

      // Should be capped at maxQueueSize, oldest dropped
      expect(session.orchestratorQueue).toHaveLength(2)
      expect(session.orchestratorQueue[0]!.type).toBe('msg-1')
      expect(session.orchestratorQueue[1]!.type).toBe('msg-2')
    })
  })
})
