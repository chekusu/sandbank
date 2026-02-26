import type { MessagePriority, ContextStore } from '@sandbank/core'

export interface AgentMessage {
  from: string
  to: string | null
  type: string
  payload: unknown
  priority: MessagePriority
  timestamp: string
}

export interface AgentSession {
  /** 发送消息给指定沙箱 */
  send(to: string, type: string, payload?: unknown, options?: { priority?: MessagePriority }): Promise<void>

  /** 广播消息给所有沙箱 */
  broadcast(type: string, payload?: unknown, options?: { priority?: MessagePriority }): Promise<void>

  /** 拉取待处理消息 */
  recv(options?: { limit?: number; wait?: number }): Promise<AgentMessage[]>

  /** 监听实时消息（WebSocket 模式） */
  on(event: 'message', fn: (msg: AgentMessage) => void): () => void

  /** 共享上下文 */
  readonly context: ContextStore

  /** 标记当前沙箱完成 */
  complete(result: { status: string; summary: string }): Promise<void>

  /** 关闭连接 */
  close(): void
}

export interface ConnectOptions {
  /** Relay WebSocket URL（默认读 SANDBANK_WS_URL） */
  wsUrl?: string
  /** Session ID（默认读 SANDBANK_SESSION_ID） */
  sessionId?: string
  /** 沙箱名（默认读 SANDBANK_SANDBOX_NAME） */
  sandboxName?: string
  /** 认证 token（默认读 SANDBANK_AUTH_TOKEN） */
  token?: string
}
