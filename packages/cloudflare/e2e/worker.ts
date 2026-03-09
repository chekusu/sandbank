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

      if (request.method === 'POST' && path === '/start-terminal') {
        const body = await request.json<{ id: string; shell?: string }>()
        const sandbox = getSandbox(env.SANDBOX, body.id)
        const port = 7681
        const shell = body.shell ?? '/bin/bash'
        const ttydBase = 'https://github.com/tsl0922/ttyd/releases/download/1.7.7/ttyd'

        // 1. Ensure ttyd is available (use wget fallback since curl may not be installed)
        const check = await sandbox.exec('which ttyd')
        if ((check.exitCode ?? (check.success ? 0 : 1)) !== 0) {
          await sandbox.exec(
            `ARCH=$(uname -m); case "$ARCH" in aarch64|arm64) ARCH=aarch64;; x86_64) ARCH=x86_64;; *) echo "Unsupported arch: $ARCH" >&2; exit 1;; esac; `
            + `TTYD_URL="${ttydBase}.$ARCH"; `
            + `command -v curl > /dev/null && curl -sL "$TTYD_URL" -o /usr/local/bin/ttyd`
            + ` || { command -v wget > /dev/null && wget -qO /usr/local/bin/ttyd "$TTYD_URL"; }`
            + ` || { apt-get update -qq && apt-get install -y -qq wget > /dev/null && wget -qO /usr/local/bin/ttyd "$TTYD_URL"; }`,
          )
          await sandbox.exec('chmod +x /usr/local/bin/ttyd')
        }

        // 2. Start ttyd in background
        await sandbox.exec(`nohup ttyd -W -p ${port} ${shell} > /dev/null 2>&1 &`)

        // 3. Wait for ttyd to be ready (check process is running)
        await sandbox.exec(
          `for i in $(seq 1 20); do pgrep -x ttyd > /dev/null && break || sleep 0.5; done`,
        )

        // 4. Expose port and return URL (handle already-exposed case)
        let wsUrl: string
        try {
          const exposed = await sandbox.exposePort(port, { hostname: 'localhost' })
          wsUrl = exposed.url.replace(/\/$/, '') + '/ws'
        } catch (e) {
          // Port may already be exposed from a previous call — build URL manually
          const id = body.id
          wsUrl = `http://${port}-${id}.localhost/ws`
        }

        return json({ url: wsUrl, port })
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
