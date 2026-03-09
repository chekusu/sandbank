import type { Db9Database, Db9SqlResult } from './types.js'

export interface Db9ClientConfig {
  /** db9 API Token */
  token: string
  /** API Base URL，默认 https://db9.ai/api */
  baseUrl?: string
}

export class Db9Client {
  private readonly baseUrl: string
  private readonly token: string

  constructor(config: Db9ClientConfig) {
    this.baseUrl = (config.baseUrl ?? 'https://db9.ai/api').replace(/\/$/, '')
    this.token = config.token
  }

  /** 创建数据库 */
  async createDatabase(name: string): Promise<Db9Database> {
    return this.request<Db9Database>('POST', '/customer/databases', { name })
  }

  /** 获取数据库详情 */
  async getDatabase(id: string): Promise<Db9Database> {
    return this.request<Db9Database>('GET', `/customer/databases/${encodeURIComponent(id)}`)
  }

  /** 列出所有数据库 */
  async listDatabases(): Promise<Db9Database[]> {
    return this.request<Db9Database[]>('GET', '/customer/databases')
  }

  /** 删除数据库（幂等） */
  async deleteDatabase(id: string): Promise<void> {
    await this.request<void>('DELETE', `/customer/databases/${encodeURIComponent(id)}`)
  }

  /** 执行 SQL */
  async executeSQL(dbId: string, query: string): Promise<Db9SqlResult> {
    return this.request<Db9SqlResult>(
      'POST',
      `/customer/databases/${encodeURIComponent(dbId)}/sql`,
      { query },
    )
  }

  /** 创建分支 */
  async createBranch(dbId: string, name: string): Promise<Db9Database> {
    return this.request<Db9Database>(
      'POST',
      `/customer/databases/${encodeURIComponent(dbId)}/branch`,
      { name },
    )
  }

  /** 删除分支（删除分支数据库） */
  async deleteBranch(branchDbId: string): Promise<void> {
    await this.deleteDatabase(branchDbId)
  }

  private async request<T>(method: string, path: string, body?: unknown): Promise<T> {
    const url = `${this.baseUrl}${path}`
    const headers: Record<string, string> = {
      'Authorization': `Bearer ${this.token}`,
      'Accept': 'application/json',
    }
    const init: RequestInit = { method, headers }

    if (body !== undefined) {
      headers['Content-Type'] = 'application/json'
      init.body = JSON.stringify(body)
    }

    const resp = await fetch(url, init)

    if (!resp.ok) {
      let message = `db9 API error: ${resp.status} ${resp.statusText}`
      try {
        const err = await resp.json() as { error?: string; message?: string }
        if (err.error || err.message) {
          message = `db9 API error: ${err.error ?? err.message}`
        }
      } catch {
        // ignore parse errors
      }
      throw new Error(message)
    }

    // DELETE 等可能无 body
    const text = await resp.text()
    if (!text) return undefined as T
    return JSON.parse(text) as T
  }
}
