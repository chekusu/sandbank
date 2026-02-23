import { createServer, type IncomingMessage, type ServerResponse } from 'node:http'
import { WebSocketServer, type WebSocket } from 'ws'
import type { JsonRpcRequest } from '@sandbank/core'
import type { ConnectedClient } from './types.js'
import { SessionStore } from './session-store.js'
import { handleRpc, handleAuth } from './protocol.js'

export interface RelayServerOptions {
  port?: number
  host?: string
}

export interface RelayServer {
  port: number
  url: string
  wsUrl: string
  close(): Promise<void>
}

export async function startRelay(options: RelayServerOptions = {}): Promise<RelayServer> {
  const port = options.port ?? 0
  const host = options.host ?? '127.0.0.1'

  const store = new SessionStore()
  const httpServer = createServer((req, res) => handleHttp(store, req, res))
  const wss = new WebSocketServer({ server: httpServer })

  wss.on('connection', (ws) => {
    handleWsConnection(store, ws)
  })

  return new Promise((resolve) => {
    httpServer.listen(port, host, () => {
      const addr = httpServer.address()!
      const assignedPort = typeof addr === 'string' ? port : addr.port
      const url = `http://${host}:${assignedPort}`
      const wsUrl = `ws://${host}:${assignedPort}`

      resolve({
        port: assignedPort,
        url,
        wsUrl,
        async close() {
          // 关闭所有 WebSocket 连接
          for (const ws of wss.clients) {
            ws.close(1000, 'relay shutting down')
          }
          wss.close()
          return new Promise<void>((res, rej) => {
            httpServer.close((err) => err ? rej(err) : res())
          })
        },
      })
    })
  })
}

// --- HTTP Handler ---

function handleHttp(store: SessionStore, req: IncomingMessage, res: ServerResponse): void {
  if (req.method !== 'POST' || req.url !== '/rpc') {
    res.writeHead(404, { 'Content-Type': 'application/json' })
    res.end(JSON.stringify({ error: 'Not found' }))
    return
  }

  // 读取请求头
  const sessionId = req.headers['x-session-id'] as string | undefined
  const sandboxName = req.headers['x-sandbox-name'] as string | undefined
  const authToken = req.headers['x-auth-token'] as string | undefined

  if (!sessionId) {
    res.writeHead(400, { 'Content-Type': 'application/json' })
    res.end(JSON.stringify({ jsonrpc: '2.0', id: null, error: { code: -32600, message: 'Missing X-Session-Id header' } }))
    return
  }

  // Token 验证：如果 session 已存在，必须验证 token
  const existingSession = store.getSession(sessionId)
  if (existingSession && authToken && !store.validateToken(sessionId, authToken)) {
    res.writeHead(403, { 'Content-Type': 'application/json' })
    res.end(JSON.stringify({ jsonrpc: '2.0', id: null, error: { code: -32600, message: 'Invalid token' } }))
    return
  }

  // 确保 session 存在
  store.getOrCreateSession(sessionId, authToken)

  let body = ''
  req.on('data', (chunk: Buffer) => { body += chunk.toString() })
  req.on('end', () => {
    let request: JsonRpcRequest
    try {
      request = JSON.parse(body) as JsonRpcRequest
    } catch {
      res.writeHead(400, { 'Content-Type': 'application/json' })
      res.end(JSON.stringify({ jsonrpc: '2.0', id: null, error: { code: -32700, message: 'Parse error' } }))
      return
    }

    const client = {
      sessionId,
      sandboxName: sandboxName ?? null,
      role: sandboxName ? 'agent' as const : 'orchestrator' as const,
    }

    const result = handleRpc(store, request, client)

    if (result instanceof Promise) {
      result.then((response) => {
        res.writeHead(200, { 'Content-Type': 'application/json' })
        res.end(JSON.stringify(response))
      }).catch((err) => {
        res.writeHead(500, { 'Content-Type': 'application/json' })
        res.end(JSON.stringify({ jsonrpc: '2.0', id: request.id, error: { code: -32000, message: (err as Error).message } }))
      })
    } else {
      res.writeHead(200, { 'Content-Type': 'application/json' })
      res.end(JSON.stringify(result))
    }
  })
}

// --- WebSocket Handler ---

function handleWsConnection(store: SessionStore, ws: WebSocket): void {
  const client: ConnectedClient = {
    ws,
    sessionId: '',
    sandboxName: null,
    role: 'agent',
  }

  let authenticated = false

  ws.on('message', (data) => {
    let request: JsonRpcRequest
    try {
      request = JSON.parse(data.toString()) as JsonRpcRequest
    } catch {
      ws.send(JSON.stringify({ jsonrpc: '2.0', id: null, error: { code: -32700, message: 'Parse error' } }))
      return
    }

    // 未认证时，只接受 session.auth
    if (!authenticated) {
      if (request.method !== 'session.auth') {
        ws.send(JSON.stringify({
          jsonrpc: '2.0',
          id: request.id,
          error: { code: -32600, message: 'Must authenticate first (session.auth)' },
        }))
        return
      }

      const response = handleAuth(store, request, client)
      authenticated = !response.error
      ws.send(JSON.stringify(response))
      return
    }

    // 已认证，处理 RPC
    const result = handleRpc(store, request, {
      sessionId: client.sessionId,
      sandboxName: client.sandboxName,
      role: client.role,
    })

    if (result instanceof Promise) {
      result.then((response) => {
        if (ws.readyState === ws.OPEN) ws.send(JSON.stringify(response))
      }).catch((err) => {
        if (ws.readyState === ws.OPEN) {
          ws.send(JSON.stringify({
            jsonrpc: '2.0',
            id: request.id,
            error: { code: -32000, message: (err as Error).message },
          }))
        }
      })
    } else {
      if (ws.readyState === ws.OPEN) ws.send(JSON.stringify(result))
    }
  })

  ws.on('close', () => {
    if (client.sessionId) {
      const session = store.getSession(client.sessionId)
      if (session) {
        session.clients.delete(client)
      }
    }
  })
}
