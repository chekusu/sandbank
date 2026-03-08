import { randomUUID } from 'node:crypto'
import { ContextStoreServer } from './context-store.js'
import type { RelaySession, SandboxEntry, QueuedMessage, ConnectedClient, SessionStoreOptions } from './types.js'

const DEFAULT_SESSION_TTL_MS = 30 * 60 * 1000  // 30 minutes
const DEFAULT_MAX_SESSIONS = 1000
const DEFAULT_MAX_QUEUE_SIZE = 10_000
const DEFAULT_SWEEP_INTERVAL_MS = 60 * 1000    // 60 seconds

export class SessionStore {
  private sessions = new Map<string, RelaySession>()
  private contexts = new Map<string, ContextStoreServer>()
  private sweepTimer: ReturnType<typeof setInterval> | null = null

  readonly sessionTtlMs: number
  readonly maxSessions: number
  readonly maxQueueSize: number

  constructor(options: SessionStoreOptions = {}) {
    this.sessionTtlMs = options.sessionTtlMs ?? DEFAULT_SESSION_TTL_MS
    this.maxSessions = options.maxSessions ?? DEFAULT_MAX_SESSIONS
    this.maxQueueSize = options.maxQueueSize ?? DEFAULT_MAX_QUEUE_SIZE

    const sweepInterval = options.sweepIntervalMs ?? DEFAULT_SWEEP_INTERVAL_MS
    if (this.sessionTtlMs > 0) {
      this.sweepTimer = setInterval(() => this.sweep(), sweepInterval)
      this.sweepTimer.unref()
    }
  }

  /** 停止清扫定时器（用于优雅关闭） */
  dispose(): void {
    if (this.sweepTimer) {
      clearInterval(this.sweepTimer)
      this.sweepTimer = null
    }
  }

  /** 获取当前 session 数量 */
  get size(): number {
    return this.sessions.size
  }

  createSession(id: string, token?: string): RelaySession {
    // 容量检查
    if (this.sessions.size >= this.maxSessions) {
      // 先尝试清扫过期 session
      this.sweep()
      if (this.sessions.size >= this.maxSessions) {
        throw new Error(`Max sessions reached (${this.maxSessions})`)
      }
    }

    const now = Date.now()
    const session: RelaySession = {
      id,
      token: token ?? randomUUID(),
      sandboxes: new Map(),
      context: new Map(),
      clients: new Set(),
      messageQueues: new Map(),
      pollWaiters: new Map(),
      createdAt: now,
      lastActivityAt: now,
    }
    this.sessions.set(id, session)
    this.contexts.set(id, new ContextStoreServer())
    return session
  }

  getSession(id: string): RelaySession | undefined {
    return this.sessions.get(id)
  }

  getOrCreateSession(id: string, token?: string): RelaySession {
    return this.getSession(id) ?? this.createSession(id, token)
  }

  /** 更新 session 的最后活跃时间 */
  touch(session: RelaySession): void {
    session.lastActivityAt = Date.now()
  }

  validateToken(sessionId: string, token: string): boolean {
    const session = this.getSession(sessionId)
    if (!session) return false
    return session.token === token
  }

  getContext(sessionId: string): ContextStoreServer | undefined {
    return this.contexts.get(sessionId)
  }

  deleteSession(id: string): void {
    const session = this.sessions.get(id)
    if (session) {
      // 清理 poll waiters
      for (const waiters of session.pollWaiters.values()) {
        for (const w of waiters) {
          clearTimeout(w.timer)
          w.resolve([])
        }
      }
      // 关闭所有客户端连接
      for (const client of session.clients) {
        if (client.ws.readyState === client.ws.OPEN) {
          client.ws.close(1000, 'session closed')
        }
      }
    }
    this.sessions.delete(id)
    this.contexts.delete(id)
  }

  /** 清扫过期且无活跃连接的 session */
  sweep(): number {
    if (this.sessionTtlMs <= 0) return 0

    const now = Date.now()
    let evicted = 0

    const toEvict: string[] = []
    for (const [id, session] of this.sessions) {
      const idle = now - session.lastActivityAt
      if (idle > this.sessionTtlMs && session.clients.size === 0) {
        toEvict.push(id)
      }
    }
    for (const id of toEvict) {
      this.deleteSession(id)
      evicted++
    }

    return evicted
  }

  /** 注册沙箱名 */
  registerSandbox(sessionId: string, name: string, sandboxId: string): void {
    const session = this.getSession(sessionId)
    if (!session) throw new Error(`Session not found: ${sessionId}`)

    this.touch(session)
    session.sandboxes.set(name, { name, sandboxId, state: 'running' })
    session.messageQueues.set(name, [])
  }

  /** 发送消息到指定沙箱的队列 */
  enqueueMessage(session: RelaySession, to: string, msg: QueuedMessage): void {
    const queue = session.messageQueues.get(to)
    if (!queue) {
      // 目标不是已注册沙箱 — 可能是发给 orchestrator
      this.pushToOrchestrator(session, msg)
      return
    }

    // 队列大小限制：丢弃最旧的 normal 消息
    if (queue.length >= this.maxQueueSize) {
      const normalIdx = queue.findIndex(m => m.priority === 'normal')
      if (normalIdx >= 0) {
        queue.splice(normalIdx, 1)
      } else {
        // 全是 steer 消息，丢弃最旧的
        queue.shift()
      }
    }

    queue.push(msg)
    this.touch(session)

    // 检查是否有 long-polling 等待者（优先于 WebSocket 推送，避免双重投递）
    const waiters = session.pollWaiters.get(to)
    if (waiters && waiters.length > 0) {
      const waiter = waiters.shift()!
      clearTimeout(waiter.timer)
      const msgs = this.drainQueue(session, to)
      waiter.resolve(msgs)
      return
    }

    // WebSocket 实时推送
    this.pushToWebSocketClient(session, to, msg)
  }

  /** 广播消息到所有沙箱 */
  broadcastMessage(session: RelaySession, msg: QueuedMessage, excludeSender: string): void {
    for (const [name] of session.sandboxes) {
      if (name !== excludeSender) {
        this.enqueueMessage(session, name, msg)
      }
    }
    // 也推送给编排者（除非发送者就是编排者）
    if (excludeSender !== '') {
      this.pushToOrchestrator(session, msg)
    }
  }

  /** 消耗队列：steer 优先排序 */
  drainQueue(session: RelaySession, sandboxName: string, limit = 100): QueuedMessage[] {
    const queue = session.messageQueues.get(sandboxName)
    if (!queue || queue.length === 0) return []

    // steer 优先，保持插入顺序（stable partition）
    const steer: QueuedMessage[] = []
    const normal: QueuedMessage[] = []
    for (const m of queue) {
      if (m.priority === 'steer') steer.push(m)
      else normal.push(m)
    }
    const sorted = [...steer, ...normal]
    queue.length = 0
    queue.push(...sorted)

    this.touch(session)
    const msgs = queue.splice(0, limit)
    return msgs
  }

  /** Long polling：等待消息到达 */
  waitForMessages(
    session: RelaySession,
    sandboxName: string,
    waitMs: number,
    limit: number,
  ): Promise<QueuedMessage[]> {
    // 先检查队列是否已有消息
    const existing = this.drainQueue(session, sandboxName, limit)
    if (existing.length > 0) return Promise.resolve(existing)

    // 没有消息，挂起等待
    return new Promise((resolve) => {
      const timer = setTimeout(() => {
        // 超时，返回空数组
        const waiters = session.pollWaiters.get(sandboxName)
        if (waiters) {
          const idx = waiters.findIndex((w) => w.resolve === resolve)
          if (idx >= 0) waiters.splice(idx, 1)
        }
        resolve([])
      }, waitMs)

      if (!session.pollWaiters.has(sandboxName)) {
        session.pollWaiters.set(sandboxName, [])
      }
      session.pollWaiters.get(sandboxName)!.push({ resolve, timer })
    })
  }

  /** 标记沙箱完成 */
  completeSandbox(
    session: RelaySession,
    sandboxName: string,
    status: string,
    summary: string,
  ): void {
    const entry = session.sandboxes.get(sandboxName)
    if (!entry) return

    entry.state = 'completed'
    entry.completion = {
      status,
      summary,
      timestamp: new Date().toISOString(),
    }

    this.touch(session)

    // 通知编排者
    const notification = JSON.stringify({
      jsonrpc: '2.0',
      method: 'sandbox.state',
      params: {
        name: sandboxName,
        state: 'completed',
        status,
        summary,
      },
    })
    for (const client of session.clients) {
      if (client.role === 'orchestrator' && client.ws.readyState === client.ws.OPEN) {
        client.ws.send(notification)
      }
    }
  }

  private pushToWebSocketClient(session: RelaySession, targetName: string, msg: QueuedMessage): void {
    const notification = JSON.stringify({
      jsonrpc: '2.0',
      method: 'message',
      params: msg,
    })
    for (const client of session.clients) {
      if (client.sandboxName === targetName && client.ws.readyState === client.ws.OPEN) {
        client.ws.send(notification)
      }
    }
  }

  private pushToOrchestrator(session: RelaySession, msg: QueuedMessage): void {
    const notification = JSON.stringify({
      jsonrpc: '2.0',
      method: 'message',
      params: msg,
    })
    for (const client of session.clients) {
      if (client.role === 'orchestrator' && client.ws.readyState === client.ws.OPEN) {
        client.ws.send(notification)
      }
    }
  }
}
