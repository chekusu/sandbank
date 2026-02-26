/// <reference types="@cloudflare/workers-types" />
import { Sandbox, getSandbox, type Sandbox as SandboxType } from '@cloudflare/sandbox'

export { Sandbox }

interface Env {
  SANDBOX: DurableObjectNamespace<SandboxType>
}

export default {
  async fetch(request: Request, env: Env): Promise<Response> {
    const url = new URL(request.url)
    const path = url.pathname

    try {
      if (request.method === 'GET' && path === '/health') {
        return json({ ok: true })
      }

      // Create: generates an externalId, calls getSandbox to register it
      if (request.method === 'POST' && path === '/create') {
        const externalId = crypto.randomUUID().slice(0, 12)
        // Calling getSandbox registers the sandbox with CF's Durable Object system.
        // The sandbox is now addressable by externalId from any isolate.
        getSandbox(env.SANDBOX, externalId)
        return json({ id: externalId })
      }

      // All operations below reconnect via getSandbox(namespace, id)
      // so they work regardless of which isolate handles the request.

      if (request.method === 'POST' && path === '/exec') {
        const body = await request.json<{ id: string; command: string; timeout?: number; cwd?: string }>()
        const sandbox = getSandbox(env.SANDBOX, body.id)
        const result = await sandbox.exec(body.command, {
          timeout: body.timeout,
          cwd: body.cwd,
        })
        return json({
          exitCode: result.exitCode ?? (result.success ? 0 : 1),
          stdout: result.stdout ?? '',
          stderr: result.stderr ?? '',
        })
      }

      if (request.method === 'POST' && path === '/write-file') {
        const body = await request.json<{ id: string; path: string; content: string; binary?: boolean }>()
        const sandbox = getSandbox(env.SANDBOX, body.id)
        if (body.binary) {
          await sandbox.writeFile(body.path, body.content, { encoding: 'base64' })
        } else {
          await sandbox.writeFile(body.path, body.content, { encoding: 'utf-8' })
        }
        return json({ ok: true })
      }

      if (request.method === 'POST' && path === '/read-file') {
        const body = await request.json<{ id: string; path: string }>()
        const sandbox = getSandbox(env.SANDBOX, body.id)
        const result = await sandbox.readFile(body.path, { encoding: 'base64' })
        const b64 = typeof result === 'string' ? result : (result as { content: string }).content
        return json({ content: b64 })
      }

      if (request.method === 'POST' && path === '/exec-stream') {
        const body = await request.json<{ id: string; command: string }>()
        const sandbox = getSandbox(env.SANDBOX, body.id)
        const stream = await sandbox.execStream(body.command)
        return new Response(stream, {
          headers: { 'Content-Type': 'application/octet-stream' },
        })
      }

      if (request.method === 'POST' && path === '/expose-port') {
        const body = await request.json<{ id: string; port: number }>()
        const sandbox = getSandbox(env.SANDBOX, body.id)
        const result = await sandbox.exposePort(body.port, { hostname: 'localhost' })
        return json(result)
      }

      if (request.method === 'POST' && path === '/snapshot/create') {
        const body = await request.json<{ id: string; name?: string }>()
        const sandbox = getSandbox(env.SANDBOX, body.id)
        const backup = await sandbox.createBackup({ dir: '/', name: body.name })
        // Store backup reference in the response — client must pass it back for restore
        const snapshotId = `snap-${crypto.randomUUID().slice(0, 8)}`
        // We can't persist this across isolates, so snapshot tests need same-request flow
        return json({ snapshotId, _backup: backup })
      }

      if (request.method === 'POST' && path === '/destroy') {
        const body = await request.json<{ id: string }>()
        try {
          const sandbox = getSandbox(env.SANDBOX, body.id)
          await sandbox.destroy()
        } catch {
          // Idempotent: ignore errors
        }
        return json({ ok: true })
      }

      return json({ error: 'not found' }, 404)
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err)
      const name = err instanceof Error ? err.constructor.name : 'Error'
      return json({ error: message, type: name }, 500)
    }
  },
}

function json(data: unknown, status = 200): Response {
  return new Response(JSON.stringify(data), {
    status,
    headers: { 'Content-Type': 'application/json' },
  })
}
