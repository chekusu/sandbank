import type { JsonRpcRequest, JsonRpcResponse } from '@sandbank/core'

let nextId = 1

export function createRequest(method: string, params?: Record<string, unknown>): JsonRpcRequest {
  return {
    jsonrpc: '2.0',
    id: nextId++,
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

  add(id: number | string): Promise<unknown> {
    return new Promise((resolve, reject) => {
      this.pending.set(id, { resolve, reject })
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

/** 重置 ID 计数器（测试用） */
export function resetIdCounter(): void {
  nextId = 1
}
