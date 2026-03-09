/**
 * BoxLite Terminal Demo
 *
 * Creates a sandbox, starts ttyd, and serves an HTML page with xterm.js
 * that connects to the terminal WebSocket.
 *
 * Usage:
 *   BOXLITE_API_URL=http://localhost:8080 BOXLITE_API_TOKEN=xxx npx tsx test/terminal-demo.ts
 *
 * Then open http://localhost:9090 in your browser.
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
  <link rel="stylesheet" href="https://cdn.jsdelivr.net/npm/@xterm/xterm@5/css/xterm.min.css">
  <style>
    * { margin: 0; padding: 0; box-sizing: border-box; }
    body {
      background: #1a1a2e;
      color: #e0e0e0;
      font-family: -apple-system, BlinkMacSystemFont, 'Segoe UI', sans-serif;
      height: 100vh;
      display: flex;
      flex-direction: column;
    }
    header {
      padding: 12px 20px;
      background: #16213e;
      border-bottom: 1px solid #0f3460;
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
      color: #888;
      background: #111;
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
    import { Terminal } from 'https://cdn.jsdelivr.net/npm/@xterm/xterm@5/+esm'
    import { FitAddon } from 'https://cdn.jsdelivr.net/npm/@xterm/addon-fit@0/+esm'
    import { WebLinksAddon } from 'https://cdn.jsdelivr.net/npm/@xterm/addon-web-links@0/+esm'

    const term = new Terminal({
      cursorBlink: true,
      fontSize: 14,
      fontFamily: "'JetBrains Mono', 'Fira Code', 'Cascadia Code', monospace",
      theme: {
        background: '#1a1a2e',
        foreground: '#e0e0e0',
        cursor: '#f59e0b',
        selectionBackground: '#3b82f620',
      },
    })

    const fitAddon = new FitAddon()
    term.loadAddon(fitAddon)
    term.loadAddon(new WebLinksAddon())
    term.open(document.getElementById('terminal-container'))
    fitAddon.fit()

    window.addEventListener('resize', () => fitAddon.fit())

    const statusEl = document.getElementById('status')

    // ttyd uses its own WebSocket protocol
    const ws = new WebSocket('${info.url}')
    ws.binaryType = 'arraybuffer'

    ws.onopen = () => {
      statusEl.textContent = 'connected'
      statusEl.style.background = '#0a3d22'
      statusEl.style.color = '#4ade80'
      term.focus()
    }

    ws.onmessage = (ev) => {
      const data = ev.data
      if (data instanceof ArrayBuffer) {
        const view = new Uint8Array(data)
        // ttyd protocol: first byte is message type
        // 0 = output, 1 = set window title, 2 = set preferences
        if (view[0] === 0) {
          term.write(view.slice(1))
        }
      } else if (typeof data === 'string') {
        // JSON control messages from ttyd
        try {
          const msg = JSON.parse(data)
          if (msg.AuthToken) {
            // Respond with auth token
            ws.send(JSON.stringify({ AuthToken: msg.AuthToken }))
          }
        } catch {
          term.write(data)
        }
      }
    }

    ws.onclose = () => {
      statusEl.textContent = 'disconnected'
      statusEl.style.background = '#3d0a0a'
      statusEl.style.color = '#f87171'
      term.write('\\r\\n\\x1b[31m[Connection closed]\\x1b[0m\\r\\n')
    }

    ws.onerror = () => {
      statusEl.textContent = 'error'
      statusEl.style.background = '#3d0a0a'
      statusEl.style.color = '#f87171'
    }

    // Send input to ttyd
    // ttyd protocol: first byte 0 = input, 1 = resize
    term.onData((data) => {
      const encoder = new TextEncoder()
      const encoded = encoder.encode(data)
      const buf = new Uint8Array(encoded.length + 1)
      buf[0] = 0 // input type
      buf.set(encoded, 1)
      ws.send(buf)
    })

    // Send resize events
    term.onResize(({ cols, rows }) => {
      const msg = JSON.stringify({ columns: cols, rows: rows })
      const encoder = new TextEncoder()
      const encoded = encoder.encode(msg)
      const buf = new Uint8Array(encoded.length + 1)
      buf[0] = 1 // resize type
      buf.set(encoded, 1)
      ws.send(buf)
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
