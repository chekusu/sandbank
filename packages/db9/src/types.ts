/** db9 API 响应：数据库 */
export interface Db9Database {
  id: string
  name: string
  state: string
  host: string
  port: number
  username: string
  password: string
  database: string
  connection_string: string
  created_at: string
}

export type Db9SqlColumn = string | {
  name: string
  type?: string
}

/** db9 API 响应：SQL 执行结果 */
export interface Db9SqlResult {
  columns: Db9SqlColumn[]
  rows: unknown[][]
  row_count: number
  command?: string
  error?: string
}

export interface Db9FunctionInvokeOptions {
  fs9Scope?: string
  timeoutMs?: number
  env?: Record<string, string>
}

export interface Db9FunctionInvokeResult {
  ok?: boolean
  status?: string
  output?: unknown
  result?: unknown
  logs?: string[]
}

export interface Db9ScopedTokenRequest {
  name?: string
  expiresInSeconds?: number
  fs9Scope?: string
  sql?: 'none' | 'read' | 'write' | 'all'
  functions?: string[]
}

export interface Db9ScopedToken {
  token: string
  expiresAt?: string
  scope?: Record<string, unknown>
}

/** db9 API 响应：错误 */
export interface Db9ApiError {
  error: string
  message?: string
}
