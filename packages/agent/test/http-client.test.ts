import { describe, it, expect, afterEach } from 'vitest'
import { startRelay } from '@sandbank/relay'
import type { RelayServer } from '@sandbank/relay'
import WebSocket from 'ws'
import {
  sendMessage,
  recvMessages,
  contextGet,
  contextSet,
  contextDelete,
  contextKeys,
  complete,
} from '../src/http-client.js'

let relay: RelayServer | null = null
let orch: WebSocket | null = null

afterEach(async () => {
  if (orch) { orch.close(); orch = null }
  if (relay) { await relay.close(); relay = null }
  // Reset env
  delete process.env['SANDBANK_RELAY_URL']
  delete process.env['SANDBANK_SESSION_ID']
  delete process.env['SANDBANK_SANDBOX_NAME']
  delete process.env['SANDBANK_AUTH_TOKEN']
})

function wsConnect(url: string): Promise<WebSocket> {
  return new Promise((resolve, reject) => {
    const ws = new WebSocket(url)
    ws.on('open', () => resolve(ws))
    ws.on('error', reject)
  })
}

function wsSend(ws: WebSocket, msg: object): void {
  ws.send(JSON.stringify(msg))
}

function wsRecv(ws: WebSocket): Promise<Record<string, unknown>> {
  return new Promise((resolve) => {
    ws.once('message', (data) => {
      resolve(JSON.parse(data.toString()) as Record<string, unknown>)
    })
  })
}

async function setup(): Promise<void> {
  relay = await startRelay({ port: 0 })
  const sessionId = `cli-test-${Date.now()}-${Math.random().toString(36).slice(2, 6)}`

  // Setup env vars for HTTP client
  process.env['SANDBANK_RELAY_URL'] = relay.url
  process.env['SANDBANK_SESSION_ID'] = sessionId
  process.env['SANDBANK_SANDBOX_NAME'] = 'cli-agent'

  // Connect orchestrator and register sandbox
  orch = await wsConnect(relay.wsUrl)
  wsSend(orch, { jsonrpc: '2.0', id: 1, method: 'session.auth', params: { sessionId, role: 'orchestrator' } })
  const authResult = await wsRecv(orch)
  // 提取 token，后续 HTTP 请求需要用
  const token = (authResult['result'] as Record<string, unknown>)?.['token'] as string
  process.env['SANDBANK_AUTH_TOKEN'] = token

  wsSend(orch, { jsonrpc: '2.0', id: 2, method: 'session.register', params: { name: 'cli-agent', sandboxId: 'sb-cli' } })
  await wsRecv(orch)
}

describe('HTTP client functions', () => {
  it('sendMessage sends via HTTP /rpc', async () => {
    await setup()
    await sendMessage('orchestrator', 'hello', { msg: 'hi' })
    // Should succeed without error
  })

  it('recvMessages drains queue', async () => {
    await setup()

    // Orchestrator sends messages
    wsSend(orch!, {
      jsonrpc: '2.0', id: 10, method: 'message.send',
      params: { to: 'cli-agent', type: 'task', payload: 'do it', priority: 'normal' },
    })
    await wsRecv(orch!)

    const msgs = await recvMessages(10, 0)
    expect(msgs).toHaveLength(1)
  })

  it('contextSet/contextGet round-trips', async () => {
    await setup()

    await contextSet('mykey', { data: 42 })
    const val = await contextGet('mykey')
    expect(val).toEqual({ data: 42 })
  })

  it('contextKeys lists all keys', async () => {
    await setup()

    await contextSet('k1', 'v1')
    await contextSet('k2', 'v2')
    const keys = await contextKeys()
    expect(keys).toContain('k1')
    expect(keys).toContain('k2')
  })

  it('contextDelete removes key', async () => {
    await setup()

    await contextSet('temp', 'val')
    await contextDelete('temp')
    const val = await contextGet('temp')
    expect(val).toBeUndefined()
  })

  it('complete sends sandbox.complete', async () => {
    await setup()

    // Set up listener BEFORE sending to avoid race condition
    const notificationPromise = wsRecv(orch!)

    await complete('success', 'All done')

    // Orchestrator should receive sandbox.state notification
    const notification = await notificationPromise
    expect(notification['method']).toBe('sandbox.state')
  })
})
