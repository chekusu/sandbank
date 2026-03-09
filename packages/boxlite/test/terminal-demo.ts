/**
 * BoxLite Terminal Demo
 *
 * Creates a sandbox, starts ttyd, and serves an HTML page with ghostty-web
 * that connects to the terminal WebSocket using the ttyd binary protocol.
 *
 * Usage:
 *   BOXLITE_API_URL=http://localhost:8090 npx tsx test/terminal-demo.ts
 *
 * Then open http://localhost:9091 in your browser.
 */
import { createProvider, withTerminal } from '@sandbank.dev/core'
import { BoxLiteAdapter } from '../src/index.js'
import { createServer } from 'node:http'

const API_URL = process.env['BOXLITE_API_URL'] ?? 'http://127.0.0.1:8090'

const adapter = new BoxLiteAdapter({
  apiUrl: API_URL,
})
const provider = createProvider(adapter)

console.log('Creating sandbox...')
const sandbox = await provider.create({ image: 'ubuntu:24.04' })
console.log(`Sandbox created: ${sandbox.id}`)

const terminal = withTerminal(sandbox)
if (!terminal) {
  console.error('Terminal capability not available')
  await provider.destroy(sandbox.id)
  process.exit(1)
}

console.log('Starting terminal (installing ttyd)...')
const info = await terminal.startTerminal()
console.log(`Terminal WebSocket: ${info.url}`)

const html = `<!DOCTYPE html>
<html>
<head>
  <meta charset="utf-8">
  <title>Sandbank Terminal — BoxLite</title>
  <style>
    * { margin: 0; padding: 0; box-sizing: border-box; }
    body {
      background: #1a1b26;
      color: #a9b1d6;
      font-family: -apple-system, BlinkMacSystemFont, 'Segoe UI', sans-serif;
      height: 100vh;
      display: flex;
      flex-direction: column;
    }
    header {
      padding: 12px 20px;
      background: #16161e;
      border-bottom: 1px solid #292e42;
      display: flex;
      align-items: center;
      gap: 12px;
    }
    header h1 { font-size: 16px; font-weight: 500; }
    .badge {
      font-size: 11px;
      padding: 2px 8px;
      border-radius: 4px;
      font-family: monospace;
    }
    .badge-green { background: #0a3d22; color: #4ade80; }
    .badge-blue { background: #1e3a5f; color: #60a5fa; }
    #terminal-container {
      flex: 1;
      padding: 8px;
      overflow: hidden;
    }
    .info {
      padding: 8px 20px;
      font-size: 12px;
      color: #565f89;
      background: #13131a;
      font-family: monospace;
    }
  </style>
</head>
<body>
  <header>
    <h1>Sandbank Terminal</h1>
    <span class="badge badge-green">BoxLite</span>
    <span class="badge badge-blue" id="status">connecting...</span>
  </header>
  <div id="terminal-container"></div>
  <div class="info">
    Sandbox: ${sandbox.id} &nbsp;|&nbsp; WebSocket: ${info.url} &nbsp;|&nbsp; Port: ${info.port}
  </div>

  <script type="module">
    import { init, Terminal, FitAddon } from 'https://cdn.jsdelivr.net/npm/ghostty-web/+esm'

    // ttyd binary protocol constants
    const TTYD_INPUT  = '0'.charCodeAt(0)  // 0x30
    const TTYD_RESIZE = '1'.charCodeAt(0)  // 0x31
    const TTYD_OUTPUT = '0'.charCodeAt(0)  // 0x30

    const textEncoder = new TextEncoder()
    const textDecoder = new TextDecoder()

    await init()

    const term = new Terminal({
      fontSize: 14,
      fontFamily: "'JetBrains Mono', 'Fira Code', 'Cascadia Code', Menlo, Monaco, monospace",
      cursorBlink: true,
      cursorStyle: 'bar',
      scrollback: 5000,
      theme: {
        background: '#1a1b26',
        foreground: '#a9b1d6',
        cursor: '#c0caf5',
        selectionBackground: '#33467c',
        black: '#15161e',
        red: '#f7768e',
        green: '#9ece6a',
        yellow: '#e0af68',
        blue: '#7aa2f7',
        magenta: '#bb9af7',
        cyan: '#7dcfff',
        white: '#a9b1d6',
        brightBlack: '#414868',
        brightRed: '#f7768e',
        brightGreen: '#9ece6a',
        brightYellow: '#e0af68',
        brightBlue: '#7aa2f7',
        brightMagenta: '#bb9af7',
        brightCyan: '#7dcfff',
        brightWhite: '#c0caf5',
      },
    })

    term.open(document.getElementById('terminal-container'))

    const fitAddon = new FitAddon()
    term.loadAddon(fitAddon)
    fitAddon.fit()
    fitAddon.observeResize()

    const statusEl = document.getElementById('status')

    // Connect to ttyd WebSocket with 'tty' subprotocol
    const wsUrl = '${info.url}'.replace(/^https:\\/\\//, 'wss://').replace(/^http:\\/\\//, 'ws://')
    const ws = new WebSocket(wsUrl, ['tty'])
    ws.binaryType = 'arraybuffer'

    ws.onopen = () => {
      statusEl.textContent = 'connected'
      statusEl.style.background = '#0a3d22'
      statusEl.style.color = '#4ade80'
      term.focus()

      // ttyd handshake: send auth token and initial dimensions
      const dims = fitAddon.proposeDimensions()
      ws.send(JSON.stringify({
        AuthToken: '',
        columns: dims?.cols ?? 80,
        rows: dims?.rows ?? 24,
      }))
    }

    // ttyd output: first byte is message type (0x30 = output)
    ws.onmessage = (ev) => {
      if (!(ev.data instanceof ArrayBuffer)) return
      const data = new Uint8Array(ev.data)
      if (data.length < 1) return
      if (data[0] === TTYD_OUTPUT) {
        const text = textDecoder.decode(data.slice(1))
        term.write(text)
      }
    }

    ws.onclose = () => {
      statusEl.textContent = 'disconnected'
      statusEl.style.background = '#3d0a0a'
      statusEl.style.color = '#f87171'
    }

    ws.onerror = () => {
      statusEl.textContent = 'error'
      statusEl.style.background = '#3d0a0a'
      statusEl.style.color = '#f87171'
    }

    // Forward terminal input using ttyd binary protocol (0x30 = input)
    term.onData((data) => {
      if (ws.readyState !== WebSocket.OPEN) return
      const encoded = textEncoder.encode(data)
      const msg = new Uint8Array(encoded.length + 1)
      msg[0] = TTYD_INPUT
      msg.set(encoded, 1)
      ws.send(msg)
    })

    // Send resize events using ttyd binary protocol (0x31 = resize)
    term.onResize(({ cols, rows }) => {
      if (ws.readyState !== WebSocket.OPEN) return
      const json = JSON.stringify({ columns: cols, rows })
      const encoded = textEncoder.encode(json)
      const msg = new Uint8Array(encoded.length + 1)
      msg[0] = TTYD_RESIZE
      msg.set(encoded, 1)
      ws.send(msg)
    })
  </script>
</body>
</html>`

const DEMO_PORT = 9091
const server = createServer((req, res) => {
  res.writeHead(200, { 'Content-Type': 'text/html; charset=utf-8' })
  res.end(html)
})

server.listen(DEMO_PORT, () => {
  console.log(`\n  Open http://localhost:${DEMO_PORT} in your browser\n`)
  console.log('  Press Ctrl+C to stop and destroy the sandbox')
})

// Cleanup on exit
async function cleanup() {
  console.log('\nCleaning up...')
  server.close()
  try {
    await provider.destroy(sandbox.id)
    console.log(`Sandbox ${sandbox.id} destroyed`)
  } catch (e) {
    console.error('Cleanup error:', e)
  }
  process.exit(0)
}

process.on('SIGINT', cleanup)
process.on('SIGTERM', cleanup)
