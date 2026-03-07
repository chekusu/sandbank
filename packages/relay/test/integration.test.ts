import { describe, it, expect, afterEach } from 'vitest'
import { startRelay, type RelayServer } from '../src/index.js'
import type { JsonRpcRequest, JsonRpcResponse } from '@sandbank/core'

let relay: RelayServer | undefined

afterEach(async () => {
  if (relay) {
    await relay.close()
    relay = undefined
  }
  sessionTokens.clear()
})

/** 每个 session 的 token 缓存 */
const sessionTokens = new Map<string, string>()

function rpc(url: string, method: string, params?: Record<string, unknown>, headers?: Record<string, string>) {
  const request: JsonRpcRequest = {
    jsonrpc: '2.0',
    id: Math.floor(Math.random() * 100000),
    method,
    ...(params ? { params } : {}),
  }

  const sessionId = headers?.['X-Session-Id']
  // 首次请求时自动生成 token 并缓存
  if (sessionId && !sessionTokens.has(sessionId)) {
    sessionTokens.set(sessionId, crypto.randomUUID())
  }
  const cachedToken = sessionId ? sessionTokens.get(sessionId) : undefined

  return fetch(`${url}/rpc`, {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      ...(cachedToken ? { 'X-Auth-Token': cachedToken } : {}),
      ...headers,
    },
    body: JSON.stringify(request),
  }).then((r) => {
    const token = r.headers.get('X-Auth-Token')
    if (sessionId && token) {
      sessionTokens.set(sessionId, token)
    }
    return r.json() as Promise<JsonRpcResponse>
  })
}

function connectWs(wsUrl: string, sessionId: string, opts: { sandboxName?: string; role?: string; token?: string } = {}): Promise<{
  ws: WebSocket
  send: (method: string, params?: Record<string, unknown>) => Promise<unknown>
  waitNotification: (timeoutMs?: number) => Promise<any>
  close: () => void
}> {
  return new Promise((resolve, reject) => {
    const ws = new WebSocket(wsUrl)
    let nextId = 1
    const pending = new Map<number, { resolve: (v: unknown) => void; reject: (e: Error) => void }>()
    const notifications: any[] = []
    const notificationWaiters: Array<(msg: any) => void> = []

    ws.addEventListener('open', async () => {
      // Auth
      const authId = nextId++
      ws.send(JSON.stringify({
        jsonrpc: '2.0', id: authId, method: 'session.auth',
        params: {
          sessionId,
          sandboxName: opts.sandboxName,
          role: opts.role ?? 'agent',
          token: opts.token ?? sessionTokens.get(sessionId),
        },
      }))

      // Wait for auth response
      const authPromise = new Promise<void>((res, rej) => {
        const handler = (evt: MessageEvent) => {
          const msg = JSON.parse(String(evt.data))
          if (msg.id === authId) {
            ws.removeEventListener('message', handler)
            if (msg.error) rej(new Error(msg.error.message))
            else res()
          }
        }
        ws.addEventListener('message', handler)
      })

      await authPromise

      // Set up message routing
      ws.addEventListener('message', (evt) => {
        const msg = JSON.parse(String(evt.data))
        if (msg.id != null && pending.has(msg.id)) {
          const p = pending.get(msg.id)!
          pending.delete(msg.id)
          if (msg.error) p.reject(new Error(msg.error.message))
          else p.resolve(msg.result)
        } else {
          // Notification
          if (notificationWaiters.length > 0) {
            notificationWaiters.shift()!(msg)
          } else {
            notifications.push(msg)
          }
        }
      })

      resolve({
        ws,
        async send(method, params) {
          const id = nextId++
          ws.send(JSON.stringify({ jsonrpc: '2.0', id, method, ...(params ? { params } : {}) }))
          return new Promise((res, rej) => { pending.set(id, { resolve: res, reject: rej }) })
        },
        waitNotification(timeoutMs = 5000) {
          if (notifications.length > 0) return Promise.resolve(notifications.shift())
          return new Promise((res, rej) => {
            const timer = setTimeout(() => rej(new Error('Notification timeout')), timeoutMs)
            notificationWaiters.push((msg) => {
              clearTimeout(timer)
              res(msg)
            })
          })
        },
        close() { ws.close() },
      })
    })

    ws.addEventListener('error', () => reject(new Error('WS connection failed')))
  })
}

describe('integration: multi-agent scenario', () => {
  it('should route messages between two agents via HTTP', async () => {
    relay = await startRelay({ port: 0 })
    const sid = 'multi-agent-1'
    const h = { 'X-Session-Id': sid }

    // Register 2 agents
    await rpc(relay.url, 'session.register', { name: 'frontend', sandboxId: 'sb-fe' }, h)
    await rpc(relay.url, 'session.register', { name: 'backend', sandboxId: 'sb-be' }, h)

    // Frontend sends to backend
    await rpc(relay.url, 'message.send', {
      to: 'backend', type: 'api-request', payload: { endpoint: '/users' },
    }, { ...h, 'X-Sandbox-Name': 'frontend' })

    // Backend receives
    const result = await rpc(relay.url, 'message.recv', { limit: 10 }, {
      ...h, 'X-Sandbox-Name': 'backend',
    })
    const msgs = (result.result as { messages: Array<{ from: string; type: string }> }).messages
    expect(msgs).toHaveLength(1)
    expect(msgs[0]!.from).toBe('frontend')
    expect(msgs[0]!.type).toBe('api-request')
  })

  it('should support WebSocket agents receiving real-time messages', async () => {
    relay = await startRelay({ port: 0 })
    const sid = 'ws-agent-test'
    const h = { 'X-Session-Id': sid }

    await rpc(relay.url, 'session.register', { name: 'worker', sandboxId: 'sb-w' }, h)

    // Connect worker via WebSocket (token auto-retrieved from sessionTokens)
    const worker = await connectWs(relay.wsUrl, sid, { sandboxName: 'worker' })

    // Send message via HTTP (orchestrator)
    await rpc(relay.url, 'message.send', {
      to: 'worker', type: 'start-task', payload: { task: 'build' },
    }, h)

    // Worker receives via WebSocket push
    const notification = await worker.waitNotification()
    expect(notification.method).toBe('message')
    expect(notification.params.type).toBe('start-task')

    worker.close()
  })

  it('should support shared context between agents', async () => {
    relay = await startRelay({ port: 0 })
    const sid = 'shared-context'
    const h = { 'X-Session-Id': sid }

    await rpc(relay.url, 'session.register', { name: 'writer', sandboxId: 'sb-w' }, h)
    await rpc(relay.url, 'session.register', { name: 'reader', sandboxId: 'sb-r' }, h)

    // Writer sets context
    await rpc(relay.url, 'context.set', {
      key: 'api-spec', value: { version: 3, endpoints: ['/users', '/posts'] },
    }, { ...h, 'X-Sandbox-Name': 'writer' })

    // Reader reads context
    const result = await rpc(relay.url, 'context.get', { key: 'api-spec' }, {
      ...h, 'X-Sandbox-Name': 'reader',
    })
    expect((result.result as { value: unknown }).value).toEqual({
      version: 3,
      endpoints: ['/users', '/posts'],
    })
  })

  it('should notify orchestrator when agent completes', async () => {
    relay = await startRelay({ port: 0 })
    const sid = 'completion-test'
    const h = { 'X-Session-Id': sid }

    await rpc(relay.url, 'session.register', { name: 'builder', sandboxId: 'sb-b' }, h)

    // Connect orchestrator via WebSocket (token auto-retrieved from sessionTokens)
    const orch = await connectWs(relay.wsUrl, sid, { role: 'orchestrator' })

    // Agent completes via HTTP
    await rpc(relay.url, 'sandbox.complete', {
      status: 'success', summary: 'Build complete',
    }, { ...h, 'X-Sandbox-Name': 'builder' })

    // Orchestrator should get notification
    const notification = await orch.waitNotification()
    expect(notification.method).toBe('sandbox.state')
    expect(notification.params.name).toBe('builder')
    expect(notification.params.status).toBe('success')

    orch.close()
  })

  it('should handle context change notifications for WS clients', async () => {
    relay = await startRelay({ port: 0 })
    const sid = 'ctx-notify'
    const h = { 'X-Session-Id': sid }

    await rpc(relay.url, 'session.register', { name: 'watcher', sandboxId: 'sb-w' }, h)

    // Connect watcher via WebSocket
    const watcher = await connectWs(relay.wsUrl, sid, { sandboxName: 'watcher' })

    // Set context via HTTP
    await rpc(relay.url, 'context.set', {
      key: 'status', value: 'building',
    }, h)

    // Watcher should get notification
    const notification = await watcher.waitNotification()
    expect(notification.method).toBe('context.changed')
    expect(notification.params.key).toBe('status')
    expect(notification.params.value).toBe('building')

    watcher.close()
  })

  it('should broadcast messages to all agents except sender', async () => {
    relay = await startRelay({ port: 0 })
    const sid = 'broadcast-test'
    const h = { 'X-Session-Id': sid }

    await rpc(relay.url, 'session.register', { name: 'a1', sandboxId: 'sb-1' }, h)
    await rpc(relay.url, 'session.register', { name: 'a2', sandboxId: 'sb-2' }, h)
    await rpc(relay.url, 'session.register', { name: 'a3', sandboxId: 'sb-3' }, h)

    // a1 broadcasts
    await rpc(relay.url, 'message.broadcast', {
      type: 'announcement', payload: 'hello all',
    }, { ...h, 'X-Sandbox-Name': 'a1' })

    // a1 should NOT receive
    const r1 = await rpc(relay.url, 'message.recv', { limit: 10 }, { ...h, 'X-Sandbox-Name': 'a1' })
    expect((r1.result as { messages: unknown[] }).messages).toHaveLength(0)

    // a2 and a3 should receive
    const r2 = await rpc(relay.url, 'message.recv', { limit: 10 }, { ...h, 'X-Sandbox-Name': 'a2' })
    const r3 = await rpc(relay.url, 'message.recv', { limit: 10 }, { ...h, 'X-Sandbox-Name': 'a3' })
    expect((r2.result as { messages: unknown[] }).messages).toHaveLength(1)
    expect((r3.result as { messages: unknown[] }).messages).toHaveLength(1)
  })
})
