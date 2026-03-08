import type { SandboxProvider, Sandbox, CreateConfig } from './types.js'

// --- Message Priority ---

export type MessagePriority = 'normal' | 'steer'

// --- Session Message ---

export interface SessionMessage {
  from: string
  to: string | null
  type: string
  payload: unknown
  priority: MessagePriority
  timestamp: string
}

// --- Context Store ---

export interface ContextStore {
  get<T = unknown>(key: string): Promise<T | undefined>
  set<T = unknown>(key: string, value: T): Promise<void>
  delete(key: string): Promise<void>
  keys(): Promise<string[]>
  watch(key: string, fn: (value: unknown) => void): () => void
  watchAll(fn: (key: string, value: unknown) => void): () => void
}

// --- Sandbox Completion ---

export type CompletionStatus = 'success' | 'failure' | 'cancelled'

export interface SandboxCompletion {
  sandboxName: string
  status: CompletionStatus
  summary: string
  timestamp: string
}

// --- Session ---

export interface Session {
  /** Session 唯一标识 */
  readonly id: string

  /** 注册并创建沙箱 */
  spawn(name: string, config: CreateConfig): Promise<Sandbox>

  /** 获取已注册的沙箱 */
  getSandbox(name: string): Sandbox | undefined

  /** 列出已注册的沙箱名 */
  listSandboxes(): string[]

  /** 发送消息给指定沙箱 */
  send(to: string, type: string, payload?: unknown, options?: SendOptions): void

  /** 广播消息给所有沙箱 */
  broadcast(type: string, payload?: unknown, options?: SendOptions): void

  /** 共享上下文存储 */
  readonly context: ContextStore

  /** 监听收到的消息 */
  onMessage(fn: (msg: SessionMessage) => void): () => void

  /** 监听沙箱状态变化 */
  onSandboxState(fn: (info: { name: string; status: CompletionStatus; summary: string }) => void): () => void

  /** 等待指定沙箱完成 */
  waitFor(name: string, timeoutMs?: number): Promise<SandboxCompletion>

  /** 等待所有沙箱完成 */
  waitForAll(timeoutMs?: number): Promise<SandboxCompletion[]>

  /** 关闭 session（销毁所有沙箱、关闭 relay） */
  close(): Promise<void>
}

export interface SendOptions {
  priority?: MessagePriority
}

// --- Relay Config ---

export type RelayConfig =
  | { type: 'memory' }
  | { type: 'hosted'; url: string; token?: string }

// --- Create Session Config ---

export interface CreateSessionConfig {
  provider: SandboxProvider
  relay?: RelayConfig
  timeoutMinutes?: number
  maxSandboxes?: number
  onError?: (error: Error) => void
}

// --- JSON-RPC 2.0 ---

export interface JsonRpcRequest {
  jsonrpc: '2.0'
  id: number | string
  method: string
  params?: Record<string, unknown>
}

export interface JsonRpcResponse {
  jsonrpc: '2.0'
  id: number | string | null
  result?: unknown
  error?: JsonRpcError
}

export interface JsonRpcNotification {
  jsonrpc: '2.0'
  method: string
  params?: Record<string, unknown>
}

export interface JsonRpcError {
  code: number
  message: string
  data?: unknown
}

// --- Transport ---

export interface Transport {
  send(data: string): void
  onMessage(fn: (data: string) => void): void
  close(): void
  readonly readyState: 'connecting' | 'open' | 'closed'
}
