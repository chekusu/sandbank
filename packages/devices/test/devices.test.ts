import { describe, expect, it } from 'vitest'
import { DeviceApiError, SandbankDevices, runOnDesktop, trustedDeviceLink } from '../src/client.js'
import { createCommandTool, createComputerTool, createDeviceTools, createPhoneTool, type DeviceCard } from '../src/tools.js'
import { accessMode, d1Allowlist, deviceAccessAllowed } from '../src/access.js'
import { toChatMessages, toOpenAITool, runDeviceToolCall } from '../src/openai.js'
import { toPiTool } from '../src/pi.js'

type Call = { method: string; path: string; body: Record<string, unknown> | undefined; auth: string | null }

/** A small in-memory /v2 server. */
function fakeV2(options: { bootPolls?: number; takeoverActive?: boolean; actStatus?: number; execStatus?: number } = {}) {
  const calls: Call[] = []
  const sessions = new Map<string, { id: string; kind: string; owner: string; state: string; polls: number }>()
  let takeover = options.takeoverActive ?? false
  const fetchImpl: typeof fetch = async (input, init) => {
    const url = new URL(String(input))
    const method = init?.method ?? 'GET'
    const body = init?.body ? JSON.parse(String(init.body)) : undefined
    calls.push({ method, path: url.pathname + url.search, body, auth: new Headers(init?.headers).get('authorization') })
    const reply = (status: number, data: unknown) => new Response(JSON.stringify(data), { status, headers: { 'content-type': 'application/json' } })
    const parts = url.pathname.split('/').filter(Boolean) // v2 sessions :id sub
    if (parts[0] !== 'v2' || parts[1] !== 'sessions') return reply(404, { error: 'not found' })
    if (parts.length === 2 && method === 'POST') {
      const key = `${body.kind}:${body.owner}`
      let session = sessions.get(key)
      if (!session) {
        session = { id: `ses_${sessions.size + 1}`, kind: body.kind, owner: body.owner, state: options.bootPolls ? 'booting' : 'ready', polls: 0 }
        sessions.set(key, session)
      } else if (session.state === 'stopped') session.state = 'ready'
      return reply(200, session)
    }
    if (parts.length === 2 && method === 'GET') {
      const owner = url.searchParams.get('owner')
      const kind = url.searchParams.get('kind')
      return reply(200, { sessions: [...sessions.values()].filter((s) => (!owner || s.owner === owner) && (!kind || s.kind === kind)) })
    }
    if (parts[2] === 'warm') return reply(202, {})
    const session = [...sessions.values()].find((s) => s.id === parts[2])
    if (!session) return reply(404, { error: 'no such session', code: 'not_found' })
    const sub = parts[3]
    if (!sub && method === 'GET') {
      session.polls++
      if (session.state === 'booting' && session.polls >= (options.bootPolls ?? 0)) session.state = 'ready'
      return reply(200, session)
    }
    if (!sub && method === 'DELETE') {
      if (url.searchParams.get('purge') === 'true') {
        sessions.delete(`${session.kind}:${session.owner}`)
        return reply(200, { id: session.id, deleted: true })
      }
      session.state = 'stopped'
      return reply(200, session)
    }
    if (sub === 'screen') return reply(200, { image: 'SU1H', width: 960, height: 2000 })
    if (sub === 'ui') return reply(200, { tree: '[e1] Button "OK" (10,10)', width: 960, height: 2000 })
    if (sub === 'act') {
      if (takeover) return reply(409, { error: 'the user has this device', code: 'takeover' })
      if (options.actStatus) return reply(options.actStatus, { ok: false, error: 'no such element' })
      return reply(200, { ok: true })
    }
    if (sub === 'exec') {
      if (options.execStatus) return new Response('gateway timeout', { status: options.execStatus })
      return reply(200, { stdout: 'hi\n', stderr: '', exit_code: 0 })
    }
    if (sub === 'takeover' && method === 'POST') {
      takeover = true
      return reply(200, { url: `https://cloud.sandbank.dev/v2/p/tok123/`, expires_at: '2026-11-03T12:00:00Z' })
    }
    if (sub === 'takeover' && method === 'DELETE') {
      takeover = false
      return reply(200, session)
    }
    if (sub === 'secure-input' && method === 'POST') return reply(200, { url: 'https://cloud.sandbank.dev/v2/p/sec456/', expires_at: '2026-11-03T12:00:00Z' })
    if (sub === 'secure-input') return reply(200, { filled: false })
    return reply(404, { error: 'not found' })
  }
  return { calls, sessions, fetchImpl, setTakeover: (value: boolean) => { takeover = value } }
}

function client(server: ReturnType<typeof fakeV2>) {
  return new SandbankDevices({ apiKey: 'sbk_test', fetch: server.fetchImpl, bootPollMs: { phone: 0, desktop: 0, browser: 0 } })
}

describe('SandbankDevices', () => {
  it('needs a key, and fromEnv is null without one', () => {
    expect(SandbankDevices.fromEnv({})).toBeNull()
    expect(SandbankDevices.fromEnv({ SANDBANK_API_TOKEN: '  ' })).toBeNull()
    expect(SandbankDevices.fromEnv({ SANDBANK_API_TOKEN: 'sbk_x', SANDBANK_API_URL: 'https://example.dev/' })?.baseUrl).toBe('https://example.dev')
    expect(() => new SandbankDevices({ apiKey: '' })).toThrow()
  })

  it('creates the owner session once and waits while it boots', async () => {
    const server = fakeV2({ bootPolls: 3 })
    const devices = client(server)
    const session = await devices.ensure('phone', 'user_1')
    expect(session).toMatchObject({ id: 'ses_1', state: 'ready' })
    expect(server.calls.filter((c) => c.method === 'GET')).toHaveLength(3)
    expect(server.calls[0]).toMatchObject({ method: 'POST', path: '/v2/sessions', body: { kind: 'phone', owner: 'user_1' }, auth: 'Bearer sbk_test' })
    expect((await devices.ensure('phone', 'user_1')).id).toBe('ses_1')
  })

  it('turns error answers into DeviceApiError', async () => {
    const server = fakeV2()
    await expect(client(server).screen('ses_missing')).rejects.toMatchObject({ status: 404, code: 'not_found' })
  })

  it('accepts only its own takeover and secure input links', () => {
    const base = 'https://cloud.sandbank.dev'
    expect(trustedDeviceLink(base, 'https://cloud.sandbank.dev/v2/p/abc/')).toBe('https://cloud.sandbank.dev/v2/p/abc/')
    expect(trustedDeviceLink(base, 'https://cloud.sandbank.dev/phonebox/p/abc/')).toBe('https://cloud.sandbank.dev/phonebox/p/abc/')
    expect(trustedDeviceLink(base, 'http://cloud.sandbank.dev/v2/p/abc/')).toBeNull()
    expect(trustedDeviceLink(base, 'https://evil.example/v2/p/abc/')).toBeNull()
    expect(trustedDeviceLink(base, 'https://cloud.sandbank.dev/v1/boxes')).toBeNull()
    expect(trustedDeviceLink(base, 42)).toBeNull()
  })

  it('runs a command on the desktop in /workspace under timeout', async () => {
    const server = fakeV2()
    const ran = await runOnDesktop(client(server), 'user_1', { command: 'echo hi', timeoutSeconds: 30 })
    expect(ran).toMatchObject({ sessionId: 'ses_1', exitCode: 0, stdout: 'hi\n', timedOut: false })
    const exec = server.calls.find((c) => c.path.endsWith('/exec'))!
    expect(exec.body).toEqual({ cmd: ['timeout', '--kill-after=5', '30', 'bash', '-lc', 'mkdir -p /workspace && cd /workspace && echo hi'], timeout_s: 45 })
  })

  it('reports a 504 exec as timed out, and reset purges first', async () => {
    const server = fakeV2({ execStatus: 504 })
    const devices = client(server)
    await devices.ensure('desktop', 'user_1')
    const ran = await runOnDesktop(devices, 'user_1', { command: 'sleep 999', timeoutSeconds: 5, reset: true })
    expect(ran.timedOut).toBe(true)
    expect(server.calls.some((c) => c.method === 'DELETE' && c.path.includes('purge=true'))).toBe(true)
  })
})

describe('phone tool', () => {
  it('taps and returns a screenshot', async () => {
    const server = fakeV2()
    const tool = createPhoneTool(client(server), { settleMs: 0 })
    const result = await tool.execute({ action: 'tap', args: { x: 10, y: 20 } }, { owner: 'user_1' })
    expect(result.isError).toBeUndefined()
    expect(result.content[1]).toEqual({ type: 'image', data: 'SU1H', mimeType: 'image/jpeg' })
    expect(server.calls.find((c) => c.path.endsWith('/act'))?.body).toEqual({ x: 10, y: 20, action: 'tap' })
  })

  it('maps launch {package} to app', async () => {
    const server = fakeV2()
    await createPhoneTool(client(server), { settleMs: 0 }).execute({ action: 'launch', args: { package: 'com.example' }, look: 'none' }, { owner: 'u' })
    expect(server.calls.find((c) => c.path.endsWith('/act'))?.body).toEqual({ package: 'com.example', app: 'com.example', action: 'launch' })
  })

  it('shows a handoff as a card when the product can, and as text otherwise', async () => {
    const server = fakeV2()
    const tool = createPhoneTool(client(server), { cardShownNote: 'CARD' })
    const cards: DeviceCard[] = []
    const shown = await tool.execute({ action: 'handoff', args: { reason: 'captcha' } }, { owner: 'u', showCard: (card) => { cards.push(card); return true } })
    expect(JSON.parse((shown.content[0] as { text: string }).text)).toMatchObject({ status: 'handed_off', url: 'https://cloud.sandbank.dev/v2/p/tok123/' })
    expect((shown.content[0] as { text: string }).text).toContain('CARD')
    expect(cards[0]).toMatchObject({ kind: 'phone', device: 'phone', label: 'captcha', expiresAt: '2026-11-03T12:00:00Z' })
    expect(cards[0]!.id).toMatch(/^cc_[0-9a-f]{20}$/)

    const plain = await tool.execute({ action: 'secure_input', args: { label: 'SMS code' } }, { owner: 'u' })
    expect((plain.content[0] as { text: string }).text).toContain('Send the link to this user only')
  })

  it('refuses steps while the user has the phone', async () => {
    const server = fakeV2({ takeoverActive: true })
    const result = await createPhoneTool(client(server)).execute({ action: 'tap', args: { x: 1, y: 1 } }, { owner: 'u' })
    expect(result.isError).toBe(true)
    expect((result.content[0] as { text: string }).text).toContain('handed_off')
  })

  it('reports a failed step and an unknown action as errors', async () => {
    const server = fakeV2({ actStatus: 422 })
    const tool = createPhoneTool(client(server))
    const failed = await tool.execute({ action: 'tap', args: { ref: 'e9' } }, { owner: 'u' })
    expect(failed.isError).toBe(true)
    expect((failed.content[0] as { text: string }).text).toContain('no such element')
    expect((await tool.execute({ action: 'format_disk' }, { owner: 'u' })).isError).toBe(true)
  })

  it('says the phone is booting instead of waiting forever', async () => {
    const server = fakeV2({ bootPolls: 100 })
    const devices = new SandbankDevices({ apiKey: 'k', fetch: server.fetchImpl, bootPollMs: { phone: 0 }, bootPolls: 2 })
    const result = await createPhoneTool(devices).execute({ action: 'screen' }, { owner: 'u' })
    expect(JSON.parse((result.content[0] as { text: string }).text).status).toBe('booting')
  })

  it('stop stops an existing phone without starting one', async () => {
    const server = fakeV2()
    const tool = createPhoneTool(client(server))
    await tool.execute({ action: 'stop' }, { owner: 'nobody' })
    expect(server.calls.some((c) => c.method === 'POST')).toBe(false)
    await tool.execute({ action: 'screen' }, { owner: 'u' })
    await tool.execute({ action: 'stop' }, { owner: 'u' })
    expect(server.sessions.get('phone:u')?.state).toBe('stopped')
  })

  it('resume ends the takeover and looks again', async () => {
    const server = fakeV2({ takeoverActive: true })
    const result = await createPhoneTool(client(server)).execute({ action: 'resume' }, { owner: 'u' })
    expect(server.calls.some((c) => c.method === 'DELETE' && c.path.endsWith('/takeover'))).toBe(true)
    expect(result.content[1]?.type).toBe('image')
  })
})

describe('computer and command tools', () => {
  it('computer has no ui action and uses the desktop session', async () => {
    const server = fakeV2()
    const tool = createComputerTool(client(server), { settleMs: 0 })
    expect(JSON.stringify(tool.parameters)).not.toContain('"ui"')
    await tool.execute({ action: 'open_url', args: { url: 'https://example.com' }, look: 'none' }, { owner: 'u' })
    expect(server.calls[0]?.body).toMatchObject({ kind: 'desktop' })
  })

  it('command tool clamps the timeout and keeps the output tail', async () => {
    const server = fakeV2()
    const result = await createCommandTool(client(server)).execute({ command: 'echo hi', timeoutSeconds: 99_999 }, { owner: 'u' })
    expect(JSON.parse((result.content[0] as { text: string }).text)).toMatchObject({ status: 'ran', exitCode: 0, stdout: 'hi\n' })
    expect(server.calls.find((c) => c.path.endsWith('/exec'))?.body?.timeout_s).toBe(615)
    expect((await createCommandTool(client(server)).execute({ command: ' ' }, { owner: 'u' })).isError).toBe(true)
  })

  it('createDeviceTools builds the named tools', () => {
    const tools = createDeviceTools(client(fakeV2()), ['computer', 'browser', 'phone', 'command'])
    expect(tools.map((t) => t.name)).toEqual(['computer', 'browser', 'phone', 'run_command'])
  })
})

describe('access', () => {
  it('defaults to allowlist and asks the list only there', async () => {
    expect(accessMode(undefined)).toBe('allowlist')
    expect(accessMode(' ALL ')).toBe('all')
    expect(accessMode('off')).toBe('off')
    let asked = 0
    const listed = async () => { asked++; return true }
    expect(await deviceAccessAllowed('all', 'u', listed)).toBe(true)
    expect(await deviceAccessAllowed('off', 'u', listed)).toBe(false)
    expect(await deviceAccessAllowed('allowlist', '', listed)).toBe(false)
    expect(asked).toBe(0)
    expect(await deviceAccessAllowed('allowlist', 'u', listed)).toBe(true)
  })

  it('refuses a table name that is not an identifier', () => {
    const db = { prepare: () => { throw new Error('unused') } }
    expect(() => d1Allowlist(db as never, 'x; DROP TABLE y')).toThrow()
    expect(d1Allowlist(db as never, 'device_access').createTableSql).toContain('CREATE TABLE IF NOT EXISTS device_access')
  })
})

describe('adapters', () => {
  it('OpenAI: tool definition, call and messages', async () => {
    const server = fakeV2()
    const tools = [createPhoneTool(client(server), { settleMs: 0 })]
    expect(toOpenAITool(tools[0]!).function.name).toBe('phone')
    const result = await runDeviceToolCall(tools, 'phone', '{"action":"screen"}', { owner: 'u' })
    const messages = toChatMessages('call_1', 'phone', result!)
    expect(messages[0]).toMatchObject({ role: 'tool', tool_call_id: 'call_1' })
    expect(messages[1]?.role).toBe('user')
    expect(toChatMessages('call_1', 'phone', result!, { images: false })).toHaveLength(1)
    expect(await runDeviceToolCall(tools, 'nope', '{}', { owner: 'u' })).toBeNull()
  })

  it('Pi: wraps parameters and maps output', async () => {
    const server = fakeV2()
    const pi = toPiTool(createPhoneTool(client(server), { settleMs: 0 }), () => ({ owner: 'u' }))
    expect((pi.parameters as { properties: Record<string, unknown> }).properties.action).toBeDefined()
    const out = await pi.execute({ action: 'screen' })
    expect(out.output[1]?.type).toBe('image')
    expect(out.isError).toBeUndefined()
  })
})

describe('DeviceApiError', () => {
  it('keeps status and code', () => {
    const error = new DeviceApiError(503, 'capacity', 'full', 5)
    expect(error).toMatchObject({ status: 503, code: 'capacity', retryAfter: 5, name: 'DeviceApiError' })
  })
})
