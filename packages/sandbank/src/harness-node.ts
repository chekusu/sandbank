import { createServer, type IncomingMessage, type ServerResponse } from 'node:http'
import type { AddressInfo } from 'node:net'
import {
  createDbNativeAgentHarnessHandler,
  type DbNativeAgentHarnessEnv,
  type DbNativeAgentHarnessServerOptions,
} from './harness-api.js'

export interface DbNativeAgentHarnessServer {
  url: string
  close(): Promise<void>
}

export async function startDbNativeAgentHarnessServer(
  env: DbNativeAgentHarnessEnv = {},
  options: DbNativeAgentHarnessServerOptions = {},
): Promise<DbNativeAgentHarnessServer> {
  const handler = createDbNativeAgentHarnessHandler(env, options)
  const host = options.host ?? '0.0.0.0'
  const port = options.port ?? Number(process.env['PORT'] ?? '8789')
  const server = createServer(async (req, res) => {
    try {
      const request = await toFetchRequest(req, host)
      const response = await handler.fetch(request)
      await writeNodeResponse(res, response)
    } catch (err) {
      res.statusCode = 500
      res.setHeader('content-type', 'application/json; charset=utf-8')
      res.end(JSON.stringify({ error: err instanceof Error ? err.message : 'internal_error' }))
    }
  })

  await new Promise<void>((resolve, reject) => {
    server.once('error', reject)
    server.listen(port, host, () => {
      server.off('error', reject)
      resolve()
    })
  })

  const address = server.address() as AddressInfo
  const urlHost = host === '0.0.0.0' || host === '::' ? '127.0.0.1' : host
  return {
    url: `http://${urlHost}:${address.port}`,
    close: () => new Promise<void>((resolve, reject) => {
      server.close(err => err ? reject(err) : resolve())
    }),
  }
}

async function toFetchRequest(req: IncomingMessage, host: string): Promise<Request> {
  const protocol = 'http'
  const headerHost = req.headers.host ?? `${host}:${process.env['PORT'] ?? '8789'}`
  const url = new URL(req.url ?? '/', `${protocol}://${headerHost}`)
  const method = req.method ?? 'GET'
  const body = method === 'GET' || method === 'HEAD' ? undefined : await readRawBody(req)
  return new Request(url, {
    method,
    headers: copyHeaders(req.headers),
    body: body ? new Uint8Array(body) : undefined,
  })
}

async function writeNodeResponse(res: ServerResponse, response: Response): Promise<void> {
  res.statusCode = response.status
  response.headers.forEach((value, key) => res.setHeader(key, value))

  if (!response.body) {
    res.end()
    return
  }

  const reader = response.body.getReader()
  while (true) {
    const { done, value } = await reader.read()
    if (done) break
    res.write(Buffer.from(value))
  }
  res.end()
}

function readRawBody(req: IncomingMessage): Promise<Buffer> {
  return new Promise((resolve, reject) => {
    const chunks: Buffer[] = []
    req.on('data', chunk => chunks.push(Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk)))
    req.on('end', () => resolve(Buffer.concat(chunks)))
    req.on('error', reject)
  })
}

function copyHeaders(headers: IncomingMessage['headers']): Headers {
  const out = new Headers()
  for (const [key, value] of Object.entries(headers)) {
    if (Array.isArray(value)) out.set(key, value.join(', '))
    else if (value !== undefined) out.set(key, String(value))
  }
  return out
}
