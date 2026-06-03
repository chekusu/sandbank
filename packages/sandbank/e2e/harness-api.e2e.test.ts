import { afterEach, describe, expect, it, vi } from 'vitest'
import { request as httpRequest } from 'node:http'
import { MemoryWorkspaceAdapter } from '@sandbank.dev/workspace'
import { startDbNativeAgentHarnessServer, type DbNativeAgentHarnessServer } from '../src/harness-node.js'

const servers: DbNativeAgentHarnessServer[] = []
const originalEnv = { ...process.env }

afterEach(async () => {
  await Promise.all(servers.splice(0).map(server => server.close()))
  process.env = { ...originalEnv }
})

describe('db-native harness HTTP e2e', () => {
  it('serves POST stream requests through the Node HTTP adapter', async () => {
    const workspace = new MemoryWorkspaceAdapter(undefined, { id: 'db9:e2e-node' })
    const fetchImpl = vi.fn(async () => {
      const encoder = new TextEncoder()
      return new Response(new ReadableStream({
        start(controller) {
          controller.enqueue(encoder.encode('data: {"choices":[{"delta":{"content":"node"}}]}\n\n'))
          controller.enqueue(encoder.encode('data: {"choices":[{"delta":{"content":" e2e"}}]}\n\n'))
          controller.enqueue(encoder.encode('data: [DONE]\n\n'))
          controller.close()
        },
      }))
    })
    const server = await startDbNativeAgentHarnessServer({
      DB9_DATABASE_ID: 'db-test',
      DEEPSEEK_API_KEY: 'deepseek-key',
    }, {
      createWorkspace: async () => workspace,
      fetchImpl,
      host: '127.0.0.1',
      id: () => 'run_node_e2e',
      now: () => new Date('2026-05-28T00:00:00.000Z'),
      port: 0,
    })
    servers.push(server)

    const response = await fetch(`${server.url}/api/db-native-agent-harness/stream`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        message: '@agent run a node e2e',
        mentions: { agent: 'agent', cleanedMessage: 'run a node e2e' },
        uiVariant: { id: 'terminal', label: 'Terminal' },
      }),
    })

    const body = await response.text()

    expect(response.status).toBe(200)
    expect(response.headers.get('content-type')).toContain('text/event-stream')
    expect(body).toContain('"type":"harness.started"')
    expect(body).toContain('"text":"node"')
    expect(body).toContain('"text":" e2e"')
    expect(body).toContain('"status":"completed"')
    await expect(workspace.read('/runs/run_node_e2e/assistant.md')).resolves.toBe('node e2e')
  })

  it('returns JSON 500 responses for uncaught adapter failures', async () => {
    const server = await startDbNativeAgentHarnessServer({
      DB9_DATABASE_ID: 'db-test',
      DEEPSEEK_API_KEY: 'deepseek-key',
    }, {
      createWorkspace: async () => {
        throw new Error('workspace unavailable')
      },
      host: '127.0.0.1',
      port: 0,
    })
    servers.push(server)

    const response = await fetch(`${server.url}/api/db-native-agent-harness/stream`, {
      method: 'POST',
      body: JSON.stringify({ message: '@agent fail before stream' }),
    })

    expect(response.status).toBe(200)
    const body = await response.text()
    expect(body).toContain('"type":"error"')
    expect(body).toContain('workspace unavailable')
  })

  it('handles CORS preflight at the HTTP boundary', async () => {
    const server = await startDbNativeAgentHarnessServer({}, {
      host: '127.0.0.1',
      port: 0,
    })
    servers.push(server)

    const response = await fetch(`${server.url}/api/db-native-agent-harness/stream`, {
      method: 'OPTIONS',
    })

    expect(response.status).toBe(204)
    expect(response.headers.get('access-control-allow-origin')).toBe('*')
    expect(await response.text()).toBe('')
  })

  it('uses default host and PORT env while accepting HEAD and repeated headers', async () => {
    process.env.PORT = '0'
    const server = await startDbNativeAgentHarnessServer({
      DB9_DATABASE_ID: 'db-test',
    })
    servers.push(server)

    const head = await fetch(`${server.url}/health`, { method: 'HEAD' })
    const raw = await rawHttpRequest(`${server.url}/health`, {
      method: 'GET',
      headers: { 'set-cookie': ['a=1', 'b=2'] },
    })

    expect(server.url).toContain('http://127.0.0.1:')
    expect(head.status).toBe(404)
    expect(await head.text()).toBe('')
    expect(raw.status).toBe(200)
    expect(raw.body).toContain('sandbank-db-native-agent-harness')
  })
})

function rawHttpRequest(url: string, options: {
  method: string
  headers?: Record<string, string | string[]>
}): Promise<{ status: number; body: string }> {
  return new Promise((resolve, reject) => {
    const req = httpRequest(url, options, res => {
      const chunks: Buffer[] = []
      res.on('data', chunk => chunks.push(Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk)))
      res.on('end', () => resolve({
        status: res.statusCode ?? 0,
        body: Buffer.concat(chunks).toString('utf8'),
      }))
    })
    req.on('error', reject)
    req.end()
  })
}
