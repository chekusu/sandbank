import type { Transport } from '@sandbank/core'

/** 使用 Node 内置 WebSocket 的 Transport 实现 */
export function createWebSocketTransport(url: string): Promise<Transport> {
  return new Promise((resolve, reject) => {
    const ws = new WebSocket(url)
    const listeners: Array<(data: string) => void> = []
    let state: Transport['readyState'] = 'connecting'

    ws.addEventListener('open', () => {
      state = 'open'
      resolve(transport)
    })

    ws.addEventListener('error', (evt) => {
      if (state === 'connecting') {
        reject(new Error(`WebSocket connection failed: ${url}`))
      }
    })

    ws.addEventListener('message', (evt) => {
      const data = typeof evt.data === 'string' ? evt.data : String(evt.data)
      for (const fn of listeners) {
        fn(data)
      }
    })

    ws.addEventListener('close', () => {
      state = 'closed'
    })

    const transport: Transport = {
      send(data: string) {
        ws.send(data)
      },
      onMessage(fn: (data: string) => void) {
        listeners.push(fn)
      },
      close() {
        ws.close()
      },
      get readyState() {
        return state
      },
    }
  })
}
