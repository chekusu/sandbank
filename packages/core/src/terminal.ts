import type { Disposable, TerminalInfo, TerminalSession } from './types.js'

/**
 * ttyd binary protocol constants.
 *
 * Client → Server:
 *   0x00 + UTF-8 text  = user input
 *   0x01 + JSON string = resize {"columns":N,"rows":N}
 *
 * Server → Client:
 *   0x00 + UTF-8 text  = terminal output
 *   0x01              = auth required (ignored)
 *   0x02 + text       = window title  (ignored)
 */
const MSG_INPUT = 0
const MSG_RESIZE = 1
const MSG_OUTPUT = 0

const decoder = new TextDecoder()
const encoder = new TextEncoder()

/**
 * 连接 ttyd WebSocket 端点，返回 TerminalSession。
 *
 * 使用全局 WebSocket（Node.js 22+ 和浏览器均原生支持）。
 */
export function connectTerminal(info: TerminalInfo): TerminalSession {
  const listeners = new Set<(data: string) => void>()
  let state: 'connecting' | 'open' | 'closed' = 'connecting'

  let resolveReady: () => void
  let rejectReady: (err: Error) => void
  const ready = new Promise<void>((resolve, reject) => {
    resolveReady = resolve
    rejectReady = reject
  })

  const ws = new WebSocket(info.url)
  ws.binaryType = 'arraybuffer'

  ws.addEventListener('open', () => {
    state = 'open'
    resolveReady!()
  })

  ws.addEventListener('message', (event) => {
    const buf = new Uint8Array(event.data as ArrayBuffer)
    if (buf.length === 0) return

    const type = buf[0]!
    if (type === MSG_OUTPUT) {
      const text = decoder.decode(buf.subarray(1))
      for (const fn of listeners) fn(text)
    }
    // type 1 (auth) and type 2 (title) are ignored
  })

  ws.addEventListener('close', () => {
    state = 'closed'
  })

  ws.addEventListener('error', (event) => {
    if (state === 'connecting') {
      rejectReady!(new Error(`WebSocket connection failed: ${info.url}`))
    }
    state = 'closed'
  })

  return {
    write(data: string): void {
      if (state !== 'open') return
      const payload = encoder.encode(data)
      const frame = new Uint8Array(1 + payload.length)
      frame[0] = MSG_INPUT
      frame.set(payload, 1)
      ws.send(frame)
    },

    onData(cb: (data: string) => void): Disposable {
      listeners.add(cb)
      return { dispose: () => { listeners.delete(cb) } }
    },

    resize(cols: number, rows: number): void {
      if (state !== 'open') return
      const json = JSON.stringify({ columns: cols, rows })
      const payload = encoder.encode(json)
      const frame = new Uint8Array(1 + payload.length)
      frame[0] = MSG_RESIZE
      frame.set(payload, 1)
      ws.send(frame)
    },

    close(): void {
      if (state === 'closed') return
      state = 'closed'
      ws.close()
    },

    get state() { return state },
    get ready() { return ready },
  }
}
