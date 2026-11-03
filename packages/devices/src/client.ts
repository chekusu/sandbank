/**
 * Client for Sandbank Cloud /v2 sessions: one cloud desktop, browser or phone per end user.
 * API reference: chekusu/cloud.sandbank.dev docs/plans/2026-11-03-v2-sessions-api.md.
 *
 * Runs anywhere `fetch` does (Cloudflare Workers, Node 20+, Bun). Holds no state: POST /v2/sessions is
 * idempotent per (tenant, owner, kind), so nothing needs to be stored on the product side.
 */

export const DEFAULT_BASE_URL = 'https://cloud.sandbank.dev'

export type DeviceKind = 'desktop' | 'browser' | 'phone'
export type DeviceState = 'booting' | 'ready' | 'stopped' | 'error'

export interface DeviceSession {
  id: string
  kind: DeviceKind
  owner: string
  state: DeviceState
  created_at?: string
  last_active_at?: string
  idle_timeout_s?: number
  takeover?: { expires_at: string; opened?: boolean }
  error?: { code: string; message: string }
}

export interface Screenshot {
  /** base64 JPEG */
  image: string
  width: number
  height: number
}

export interface UiTree {
  tree: string
  width: number
  height: number
}

export interface DeviceLink {
  url: string
  expiresAt: string
}

export interface ExecOutcome {
  sessionId: string
  exitCode: number | null
  stdout: string
  stderr: string
  timedOut: boolean
}

export interface ApiResponse<T> {
  status: number
  data: T
  text: string
}

export interface SandbankDevicesOptions {
  /** Tenant API key (sbk_…). */
  apiKey: string
  /** Default https://cloud.sandbank.dev */
  baseUrl?: string
  fetch?: typeof fetch
  /** Delay between polls of a booting session; default 2000 ms for phones, 1000 ms otherwise. */
  bootPollMs?: Partial<Record<DeviceKind, number>>
  /** How many polls `ensure` makes before giving up on a booting session; default 60. */
  bootPolls?: number
}

/** The env names products use for the tenant key and API origin. */
export interface SandbankDevicesEnv {
  SANDBANK_API_TOKEN?: string
  SANDBANK_API_URL?: string
}

/** An error answer from /v2: `{ error, code, retry_after? }`. */
export class DeviceApiError extends Error {
  constructor(
    readonly status: number,
    readonly code: string | null,
    message: string,
    readonly retryAfter?: number,
  ) {
    super(message)
    this.name = 'DeviceApiError'
  }
}

/** Link prefixes Sandbank Cloud serves takeover and secure input pages under. */
export const LINK_PREFIXES = ['/v2/p/', '/phonebox/p/'] as const

const DEFAULT_POLL_MS: Record<DeviceKind, number> = { desktop: 1_000, browser: 1_000, phone: 2_000 }

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms))
}

function errorText(data: unknown, status: number): string {
  if (data && typeof data === 'object') {
    const error = (data as { error?: unknown }).error
    if (typeof error === 'string') return error
    if (error && typeof error === 'object' && typeof (error as { message?: unknown }).message === 'string') return (error as { message: string }).message
  }
  return `Sandbank Cloud answered ${status}`
}

export class SandbankDevices {
  readonly baseUrl: string
  private readonly apiKey: string
  private readonly fetchImpl: typeof fetch
  private readonly pollMs: Record<DeviceKind, number>
  private readonly polls: number

  constructor(options: SandbankDevicesOptions) {
    if (!options.apiKey?.trim()) throw new Error('SandbankDevices needs an apiKey')
    this.apiKey = options.apiKey.trim()
    this.baseUrl = (options.baseUrl?.trim() || DEFAULT_BASE_URL).replace(/\/+$/, '')
    // Wrapped, not passed bare: calling the global fetch as a method of another object throws "Illegal invocation" in Workers.
    const given = options.fetch
    this.fetchImpl = given ?? ((input, init) => fetch(input, init))
    this.pollMs = { ...DEFAULT_POLL_MS, ...options.bootPollMs }
    this.polls = options.bootPolls ?? 60
  }

  /** A client from SANDBANK_API_TOKEN / SANDBANK_API_URL, or null when no key is set (devices off). */
  static fromEnv(env: SandbankDevicesEnv, options: Omit<SandbankDevicesOptions, 'apiKey' | 'baseUrl'> = {}): SandbankDevices | null {
    const apiKey = env.SANDBANK_API_TOKEN?.trim()
    return apiKey ? new SandbankDevices({ ...options, apiKey, baseUrl: env.SANDBANK_API_URL }) : null
  }

  /**
   * One /v2 call. Never throws for an HTTP error; the caller reads `status`. `retry` repeats a 502/503 once after
   * 2 s (the proxy answers those while a service restarts); use it only for calls that are safe to repeat.
   */
  async request<T = Record<string, unknown>>(
    method: string,
    path: string,
    body?: unknown,
    options: { timeoutMs?: number; retry?: boolean } = {},
  ): Promise<ApiResponse<T>> {
    const send = () => this.fetchImpl(`${this.baseUrl}/v2${path}`, {
      method,
      headers: {
        Authorization: `Bearer ${this.apiKey}`,
        ...(body === undefined ? {} : { 'Content-Type': 'application/json' }),
      },
      ...(body === undefined ? {} : { body: JSON.stringify(body) }),
      signal: AbortSignal.timeout(options.timeoutMs ?? 30_000),
    })
    let response = await send()
    if (options.retry && (response.status === 502 || response.status === 503)) {
      await sleep(2_000)
      response = await send()
    }
    const text = await response.text()
    let data: unknown = {}
    try {
      data = text ? JSON.parse(text) : {}
    } catch {
      data = { error: `${response.status} ${text.replace(/\s+/g, ' ').slice(0, 200)}` }
    }
    return { status: response.status, data: data as T, text }
  }

  private async must<T>(method: string, path: string, body?: unknown, options?: { timeoutMs?: number; retry?: boolean }): Promise<T> {
    const answer = await this.request<T>(method, path, body, options)
    if (answer.status >= 400) {
      const data = answer.data as { code?: unknown; retry_after?: unknown }
      throw new DeviceApiError(
        answer.status,
        typeof data?.code === 'string' ? data.code : null,
        errorText(answer.data, answer.status),
        typeof data?.retry_after === 'number' ? data.retry_after : undefined,
      )
    }
    return answer.data
  }

  /** API path of one session. */
  sessionPath(id: string): string {
    return `/sessions/${encodeURIComponent(id)}`
  }

  /**
   * The owner's session of this kind, created or started if needed, waiting while it boots (up to `bootPolls`
   * polls). Returns the session in whatever state it reached; throws if it went to `error`.
   */
  async ensure(kind: DeviceKind, owner: string, options: { idleTimeoutS?: number; wait?: boolean } = {}): Promise<DeviceSession> {
    let session = await this.must<DeviceSession>('POST', '/sessions', {
      kind,
      owner,
      ...(options.idleTimeoutS ? { idle_timeout_s: options.idleTimeoutS } : {}),
    }, { retry: true })
    if (!session?.id) throw new DeviceApiError(502, null, 'Sandbank Cloud returned no session id')
    const id = session.id
    for (let i = 0; options.wait !== false && session.state !== 'ready' && i < this.polls; i++) {
      if (session.state === 'error') break
      await sleep(this.pollMs[kind])
      session = await this.must<DeviceSession>('GET', this.sessionPath(id), undefined, { retry: true })
    }
    if (session.state === 'error') {
      throw new DeviceApiError(502, session.error?.code ?? 'session_error', `the cloud ${kind} failed to start${session.error?.message ? `: ${session.error.message}` : ''}`)
    }
    return { ...session, id }
  }

  /**
   * Warm-up, for each user message: starts a stopped session, never waits for it, never throws.
   * Owners with no session are left alone (their first use creates one).
   */
  async warm(kind: DeviceKind, owner: string): Promise<void> {
    await this.request('POST', '/sessions/warm', { kind, owner }, { timeoutMs: 10_000 }).catch(() => {})
  }

  async get(id: string): Promise<DeviceSession> {
    return this.must('GET', this.sessionPath(id), undefined, { retry: true })
  }

  async list(filter: { owner?: string; kind?: DeviceKind } = {}): Promise<DeviceSession[]> {
    const query = new URLSearchParams()
    if (filter.owner) query.set('owner', filter.owner)
    if (filter.kind) query.set('kind', filter.kind)
    const qs = query.toString()
    const data = await this.must<{ sessions?: DeviceSession[] } | DeviceSession[]>('GET', `/sessions${qs ? `?${qs}` : ''}`, undefined, { retry: true })
    return Array.isArray(data) ? data : data.sessions ?? []
  }

  /** Stops the session; its data stays. */
  async stop(id: string): Promise<void> {
    await this.must('DELETE', this.sessionPath(id))
  }

  /** Stops the owner's session of this kind, if any (its data stays). */
  async stopOwner(kind: DeviceKind, owner: string): Promise<boolean> {
    const sessions = await this.list({ owner, kind })
    let stopped = false
    for (const session of sessions) {
      if (session.state === 'stopped') continue
      await this.stop(session.id)
      stopped = true
    }
    return stopped
  }

  /** Deletes the session and its data. */
  async purge(id: string): Promise<void> {
    await this.must('DELETE', `${this.sessionPath(id)}?purge=true`)
  }

  /** Deletes every session of this kind (or every kind) the owner has, with their data. Used for account deletion and resets. */
  async purgeOwner(owner: string, kind?: DeviceKind): Promise<number> {
    const sessions = await this.list({ owner, ...(kind ? { kind } : {}) })
    for (const session of sessions) await this.purge(session.id)
    return sessions.length
  }

  async screen(id: string): Promise<Screenshot> {
    return this.must('GET', `${this.sessionPath(id)}/screen`, undefined, { retry: true })
  }

  async ui(id: string): Promise<UiTree> {
    return this.must('GET', `${this.sessionPath(id)}/ui`, undefined, { retry: true })
  }

  /** One input step. Throws DeviceApiError: 409 while the user has the device (code `takeover`) or it boots, 422 when the step failed. */
  async act(id: string, action: string, args: Record<string, unknown> = {}): Promise<{ ok: boolean; error?: string }> {
    return this.must('POST', `${this.sessionPath(id)}/act`, { ...args, action })
  }

  /** Runs a command on a desktop or browser session. `cmd` as a string runs under `sh -c`. */
  async exec(id: string, cmd: string | string[], timeoutS: number): Promise<{ exitCode: number | null; stdout: string; stderr: string; timedOut: boolean }> {
    const answer = await this.request<{ exit_code?: number; stdout?: string; stderr?: string }>(
      'POST',
      `${this.sessionPath(id)}/exec`,
      { cmd, timeout_s: timeoutS },
      // The server caps a command at 600 s; leave room past that for the answer.
      { timeoutMs: (Math.min(timeoutS, 600) + 45) * 1_000 },
    )
    if (answer.status === 504) return { exitCode: null, stdout: '', stderr: 'Sandbank Cloud timed out the command', timedOut: true }
    if (answer.status >= 400) throw new DeviceApiError(answer.status, null, `Sandbank Cloud exec failed (${answer.status}): ${answer.text.slice(0, 300)}`)
    const exitCode = typeof answer.data.exit_code === 'number' ? answer.data.exit_code : null
    return { exitCode, stdout: answer.data.stdout ?? '', stderr: answer.data.stderr ?? '', timedOut: timedOutExit(exitCode) }
  }

  /** A one-time link where the user sees the live device and drives it. Steps are refused (409) until it ends. */
  async takeover(id: string): Promise<DeviceLink> {
    return this.link(await this.must('POST', `${this.sessionPath(id)}/takeover`, {}))
  }

  /** Ends a takeover. One nobody has opened yet stays unless `force`. */
  async endTakeover(id: string, force = false): Promise<void> {
    await this.must('DELETE', `${this.sessionPath(id)}/takeover${force ? '?force=true' : ''}`)
  }

  /** A one-time page where the user types a secret into the focused field (or `target`); the caller never sees it. */
  async secureInput(id: string, input: { label: string; submit?: boolean; target?: string }): Promise<DeviceLink> {
    return this.link(await this.must('POST', `${this.sessionPath(id)}/secure-input`, {
      label: input.label,
      submit: input.submit === true,
      ...(input.target ? { target: input.target } : {}),
    }))
  }

  async secureInputStatus(id: string): Promise<Record<string, unknown>> {
    return this.must('GET', `${this.sessionPath(id)}/secure-input`, undefined, { retry: true })
  }

  /**
   * The link, if it is one of Sandbank Cloud's own takeover or secure input pages on this client's host;
   * otherwise null. Only such links may be shown to users.
   */
  trustedLink(url: unknown): string | null {
    return trustedDeviceLink(this.baseUrl, url)
  }

  private link(data: { url?: unknown; expires_at?: unknown; expiresAt?: unknown }): DeviceLink {
    const url = this.trustedLink(data.url)
    const expiresAt = typeof data.expires_at === 'string' ? data.expires_at : typeof data.expiresAt === 'string' ? data.expiresAt : null
    if (!url || !expiresAt) throw new DeviceApiError(502, 'bad_link', 'Sandbank Cloud returned no usable link')
    return { url, expiresAt }
  }
}

/** See SandbankDevices.trustedLink. */
export function trustedDeviceLink(baseUrl: string, url: unknown): string | null {
  if (typeof url !== 'string') return null
  try {
    const link = new URL(url)
    const root = new URL(baseUrl)
    if (link.protocol !== 'https:' || link.host !== root.host) return null
    if (!LINK_PREFIXES.some((prefix) => link.pathname.startsWith(prefix))) return null
    return link.toString()
  } catch {
    return null
  }
}

/** `timeout` exits 124 when it stopped the command, 137 when it had to kill it. */
export function timedOutExit(exitCode: number | null): boolean {
  return exitCode === 124 || exitCode === 137
}

/** A command under `timeout`, so it reports first and keeps partial output; the server's own limit is the backstop. */
export function wrapWithTimeout(command: string, timeoutSeconds: number): string[] {
  return ['timeout', '--kill-after=5', String(timeoutSeconds), 'bash', '-lc', command]
}

/**
 * Runs a shell command on the owner's cloud desktop in /workspace (files stay there while the session lives;
 * an idle session stops and keeps them). `reset` deletes the desktop and its files first.
 */
export async function runOnDesktop(
  client: SandbankDevices,
  owner: string,
  input: { command: string; timeoutSeconds: number; reset?: boolean },
): Promise<ExecOutcome> {
  if (input.reset) await client.purgeOwner(owner, 'desktop').catch(() => 0)
  const session = await client.ensure('desktop', owner)
  if (session.state !== 'ready') throw new Error('the cloud computer is still starting; try again in a moment')
  // Exec starts as root in /; /workspace is the working directory.
  const command = `mkdir -p /workspace && cd /workspace && ${input.command}`
  const ran = await client.exec(session.id, wrapWithTimeout(command, input.timeoutSeconds), input.timeoutSeconds + 15)
  return { sessionId: session.id, ...ran }
}
