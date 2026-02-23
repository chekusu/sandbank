import type { WebSocket } from 'ws'

/** Session 内已注册的沙箱 */
export interface SandboxEntry {
  name: string
  sandboxId: string
  state: 'running' | 'completed'
  completion?: {
    status: string
    summary: string
    timestamp: string
  }
}

/** 已认证的客户端连接 */
export interface ConnectedClient {
  ws: WebSocket
  sessionId: string
  sandboxName: string | null
  role: 'orchestrator' | 'agent'
}

/** 消息队列中的消息 */
export interface QueuedMessage {
  from: string
  to: string | null
  type: string
  payload: unknown
  priority: 'normal' | 'steer'
  timestamp: string
}

/** Relay 会话状态 */
export interface RelaySession {
  id: string
  token: string
  sandboxes: Map<string, SandboxEntry>
  context: Map<string, unknown>
  clients: Set<ConnectedClient>
  messageQueues: Map<string, QueuedMessage[]>
  /** Long-polling 等待者：sandbox name -> resolve 函数 */
  pollWaiters: Map<string, Array<{
    resolve: (msgs: QueuedMessage[]) => void
    timer: ReturnType<typeof setTimeout>
  }>>
}
