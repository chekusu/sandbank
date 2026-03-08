import type { ContextStore, Transport, JsonRpcResponse, JsonRpcNotification } from '@sandbank/core'
import { createRequest, RpcPendingMap } from './rpc.js'

/** WebSocket 模式下的 ContextStore 代理 */
export function createWsContextClient(transport: Transport, pending: RpcPendingMap): ContextStore {
  const watchers = new Map<string, Set<(value: unknown) => void>>()
  const allWatchers = new Set<(key: string, value: unknown) => void>()

  // 监听 context.changed 通知
  transport.onMessage((data) => {
    try {
      const msg = JSON.parse(data) as JsonRpcResponse | JsonRpcNotification
      if ('method' in msg && msg.method === 'context.changed' && msg.params) {
        const { key, value } = msg.params as { key: string; value: unknown }
        const fns = watchers.get(key)
        if (fns) {
          for (const fn of fns) fn(value)
        }
        for (const fn of allWatchers) fn(key, value)
      }
    } catch {
      // ignore non-JSON or irrelevant messages
    }
  })

  return {
    async get<T = unknown>(key: string): Promise<T | undefined> {
      const req = createRequest('context.get', { key })
      const promise = pending.add(req.id)
      transport.send(JSON.stringify(req))
      const result = await promise as { value: T | null }
      return result.value ?? undefined
    },

    async set<T = unknown>(key: string, value: T): Promise<void> {
      const req = createRequest('context.set', { key, value })
      const promise = pending.add(req.id)
      transport.send(JSON.stringify(req))
      await promise
    },

    async delete(key: string): Promise<void> {
      const req = createRequest('context.delete', { key })
      const promise = pending.add(req.id)
      transport.send(JSON.stringify(req))
      await promise
    },

    async keys(): Promise<string[]> {
      const req = createRequest('context.keys')
      const promise = pending.add(req.id)
      transport.send(JSON.stringify(req))
      const result = await promise as { keys: string[] }
      return result.keys
    },

    watch(key: string, fn: (value: unknown) => void): () => void {
      if (!watchers.has(key)) watchers.set(key, new Set())
      watchers.get(key)!.add(fn)
      return () => { watchers.get(key)?.delete(fn) }
    },

    watchAll(fn: (key: string, value: unknown) => void): () => void {
      allWatchers.add(fn)
      return () => { allWatchers.delete(fn) }
    },
  }
}
