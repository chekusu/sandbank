import type { JsonRpcRequest, JsonRpcResponse } from '@sandbank/core'

export function createRequest(method: string, params?: Record<string, unknown>): JsonRpcRequest {
  return {
    jsonrpc: '2.0',
    id: crypto.randomUUID(),
    method,
    ...(params ? { params } : {}),
  }
}

/** 管理 RPC 请求的 pending promise */
export class RpcPendingMap {
  private pending = new Map<number | string, {
    resolve: (result: unknown) => void
    reject: (error: Error) => void
  }>()

  add(id: number | string, timeoutMs = 30_000): Promise<unknown> {
    return new Promise((resolve, reject) => {
      const timer = setTimeout(() => {
        this.pending.delete(id)
        reject(new Error(`RPC timeout (${timeoutMs}ms)`))
      }, timeoutMs)
      this.pending.set(id, {
        resolve: (result) => { clearTimeout(timer); resolve(result) },
        reject: (err) => { clearTimeout(timer); reject(err) },
      })
    })
  }

  resolve(response: JsonRpcResponse): boolean {
    if (response.id == null) return false
    const entry = this.pending.get(response.id)
    if (!entry) return false
    this.pending.delete(response.id)

    if (response.error) {
      entry.reject(new Error(`RPC error ${response.error.code}: ${response.error.message}`))
    } else {
      entry.resolve(response.result)
    }
    return true
  }

  rejectAll(reason: string): void {
    for (const [, entry] of this.pending) {
      entry.reject(new Error(reason))
    }
    this.pending.clear()
  }
}

