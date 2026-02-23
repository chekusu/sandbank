import type { ConnectedClient } from './types.js'

export class ContextStoreServer {
  private data = new Map<string, unknown>()
  private watchers = new Set<(key: string, value: unknown) => void>()

  get<T = unknown>(key: string): T | undefined {
    return this.data.get(key) as T | undefined
  }

  set(key: string, value: unknown): void {
    this.data.set(key, value)
    for (const fn of this.watchers) {
      fn(key, value)
    }
  }

  delete(key: string): boolean {
    const existed = this.data.delete(key)
    if (existed) {
      for (const fn of this.watchers) {
        fn(key, undefined)
      }
    }
    return existed
  }

  keys(): string[] {
    return [...this.data.keys()]
  }

  watch(fn: (key: string, value: unknown) => void): () => void {
    this.watchers.add(fn)
    return () => { this.watchers.delete(fn) }
  }

  /** 通知所有 WebSocket 客户端上下文变更（排除变更来源） */
  notifyClients(clients: Set<ConnectedClient>, key: string, value: unknown, changedBy: string): void {
    const notification = JSON.stringify({
      jsonrpc: '2.0',
      method: 'context.changed',
      params: { key, value, changedBy },
    })
    for (const client of clients) {
      const clientName = client.sandboxName ?? (client.role === 'orchestrator' ? 'orchestrator' : '')
      if (clientName === changedBy) continue
      if (client.ws.readyState === client.ws.OPEN) {
        client.ws.send(notification)
      }
    }
  }
}
