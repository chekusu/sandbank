import { describe, it, expect, afterEach } from 'vitest'
import { startRelay, type RelayServer } from '../src/index.js'
import type { JsonRpcRequest, JsonRpcResponse } from '@sandbank/core'

let relay: RelayServer | undefined

afterEach(async () => {
  if (relay) {
    await relay.close()
    relay = undefined
  }
})

/** 每个 session 的 token 缓存 */
const sessionTokens = new Map<string, string>()

afterEach(() => { sessionTokens.clear() })

async function httpRpc(
  url: string,
  method: string,
  params?: Record<string, unknown>,
  headers?: Record<string, string>,
): Promise<JsonRpcResponse> {
  const request: JsonRpcRequest = {
    jsonrpc: '2.0',
    id: Math.floor(Math.random() * 10000),
    method,
    ...(params ? { params } : {}),
  }

  const sessionId = headers?.['X-Session-Id']
  const cachedToken = sessionId ? sessionTokens.get(sessionId) : undefined

  const res = await fetch(`${url}/rpc`, {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      ...(cachedToken ? { 'X-Auth-Token': cachedToken } : {}),
      ...headers,
    },
    body: JSON.stringify(request),
  })

  // 缓存响应中返回的 token
  const token = res.headers.get('X-Auth-Token')
  if (sessionId && token) {
    sessionTokens.set(sessionId, token)
  }

  return res.json() as Promise<JsonRpcResponse>
}

describe('relay server', () => {
  it('should start and assign a port', async () => {
    relay = await startRelay({ port: 0 })
    expect(relay.port).toBeGreaterThan(0)
    expect(relay.url).toContain('127.0.0.1')
  })

  it('should respond 404 for non-/rpc routes', async () => {
    relay = await startRelay({ port: 0 })
    const res = await fetch(`${relay.url}/health`)
    expect(res.status).toBe(404)
  })

  it('should handle HTTP RPC: register + send + recv', async () => {
    relay = await startRelay({ port: 0 })
    const sessionId = 'test-session-1'

    // Register sandbox
    const regResult = await httpRpc(relay.url, 'session.register', {
      name: 'backend',
      sandboxId: 'sb-1',
    }, { 'X-Session-Id': sessionId })
    expect(regResult.result).toEqual({ ok: true })

    // Send message from orchestrator
    const sendResult = await httpRpc(relay.url, 'message.send', {
      to: 'backend',
      type: 'task',
      payload: { action: 'build' },
    }, { 'X-Session-Id': sessionId })
    expect(sendResult.result).toEqual({ ok: true })

    // Recv as backend agent
    const recvResult = await httpRpc(relay.url, 'message.recv', {
      limit: 10,
    }, { 'X-Session-Id': sessionId, 'X-Sandbox-Name': 'backend' })

    const messages = (recvResult.result as { messages: unknown[] }).messages
    expect(messages).toHaveLength(1)
  })

  it('should handle context CRUD over HTTP', async () => {
    relay = await startRelay({ port: 0 })
    const sessionId = 'ctx-session'

    // Set
    await httpRpc(relay.url, 'context.set', { key: 'api-spec', value: { version: 2 } }, { 'X-Session-Id': sessionId })

    // Get
    const getResult = await httpRpc(relay.url, 'context.get', { key: 'api-spec' }, { 'X-Session-Id': sessionId })
    expect((getResult.result as { value: unknown }).value).toEqual({ version: 2 })

    // Keys
    const keysResult = await httpRpc(relay.url, 'context.keys', undefined, { 'X-Session-Id': sessionId })
    expect((keysResult.result as { keys: string[] }).keys).toEqual(['api-spec'])

    // Delete
    await httpRpc(relay.url, 'context.delete', { key: 'api-spec' }, { 'X-Session-Id': sessionId })
    const getAfter = await httpRpc(relay.url, 'context.get', { key: 'api-spec' }, { 'X-Session-Id': sessionId })
    expect((getAfter.result as { value: unknown }).value).toBeNull()
  })

  it('should error when missing X-Session-Id header', async () => {
    relay = await startRelay({ port: 0 })
    const res = await fetch(`${relay.url}/rpc`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ jsonrpc: '2.0', id: 1, method: 'context.keys' }),
    })
    const json = await res.json() as JsonRpcResponse
    expect(json.error).toBeDefined()
  })

  it('should reject requests with wrong token', async () => {
    relay = await startRelay({ port: 0 })
    const sessionId = 'token-test'

    // First request creates session
    await httpRpc(relay.url, 'context.keys', undefined, { 'X-Session-Id': sessionId })

    // Request with wrong token should be rejected
    const res = await fetch(`${relay.url}/rpc`, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'X-Session-Id': sessionId,
        'X-Auth-Token': 'wrong-token',
      },
      body: JSON.stringify({ jsonrpc: '2.0', id: 1, method: 'context.keys' }),
    })
    expect(res.status).toBe(403)
  })

  it('should reject requests without token for existing session', async () => {
    relay = await startRelay({ port: 0 })
    const sessionId = 'no-token-test'

    // First request creates session
    await httpRpc(relay.url, 'context.keys', undefined, { 'X-Session-Id': sessionId })

    // Request without token should be rejected
    const res = await fetch(`${relay.url}/rpc`, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'X-Session-Id': sessionId,
      },
      body: JSON.stringify({ jsonrpc: '2.0', id: 1, method: 'context.keys' }),
    })
    expect(res.status).toBe(403)
  })

  it('should handle WebSocket auth + messaging', async () => {
    relay = await startRelay({ port: 0 })
    const sessionId = 'ws-session'

    // Register sandbox via HTTP first (captures token)
    await httpRpc(relay.url, 'session.register', { name: 'worker', sandboxId: 'sb-w' }, { 'X-Session-Id': sessionId })
    const token = sessionTokens.get(sessionId)!

    // Connect agent via WebSocket
    const ws = new WebSocket(relay.wsUrl)
    await new Promise<void>((resolve) => ws.addEventListener('open', () => resolve()))

    // Auth with token
    const authReq: JsonRpcRequest = {
      jsonrpc: '2.0', id: 1, method: 'session.auth',
      params: { sessionId, sandboxName: 'worker', role: 'agent', token },
    }
    ws.send(JSON.stringify(authReq))

    const authResponse = await waitForWsMessage(ws)
    expect(authResponse.result).toMatchObject({ ok: true })

    // Set up listener BEFORE sending HTTP to avoid race condition
    const notificationPromise = waitForWsMessage(ws, 2000)

    // Send message from orchestrator via HTTP
    await httpRpc(relay.url, 'message.send', {
      to: 'worker', type: 'task', payload: 'hello',
    }, { 'X-Session-Id': sessionId })

    // Agent should receive it via WebSocket push
    const notification = await notificationPromise
    expect(notification.method).toBe('message')
    expect((notification.params as { type: string }).type).toBe('task')

    ws.close()
  })

  it('should reject non-auth messages before authentication', async () => {
    relay = await startRelay({ port: 0 })

    const ws = new WebSocket(relay.wsUrl)
    await new Promise<void>((resolve) => ws.addEventListener('open', () => resolve()))

    const req: JsonRpcRequest = {
      jsonrpc: '2.0', id: 1, method: 'context.keys',
    }
    ws.send(JSON.stringify(req))

    const response = await waitForWsMessage(ws)
    expect(response.error).toBeDefined()
    expect(response.error?.message).toContain('authenticate')

    ws.close()
  })

  it('should reject WS auth without token for existing session', async () => {
    relay = await startRelay({ port: 0 })
    const sessionId = 'ws-no-token'

    // Create session via HTTP first
    await httpRpc(relay.url, 'context.keys', undefined, { 'X-Session-Id': sessionId })

    // Try WS auth without token
    const ws = new WebSocket(relay.wsUrl)
    await new Promise<void>((resolve) => ws.addEventListener('open', () => resolve()))

    const authReq: JsonRpcRequest = {
      jsonrpc: '2.0', id: 1, method: 'session.auth',
      params: { sessionId, sandboxName: 'test', role: 'agent' },
    }
    ws.send(JSON.stringify(authReq))

    const response = await waitForWsMessage(ws)
    expect(response.error).toBeDefined()

    ws.close()
  })

  it('should prioritize steer messages in recv', async () => {
    relay = await startRelay({ port: 0 })
    const sessionId = 'steer-session'

    await httpRpc(relay.url, 'session.register', { name: 'agent1', sandboxId: 'sb-1' }, { 'X-Session-Id': sessionId })

    // Send normal then steer
    await httpRpc(relay.url, 'message.send', {
      to: 'agent1', type: 'normal-task', payload: null,
    }, { 'X-Session-Id': sessionId })
    await httpRpc(relay.url, 'message.send', {
      to: 'agent1', type: 'urgent-fix', payload: null, priority: 'steer',
    }, { 'X-Session-Id': sessionId })

    // Recv should return steer first
    const recvResult = await httpRpc(relay.url, 'message.recv', { limit: 10 }, {
      'X-Session-Id': sessionId, 'X-Sandbox-Name': 'agent1',
    })
    const msgs = (recvResult.result as { messages: Array<{ type: string; priority: string }> }).messages
    expect(msgs[0]!.type).toBe('urgent-fix')
    expect(msgs[0]!.priority).toBe('steer')
    expect(msgs[1]!.type).toBe('normal-task')
  })

  it('should handle long polling', async () => {
    relay = await startRelay({ port: 0 })
    const sessionId = 'poll-session'

    await httpRpc(relay.url, 'session.register', { name: 'poller', sandboxId: 'sb-p' }, { 'X-Session-Id': sessionId })

    // Start long poll (wait 3s)
    const pollPromise = httpRpc(relay.url, 'message.recv', { limit: 10, wait: 3000 }, {
      'X-Session-Id': sessionId, 'X-Sandbox-Name': 'poller',
    })

    // Send message after 100ms
    await new Promise<void>((r) => setTimeout(r, 100))
    await httpRpc(relay.url, 'message.send', {
      to: 'poller', type: 'wake-up', payload: null,
    }, { 'X-Session-Id': sessionId })

    const result = await pollPromise
    const msgs = (result.result as { messages: unknown[] }).messages
    expect(msgs).toHaveLength(1)
  })

  it('should handle sandbox completion notification', async () => {
    relay = await startRelay({ port: 0 })
    const sessionId = 'complete-session'

    await httpRpc(relay.url, 'session.register', { name: 'worker', sandboxId: 'sb-w' }, { 'X-Session-Id': sessionId })
    const token = sessionTokens.get(sessionId)!

    // Connect orchestrator via WebSocket
    const ws = new WebSocket(relay.wsUrl)
    await new Promise<void>((resolve) => ws.addEventListener('open', () => resolve()))

    const authReq: JsonRpcRequest = {
      jsonrpc: '2.0', id: 1, method: 'session.auth',
      params: { sessionId, role: 'orchestrator', token },
    }
    ws.send(JSON.stringify(authReq))
    await waitForWsMessage(ws)

    // Set up listener BEFORE sending HTTP to avoid race condition
    const notificationPromise = waitForWsMessage(ws, 2000)

    // Agent completes via HTTP
    await httpRpc(relay.url, 'sandbox.complete', {
      status: 'success', summary: 'Built successfully',
    }, { 'X-Session-Id': sessionId, 'X-Sandbox-Name': 'worker' })

    // Orchestrator should get notification
    const notification = await notificationPromise
    expect(notification.method).toBe('sandbox.state')
    expect((notification.params as { name: string }).name).toBe('worker')
    expect((notification.params as { status: string }).status).toBe('success')

    ws.close()
  })
})

// Helper: wait for WebSocket message
function waitForWsMessage(ws: WebSocket, timeoutMs = 5000): Promise<any> {
  return new Promise((resolve, reject) => {
    const timer = setTimeout(() => reject(new Error('WS message timeout')), timeoutMs)
    const handler = (event: MessageEvent) => {
      clearTimeout(timer)
      ws.removeEventListener('message', handler)
      resolve(JSON.parse(String(event.data)))
    }
    ws.addEventListener('message', handler)
  })
}
