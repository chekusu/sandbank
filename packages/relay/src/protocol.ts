import type { JsonRpcRequest, JsonRpcResponse } from '@sandbank/core'
import type { ConnectedClient, QueuedMessage } from './types.js'
import type { SessionStore } from './session-store.js'

/** 处理 JSON-RPC 请求，返回响应 */
export function handleRpc(
  store: SessionStore,
  request: JsonRpcRequest,
  client: { sessionId: string; sandboxName: string | null; role: 'orchestrator' | 'agent' },
): JsonRpcResponse | Promise<JsonRpcResponse> {
  const { method, params, id } = request
  const p = (params ?? {}) as Record<string, unknown>

  switch (method) {
    case 'session.register':
      return handleRegister(store, id, client.sessionId, p)

    case 'message.send':
      return handleSend(store, id, client.sessionId, client.sandboxName, p)

    case 'message.broadcast':
      return handleBroadcast(store, id, client.sessionId, client.sandboxName, p)

    case 'message.recv':
      return handleRecv(store, id, client.sessionId, client.sandboxName, p)

    case 'context.get':
      return handleContextGet(store, id, client.sessionId, p)

    case 'context.set':
      return handleContextSet(store, id, client.sessionId, client.sandboxName ?? 'orchestrator', p)

    case 'context.delete':
      return handleContextDelete(store, id, client.sessionId, client.sandboxName ?? 'orchestrator', p)

    case 'context.keys':
      return handleContextKeys(store, id, client.sessionId)

    case 'sandbox.complete':
      return handleComplete(store, id, client.sessionId, client.sandboxName, p)

    default:
      return rpcError(id, -32601, `Method not found: ${method}`)
  }
}

/** WebSocket 认证：首条消息 */
export function handleAuth(
  store: SessionStore,
  request: JsonRpcRequest,
  wsClient: ConnectedClient,
): JsonRpcResponse {
  const { id, params } = request
  const p = (params ?? {}) as Record<string, unknown>

  const sessionId = p['sessionId'] as string | undefined
  const sandboxName = p['sandboxName'] as string | undefined
  const token = p['token'] as string | undefined
  const role = p['role'] as string | undefined

  if (!sessionId) {
    return rpcError(id, -32602, 'Missing sessionId')
  }

  const existing = store.getSession(sessionId)
  let session: ReturnType<typeof store.getSession>

  if (existing) {
    // Session 已存在 → 必须提供有效 token
    if (!token) {
      return rpcError(id, -32600, 'Missing token for existing session')
    }
    if (!store.validateToken(sessionId, token)) {
      return rpcError(id, -32600, 'Invalid token')
    }
    session = existing
  } else {
    // Session 不存在 → 创建（如果提供了 token 就用它，否则自动生成）
    session = store.getOrCreateSession(sessionId, token)
  }

  wsClient.sessionId = sessionId
  wsClient.sandboxName = sandboxName ?? null
  wsClient.role = role === 'orchestrator' ? 'orchestrator' : 'agent'

  // 加入 session
  session!.clients.add(wsClient)

  return rpcResult(id, { ok: true, sessionId, sandboxName: sandboxName ?? null, token: session!.token })
}

// --- Handlers ---

function handleRegister(
  store: SessionStore,
  id: number | string,
  sessionId: string,
  params: Record<string, unknown>,
): JsonRpcResponse {
  const name = params['name'] as string
  const sandboxId = params['sandboxId'] as string

  if (!name || !sandboxId) {
    return rpcError(id, -32602, 'Missing name or sandboxId')
  }

  try {
    store.registerSandbox(sessionId, name, sandboxId)
    return rpcResult(id, { ok: true })
  } catch (e) {
    return rpcError(id, -32000, (e as Error).message)
  }
}

function handleSend(
  store: SessionStore,
  id: number | string,
  sessionId: string,
  fromName: string | null,
  params: Record<string, unknown>,
): JsonRpcResponse {
  const session = store.getSession(sessionId)
  if (!session) return rpcError(id, -32000, 'Session not found')

  const to = params['to'] as string
  const type = params['type'] as string
  const payload = params['payload']
  const priority = (params['priority'] as string) === 'steer' ? 'steer' as const : 'normal' as const

  if (!to || !type) {
    return rpcError(id, -32602, 'Missing to or type')
  }

  const msg: QueuedMessage = {
    from: fromName ?? 'orchestrator',
    to,
    type,
    payload: payload ?? null,
    priority,
    timestamp: new Date().toISOString(),
  }

  store.enqueueMessage(session, to, msg)
  return rpcResult(id, { ok: true })
}

function handleBroadcast(
  store: SessionStore,
  id: number | string,
  sessionId: string,
  fromName: string | null,
  params: Record<string, unknown>,
): JsonRpcResponse {
  const session = store.getSession(sessionId)
  if (!session) return rpcError(id, -32000, 'Session not found')

  const type = params['type'] as string
  const payload = params['payload']
  const priority = (params['priority'] as string) === 'steer' ? 'steer' as const : 'normal' as const

  if (!type) {
    return rpcError(id, -32602, 'Missing type')
  }

  const msg: QueuedMessage = {
    from: fromName ?? 'orchestrator',
    to: null,
    type,
    payload: payload ?? null,
    priority,
    timestamp: new Date().toISOString(),
  }

  store.broadcastMessage(session, msg, fromName ?? '')
  return rpcResult(id, { ok: true })
}

function handleRecv(
  store: SessionStore,
  id: number | string,
  sessionId: string,
  sandboxName: string | null,
  params: Record<string, unknown>,
): JsonRpcResponse | Promise<JsonRpcResponse> {
  const session = store.getSession(sessionId)
  if (!session) return rpcError(id, -32000, 'Session not found')
  if (!sandboxName) return rpcError(id, -32602, 'No sandbox name — cannot recv')

  const limit = (params['limit'] as number) ?? 100
  const wait = (params['wait'] as number) ?? 0

  if (wait <= 0) {
    const msgs = store.drainQueue(session, sandboxName, limit)
    return rpcResult(id, { messages: msgs })
  }

  // Long polling
  return store.waitForMessages(session, sandboxName, wait, limit).then((msgs) => {
    return rpcResult(id, { messages: msgs })
  })
}

function handleContextGet(
  store: SessionStore,
  id: number | string,
  sessionId: string,
  params: Record<string, unknown>,
): JsonRpcResponse {
  const ctx = store.getContext(sessionId)
  if (!ctx) return rpcError(id, -32000, 'Session not found')

  const key = params['key'] as string
  if (!key) return rpcError(id, -32602, 'Missing key')

  const value = ctx.get(key)
  return rpcResult(id, { value: value ?? null })
}

function handleContextSet(
  store: SessionStore,
  id: number | string,
  sessionId: string,
  changedBy: string,
  params: Record<string, unknown>,
): JsonRpcResponse {
  const session = store.getSession(sessionId)
  const ctx = store.getContext(sessionId)
  if (!session || !ctx) return rpcError(id, -32000, 'Session not found')

  const key = params['key'] as string
  const value = params['value']
  if (!key) return rpcError(id, -32602, 'Missing key')

  ctx.set(key, value)
  ctx.notifyClients(session.clients, key, value, changedBy)
  return rpcResult(id, { ok: true })
}

function handleContextDelete(
  store: SessionStore,
  id: number | string,
  sessionId: string,
  changedBy: string,
  params: Record<string, unknown>,
): JsonRpcResponse {
  const session = store.getSession(sessionId)
  const ctx = store.getContext(sessionId)
  if (!ctx || !session) return rpcError(id, -32000, 'Session not found')

  const key = params['key'] as string
  if (!key) return rpcError(id, -32602, 'Missing key')

  ctx.delete(key)
  ctx.notifyClients(session.clients, key, undefined, changedBy)
  return rpcResult(id, { ok: true })
}

function handleContextKeys(
  store: SessionStore,
  id: number | string,
  sessionId: string,
): JsonRpcResponse {
  const ctx = store.getContext(sessionId)
  if (!ctx) return rpcError(id, -32000, 'Session not found')

  return rpcResult(id, { keys: ctx.keys() })
}

function handleComplete(
  store: SessionStore,
  id: number | string,
  sessionId: string,
  sandboxName: string | null,
  params: Record<string, unknown>,
): JsonRpcResponse {
  const session = store.getSession(sessionId)
  if (!session) return rpcError(id, -32000, 'Session not found')
  if (!sandboxName) return rpcError(id, -32602, 'No sandbox name — cannot complete')

  const status = (params['status'] as string) ?? 'success'
  const summary = (params['summary'] as string) ?? ''

  store.completeSandbox(session, sandboxName, status, summary)
  return rpcResult(id, { ok: true })
}

// --- Helpers ---

function rpcResult(id: number | string, result: unknown): JsonRpcResponse {
  return { jsonrpc: '2.0', id, result }
}

function rpcError(id: number | string, code: number, message: string): JsonRpcResponse {
  return { jsonrpc: '2.0', id, error: { code, message } }
}
