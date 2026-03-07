import type { JsonRpcResponse, JsonRpcNotification } from '@sandbank/core'
import type { AgentSession, AgentMessage, ConnectOptions } from './types.js'
import { createWebSocketTransport } from './transport.js'
import { createRequest, RpcPendingMap } from './rpc.js'
import { createWsContextClient } from './context-client.js'

export async function connect(options: ConnectOptions = {}): Promise<AgentSession> {
  const wsUrl = options.wsUrl ?? process.env['SANDBANK_WS_URL']
  const sessionId = options.sessionId ?? process.env['SANDBANK_SESSION_ID']
  const sandboxName = options.sandboxName ?? process.env['SANDBANK_SANDBOX_NAME']
  const token = options.token ?? process.env['SANDBANK_AUTH_TOKEN']

  if (!wsUrl) throw new Error('Missing wsUrl (set SANDBANK_WS_URL)')
  if (!sessionId) throw new Error('Missing sessionId (set SANDBANK_SESSION_ID)')
  if (!sandboxName) throw new Error('Missing sandboxName (set SANDBANK_SANDBOX_NAME)')

  const transport = await createWebSocketTransport(wsUrl)
  const pending = new RpcPendingMap()
  const messageListeners: Array<(msg: AgentMessage) => void> = []

  // 路由所有 WebSocket 消息
  transport.onMessage((data) => {
    try {
      const msg = JSON.parse(data) as JsonRpcResponse | JsonRpcNotification
      // RPC 响应
      if ('id' in msg && msg.id != null) {
        pending.resolve(msg as JsonRpcResponse)
        return
      }
      // 通知：消息推送
      if ('method' in msg && msg.method === 'message' && msg.params) {
        const agentMsg = msg.params as unknown as AgentMessage
        for (const fn of messageListeners) {
          fn(agentMsg)
        }
      }
    } catch {
      // ignore
    }
  })

  // 认证
  const authReq = createRequest('session.auth', {
    sessionId,
    sandboxName,
    token: token ?? undefined,
    role: 'agent',
  })
  const authPromise = pending.add(authReq.id)
  transport.send(JSON.stringify(authReq))
  const authResult = await authPromise as { ok: boolean }
  if (!authResult.ok) throw new Error('Authentication failed')

  const context = createWsContextClient(transport, pending)

  const session: AgentSession = {
    async send(to, type, payload, opts) {
      const req = createRequest('message.send', {
        to,
        type,
        payload: payload ?? null,
        priority: opts?.priority ?? 'normal',
      })
      const promise = pending.add(req.id)
      transport.send(JSON.stringify(req))
      await promise
    },

    async broadcast(type, payload, opts) {
      const req = createRequest('message.broadcast', {
        type,
        payload: payload ?? null,
        priority: opts?.priority ?? 'normal',
      })
      const promise = pending.add(req.id)
      transport.send(JSON.stringify(req))
      await promise
    },

    async recv(opts) {
      const req = createRequest('message.recv', {
        limit: opts?.limit ?? 100,
        wait: opts?.wait ?? 0,
      })
      const promise = pending.add(req.id)
      transport.send(JSON.stringify(req))
      const result = await promise as { messages: AgentMessage[] }
      return result.messages
    },

    on(event, fn) {
      if (event === 'message') {
        messageListeners.push(fn)
        return () => {
          const idx = messageListeners.indexOf(fn)
          if (idx >= 0) messageListeners.splice(idx, 1)
        }
      }
      return () => {}
    },

    context,

    async complete(result) {
      const req = createRequest('sandbox.complete', {
        status: result.status,
        summary: result.summary,
      })
      const promise = pending.add(req.id)
      transport.send(JSON.stringify(req))
      await promise
    },

    close() {
      pending.rejectAll('Connection closed')
      transport.close()
    },
  }

  return session
}
