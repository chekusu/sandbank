import type {
  Session,
  CreateSessionConfig,
  SessionMessage,
  ContextStore,
  CompletionStatus,
  SandboxCompletion,
  SendOptions,
  JsonRpcRequest,
  JsonRpcResponse,
  JsonRpcNotification,
} from './session-types.js'
import type { Sandbox, CreateConfig } from './types.js'

export async function createSession(config: CreateSessionConfig): Promise<Session> {
  let rpcId = 1
  function createRpcRequest(method: string, params?: Record<string, unknown>): JsonRpcRequest {
    return { jsonrpc: '2.0', id: rpcId++, method, ...(params ? { params } : {}) }
  }

  const sessionId = `session-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`
  const relayConfig = config.relay ?? { type: 'memory' as const }
  const onError = config.onError ?? (() => {})

  // 启动 relay（memory 模式：动态 import @sandbank/relay）
  let relayUrl: string
  let wsUrl: string
  let closeRelay: () => Promise<void>

  if (relayConfig.type === 'memory') {
    // Dynamic import: @sandbank/relay is an optional peer dep (no static dependency)
    const specifier = '@sandbank/relay'
    const relayMod = await import(specifier) as {
      startRelay: (opts: { port: number }) => Promise<{ url: string; wsUrl: string; close: () => Promise<void> }>
    }
    const relay = await relayMod.startRelay({ port: 0 })
    relayUrl = relay.url
    wsUrl = relay.wsUrl
    closeRelay = () => relay.close()
  } else {
    relayUrl = relayConfig.url
    wsUrl = relayConfig.url.replace(/^http/, 'ws')
    closeRelay = async () => {}
  }

  // 编排者 WebSocket 连接
  const ws = new WebSocket(wsUrl)
  await new Promise<void>((resolve, reject) => {
    ws.addEventListener('open', () => resolve())
    ws.addEventListener('error', () => reject(new Error('Failed to connect to relay')))
  })

  const pending = new Map<number | string, {
    resolve: (result: unknown) => void
    reject: (error: Error) => void
  }>()
  const messageListeners: Array<(msg: SessionMessage) => void> = []
  const stateListeners: Array<(info: { name: string; status: CompletionStatus; summary: string }) => void> = []
  const completions = new Map<string, SandboxCompletion>()
  const completionWaiters = new Map<string, Array<{
    resolve: (c: SandboxCompletion) => void
    timer?: ReturnType<typeof setTimeout>
  }>>()

  // 路由 WebSocket 消息
  ws.addEventListener('message', (evt) => {
    const data = typeof evt.data === 'string' ? evt.data : String(evt.data)
    try {
      const msg = JSON.parse(data) as JsonRpcResponse | JsonRpcNotification

      // RPC 响应
      if ('id' in msg && msg.id != null) {
        const entry = pending.get(msg.id)
        if (entry) {
          pending.delete(msg.id)
          if ((msg as JsonRpcResponse).error) {
            entry.reject(new Error(`RPC error: ${(msg as JsonRpcResponse).error!.message}`))
          } else {
            entry.resolve((msg as JsonRpcResponse).result)
          }
        }
        return
      }

      // 通知
      if ('method' in msg) {
        if (msg.method === 'message' && msg.params) {
          const sessionMsg = msg.params as unknown as SessionMessage
          for (const fn of messageListeners) fn(sessionMsg)
        } else if (msg.method === 'sandbox.state' && msg.params) {
          const { name, status, summary } = msg.params as { name: string; status: CompletionStatus; summary: string }
          const completion: SandboxCompletion = {
            sandboxName: name,
            status,
            summary,
            timestamp: new Date().toISOString(),
          }
          completions.set(name, completion)
          for (const fn of stateListeners) fn({ name, status, summary })
          // 唤醒 waitFor
          const waiters = completionWaiters.get(name)
          if (waiters) {
            for (const w of waiters) {
              if (w.timer) clearTimeout(w.timer)
              w.resolve(completion)
            }
            completionWaiters.delete(name)
          }
        } else if (msg.method === 'context.changed') {
          // context 变更 → 通知 context watchers
          const { key, value } = msg.params as { key: string; value: unknown }
          for (const fn of contextKeyWatchers.get(key) ?? []) fn(value)
          for (const fn of contextAllWatchers) fn(key, value)
        }
      }
    } catch {
      // ignore
    }
  })

  async function rpcCall(method: string, params?: Record<string, unknown>): Promise<unknown> {
    const req = createRpcRequest(method, params)
    ws.send(JSON.stringify(req))
    return new Promise((resolve, reject) => {
      pending.set(req.id, { resolve, reject })
    })
  }

  // 生成 session token
  const token = (relayConfig.type === 'hosted' && relayConfig.token)
    ? relayConfig.token
    : crypto.randomUUID()

  // 认证
  const authResult = await rpcCall('session.auth', {
    sessionId,
    token,
    role: 'orchestrator',
  }) as { token?: string }
  const sessionToken = authResult.token ?? token

  const sandboxes = new Map<string, Sandbox>()
  const contextKeyWatchers = new Map<string, Set<(value: unknown) => void>>()
  const contextAllWatchers = new Set<(key: string, value: unknown) => void>()

  // Context 代理
  const context: ContextStore = {
    async get<T = unknown>(key: string): Promise<T | undefined> {
      const result = await rpcCall('context.get', { key }) as { value: T | null }
      return result.value ?? undefined
    },
    async set<T = unknown>(key: string, value: T): Promise<void> {
      await rpcCall('context.set', { key, value })
    },
    async delete(key: string): Promise<void> {
      await rpcCall('context.delete', { key })
    },
    async keys(): Promise<string[]> {
      const result = await rpcCall('context.keys') as { keys: string[] }
      return result.keys
    },
    watch(key: string, fn: (value: unknown) => void): () => void {
      if (!contextKeyWatchers.has(key)) contextKeyWatchers.set(key, new Set())
      contextKeyWatchers.get(key)!.add(fn)
      return () => { contextKeyWatchers.get(key)?.delete(fn) }
    },
    watchAll(fn: (key: string, value: unknown) => void): () => void {
      contextAllWatchers.add(fn)
      return () => { contextAllWatchers.delete(fn) }
    },
  }

  const session: Session = {
    id: sessionId,

    async spawn(name: string, sandboxConfig: CreateConfig): Promise<Sandbox> {
      const maxSandboxes = config.maxSandboxes ?? 10
      if (sandboxes.size >= maxSandboxes) {
        throw new Error(`Max sandboxes (${maxSandboxes}) reached`)
      }

      // 注入 relay 环境变量
      const env = {
        ...sandboxConfig.env,
        SANDBANK_RELAY_URL: relayUrl,
        SANDBANK_WS_URL: wsUrl,
        SANDBANK_SESSION_ID: sessionId,
        SANDBANK_SANDBOX_NAME: name,
        SANDBANK_AUTH_TOKEN: sessionToken,
      }

      const sandbox = await config.provider.create({ ...sandboxConfig, env })

      // 在 relay 注册沙箱
      await rpcCall('session.register', { name, sandboxId: sandbox.id })

      sandboxes.set(name, sandbox)
      return sandbox
    },

    getSandbox(name: string): Sandbox | undefined {
      return sandboxes.get(name)
    },

    listSandboxes(): string[] {
      return [...sandboxes.keys()]
    },

    send(to: string, type: string, payload?: unknown, options?: SendOptions): void {
      rpcCall('message.send', {
        to,
        type,
        payload: payload ?? null,
        priority: options?.priority ?? 'normal',
      }).catch(onError)
    },

    broadcast(type: string, payload?: unknown, options?: SendOptions): void {
      rpcCall('message.broadcast', {
        type,
        payload: payload ?? null,
        priority: options?.priority ?? 'normal',
      }).catch(onError)
    },

    context,

    onMessage(fn: (msg: SessionMessage) => void): () => void {
      messageListeners.push(fn)
      return () => {
        const idx = messageListeners.indexOf(fn)
        if (idx >= 0) messageListeners.splice(idx, 1)
      }
    },

    onSandboxState(fn: (info: { name: string; status: CompletionStatus; summary: string }) => void): () => void {
      stateListeners.push(fn)
      return () => {
        const idx = stateListeners.indexOf(fn)
        if (idx >= 0) stateListeners.splice(idx, 1)
      }
    },

    waitFor(name: string, timeoutMs?: number): Promise<SandboxCompletion> {
      // 已经完成
      const existing = completions.get(name)
      if (existing) return Promise.resolve(existing)

      return new Promise((resolve, reject) => {
        const waiter: { resolve: (c: SandboxCompletion) => void; timer?: ReturnType<typeof setTimeout> } = { resolve }
        if (timeoutMs) {
          waiter.timer = setTimeout(() => {
            const waiters = completionWaiters.get(name)
            if (waiters) {
              const idx = waiters.indexOf(waiter)
              if (idx >= 0) waiters.splice(idx, 1)
            }
            reject(new Error(`Timeout waiting for sandbox "${name}" (${timeoutMs}ms)`))
          }, timeoutMs)
        }
        if (!completionWaiters.has(name)) completionWaiters.set(name, [])
        completionWaiters.get(name)!.push(waiter)
      })
    },

    async waitForAll(timeoutMs?: number): Promise<SandboxCompletion[]> {
      const names = [...sandboxes.keys()]
      const promises = names.map((name) => session.waitFor(name, timeoutMs))
      return Promise.all(promises)
    },

    async close(): Promise<void> {
      // 先清理 pending，避免 unhandled rejection
      for (const [, entry] of pending) {
        entry.reject(new Error('Session closed'))
      }
      pending.clear()

      // 清理 waitFor timers
      for (const [, waiters] of completionWaiters) {
        for (const w of waiters) {
          if (w.timer) clearTimeout(w.timer)
        }
      }
      completionWaiters.clear()

      // 断开 WebSocket
      ws.close()

      // 并行销毁所有沙箱
      await Promise.allSettled(
        [...sandboxes.values()].map(sandbox => config.provider.destroy(sandbox.id))
      )
      sandboxes.clear()

      // 关闭 relay
      await closeRelay()
    },
  }

  return session
}
