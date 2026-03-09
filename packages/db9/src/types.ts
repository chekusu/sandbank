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

/** db9 API 响应：SQL 执行结果 */
export interface Db9SqlResult {
  columns: string[]
  rows: unknown[][]
  row_count: number
}

/** db9 API 响应：错误 */
export interface Db9ApiError {
  error: string
  message?: string
}
