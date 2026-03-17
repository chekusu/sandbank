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
  /** Orchestrator 的 durable message queue（断连时保留消息） */
  orchestratorQueue: QueuedMessage[]
  createdAt: number
  lastActivityAt: number
}

/** SessionStore 配置选项 */
export interface SessionStoreOptions {
  /** Session 空闲超时（毫秒），默认 30 分钟 */
  sessionTtlMs?: number
  /** 最大 session 数，默认 1000 */
  maxSessions?: number
  /** 每个沙箱的最大消息队列长度，默认 10000 */
  maxQueueSize?: number
  /** 每个 session 最大沙箱数，默认 100 */
  maxSandboxesPerSession?: number
  /** 清扫间隔（毫秒），默认 60 秒 */
  sweepIntervalMs?: number
}
