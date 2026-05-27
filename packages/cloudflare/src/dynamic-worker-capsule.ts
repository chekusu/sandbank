/// <reference types="@cloudflare/workers-types" />

import type {
  ListOptions,
  QueryResult,
  ReadOptions,
  WorkspaceAdapter,
  WorkspaceData,
  WorkspaceEntry,
  WorkspaceQuery,
  WriteOptions,
} from '@sandbank.dev/workspace'

export interface DynamicWorkerLoader {
  load(code: DynamicWorkerCode): DynamicWorkerStub | Promise<DynamicWorkerStub>
  get(id: string, getCodeCallback: () => Promise<DynamicWorkerCode>): DynamicWorkerStub | Promise<DynamicWorkerStub>
}

export interface DynamicWorkerStub {
  getEntrypoint?(name?: string | null, options?: { limits?: DynamicWorkerResourceLimits }): DynamicWorkerEntrypoint
  fetch?(request: Request): Promise<Response>
}

export interface DynamicWorkerEntrypoint {
  fetch(request: Request): Promise<Response>
}

export interface DynamicWorkerModule {
  js?: string
  cjs?: string
  py?: string
  text?: string
  data?: ArrayBuffer
  json?: unknown
}

export type DynamicWorkerModuleContent = string | DynamicWorkerModule

export interface DynamicWorkerCode {
  compatibilityDate: string
  compatibilityFlags?: string[]
  mainModule: string
  modules: Record<string, DynamicWorkerModuleContent>
  env?: Record<string, unknown>
  globalOutbound?: unknown | null
  tails?: unknown[]
  limits?: DynamicWorkerResourceLimits
}

export type DynamicWorkerEgressPolicy =
  | { mode: 'deny' }
  | { mode: 'inherit' }
  | { mode: 'gateway'; binding: unknown; allowedHosts?: string[] }

export interface DynamicWorkerResourceLimits {
  cpuMs?: number
  subRequests?: number
}

export type DynamicWorkerExecutionEvent =
  | {
    type: 'stream.chunk'
    text: string
  }
  | {
    type: 'log'
    level: 'debug' | 'info' | 'warn' | 'error'
    message: string
    metadata?: Record<string, unknown>
  }
  | {
    type: 'artifact'
    name: string
    path: string
    mediaType?: string
    size?: number
    metadata?: Record<string, unknown>
  }

export interface DynamicWorkerWorkspaceScope {
  readablePaths?: string[]
  writablePaths?: string[]
  allowList?: boolean
  allowQuery?: boolean
  artifactRoot?: string
}

export interface DynamicWorkerCapsuleConfig {
  loader: DynamicWorkerLoader
  compatibilityDate?: string
  compatibilityFlags?: string[]
  bindingAllowlist?: string[]
  defaultEgress?: DynamicWorkerEgressPolicy
  defaultLimits?: DynamicWorkerResourceLimits
  defaultTimeoutMs?: number
}

export interface DynamicWorkerInvokeOptions {
  id?: string
  mainModule?: string
  code: string
  request?: Request
  bindings?: Record<string, unknown>
  bindingAllowlist?: string[]
  egress?: DynamicWorkerEgressPolicy
  tails?: unknown[]
  limits?: DynamicWorkerResourceLimits
  timeoutMs?: number
  workspace?: WorkspaceAdapter
  workspaceBindingName?: string
  runtimeBindingName?: string
  workspaceScope?: DynamicWorkerWorkspaceScope
  onEvent?: (event: DynamicWorkerExecutionEvent) => void | Promise<void>
}

export interface DynamicWorkerInvokeResult {
  status: number
  headers: Record<string, string>
  body: string
}

const DEFAULT_COMPATIBILITY_DATE = '2026-05-01'
const DEFAULT_MAIN_MODULE = 'index.js'

export class DynamicWorkerExecutionCapsule {
  private readonly loader: DynamicWorkerLoader
  private readonly compatibilityDate: string
  private readonly compatibilityFlags?: string[]
  private readonly bindingAllowlist: string[]
  private readonly defaultEgress: DynamicWorkerEgressPolicy
  private readonly defaultLimits?: DynamicWorkerResourceLimits
  private readonly defaultTimeoutMs?: number

  constructor(config: DynamicWorkerCapsuleConfig) {
    this.loader = config.loader
    this.compatibilityDate = config.compatibilityDate ?? DEFAULT_COMPATIBILITY_DATE
    this.compatibilityFlags = config.compatibilityFlags
    this.bindingAllowlist = config.bindingAllowlist ?? []
    this.defaultEgress = config.defaultEgress ?? { mode: 'deny' }
    this.defaultLimits = config.defaultLimits
    this.defaultTimeoutMs = config.defaultTimeoutMs
  }

  async invoke(options: DynamicWorkerInvokeOptions): Promise<DynamicWorkerInvokeResult> {
    const timeoutMs = options.timeoutMs ?? this.defaultTimeoutMs
    return withTimeout((async () => {
      const emit = async (event: DynamicWorkerExecutionEvent) => {
        await options.onEvent?.(event)
      }
      const bindings = { ...(options.bindings ?? {}) }
      const bindingAllowlist = [...(options.bindingAllowlist ?? this.bindingAllowlist)]

      if (options.workspace) {
        const workspaceBindingName = options.workspaceBindingName ?? 'SANDBANK_WORKSPACE'
        const runtimeBindingName = options.runtimeBindingName ?? 'SANDBANK_RUNTIME'
        bindings[workspaceBindingName] = createDynamicWorkerWorkspaceBinding(options.workspace, options.workspaceScope)
        bindings[runtimeBindingName] = createDynamicWorkerRuntimeBinding(options.workspace, options.workspaceScope, emit)
        bindingAllowlist.push(workspaceBindingName, runtimeBindingName)
      }

      const limits = options.limits ?? this.defaultLimits
      const code = buildDynamicWorkerCode({
        compatibilityDate: this.compatibilityDate,
        compatibilityFlags: this.compatibilityFlags,
        bindingAllowlist: unique(bindingAllowlist),
        code: options.code,
        mainModule: options.mainModule ?? DEFAULT_MAIN_MODULE,
        bindings,
        egress: options.egress ?? this.defaultEgress,
        tails: options.tails,
        limits,
      })
      const stub = options.id
        ? await this.loader.get(options.id, async () => code)
        : await this.loader.load(code)
      const entrypoint = getEntrypoint(stub, limits)
      const response = await entrypoint.fetch(options.request ?? new Request('https://dynamic-worker.sandbank.dev/'))
      return {
        status: response.status,
        headers: headersToObject(response.headers),
        body: await readResponseBody(response, emit),
      }
    })(), timeoutMs)
  }
}

export function buildDynamicWorkerCode(options: {
  compatibilityDate?: string
  compatibilityFlags?: string[]
  bindingAllowlist?: string[]
  code: string
  mainModule?: string
  bindings?: Record<string, unknown>
  egress?: DynamicWorkerEgressPolicy
  tails?: unknown[]
  limits?: DynamicWorkerResourceLimits
}): DynamicWorkerCode {
  const egress = options.egress ?? { mode: 'deny' }
  const env = pickBindings(options.bindings ?? {}, options.bindingAllowlist ?? [])
  if (egress.mode === 'gateway') {
    env['SANDBANK_EGRESS_ALLOW_HOSTS'] = egress.allowedHosts ?? []
  }
  return {
    compatibilityDate: options.compatibilityDate ?? DEFAULT_COMPATIBILITY_DATE,
    compatibilityFlags: options.compatibilityFlags,
    mainModule: options.mainModule ?? DEFAULT_MAIN_MODULE,
    modules: {
      [options.mainModule ?? DEFAULT_MAIN_MODULE]: options.code,
    },
    env,
    globalOutbound: toGlobalOutbound(egress),
    tails: options.tails,
    limits: options.limits,
  }
}

function pickBindings(bindings: Record<string, unknown>, allowlist: string[]): Record<string, unknown> {
  if (allowlist.length === 0) return {}
  return Object.fromEntries(
    Object.entries(bindings).filter(([name]) => allowlist.includes(name)),
  )
}

function toGlobalOutbound(policy: DynamicWorkerEgressPolicy): unknown | null | undefined {
  if (policy.mode === 'deny') return null
  if (policy.mode === 'gateway') return policy.binding
  return undefined
}

export function createDynamicWorkerWorkspaceBinding(
  workspace: WorkspaceAdapter,
  scope: DynamicWorkerWorkspaceScope = {},
) {
  return {
    async list(path: string, opts?: ListOptions): Promise<WorkspaceEntry[]> {
      if (scope.allowList === false) throw new Error('Dynamic Worker workspace list is not allowed')
      assertPathAllowed(path, scope.readablePaths, 'read')
      return workspace.list(path, opts)
    },
    async read(path: string, opts?: ReadOptions): Promise<WorkspaceData> {
      assertPathAllowed(path, scope.readablePaths, 'read')
      return workspace.read(path, opts)
    },
    async write(path: string, data: WorkspaceData, opts?: WriteOptions): Promise<WorkspaceEntry> {
      assertPathAllowed(path, scope.writablePaths, 'write')
      return workspace.write(path, data, opts)
    },
    async append(path: string, data: WorkspaceData): Promise<WorkspaceEntry> {
      assertPathAllowed(path, scope.writablePaths, 'write')
      return workspace.append(path, data)
    },
    async query(query: WorkspaceQuery): Promise<QueryResult> {
      if (!scope.allowQuery) throw new Error('Dynamic Worker workspace query is not allowed')
      if (query.path) assertPathAllowed(query.path, scope.readablePaths, 'read')
      return workspace.query(query)
    },
  }
}

export function createDynamicWorkerRuntimeBinding(
  workspace: WorkspaceAdapter,
  scope: DynamicWorkerWorkspaceScope = {},
  emit?: (event: DynamicWorkerExecutionEvent) => void | Promise<void>,
) {
  const artifactRoot = normalizePath(scope.artifactRoot ?? '/artifacts')
  return {
    async log(
      level: 'debug' | 'info' | 'warn' | 'error',
      message: string,
      metadata?: Record<string, unknown>,
    ): Promise<void> {
      await emit?.({ type: 'log', level, message, metadata })
    },
    async artifact(
      name: string,
      data: WorkspaceData,
      metadata: { mediaType?: string } & Record<string, unknown> = {},
    ): Promise<{ name: string; path: string; mediaType?: string; size: number }> {
      const safeName = sanitizeArtifactName(name)
      const path = `${artifactRoot}/${safeName}`
      assertPathAllowed(path, scope.writablePaths, 'write')
      await workspace.write(path, data)
      const size = byteLength(data)
      const event = {
        type: 'artifact' as const,
        name: safeName,
        path,
        mediaType: metadata.mediaType,
        size,
        metadata,
      }
      await emit?.(event)
      return { name: safeName, path, mediaType: metadata.mediaType, size }
    },
  }
}

function getEntrypoint(stub: DynamicWorkerStub, limits?: DynamicWorkerResourceLimits): DynamicWorkerEntrypoint {
  const entrypoint = stub.getEntrypoint?.(null, limits ? { limits } : undefined)
  if (entrypoint) return entrypoint
  if (stub.fetch) return { fetch: request => stub.fetch!(request) }
  throw new Error('Dynamic Worker stub does not expose fetch() or getEntrypoint().fetch().')
}

async function readResponseBody(
  response: Response,
  emit: (event: DynamicWorkerExecutionEvent) => Promise<void>,
): Promise<string> {
  if (!response.body) return ''
  const reader = response.body.getReader()
  const decoder = new TextDecoder()
  let body = ''
  while (true) {
    const { done, value } = await reader.read()
    if (value) {
      const text = decoder.decode(value, { stream: !done })
      body += text
      if (text) await emit({ type: 'stream.chunk', text })
    }
    if (done) {
      const tail = decoder.decode()
      if (tail) {
        body += tail
        await emit({ type: 'stream.chunk', text: tail })
      }
      return body
    }
  }
}

class DynamicWorkerTimeoutError extends Error {
  readonly code = 'DYNAMIC_WORKER_TIMEOUT'

  constructor(timeoutMs: number) {
    super(`Dynamic Worker invocation timed out after ${timeoutMs}ms`)
  }
}

function withTimeout<T>(promise: Promise<T>, timeoutMs: number | undefined): Promise<T> {
  if (!timeoutMs || timeoutMs <= 0) return promise
  let timer: ReturnType<typeof setTimeout> | undefined
  const timeout = new Promise<never>((_, reject) => {
    timer = setTimeout(() => reject(new DynamicWorkerTimeoutError(timeoutMs)), timeoutMs)
  })
  return Promise.race([promise, timeout]).finally(() => {
    if (timer) clearTimeout(timer)
  })
}

function headersToObject(headers: Headers): Record<string, string> {
  const out: Record<string, string> = {}
  headers.forEach((value, key) => {
    out[key] = value
  })
  return out
}

function assertPathAllowed(path: string, allowedPaths: string[] | undefined, action: 'read' | 'write'): void {
  if (!allowedPaths?.length) return
  const normalized = normalizePath(path)
  const allowed = allowedPaths.some(prefix => {
    const normalizedPrefix = normalizePath(prefix)
    return normalized === normalizedPrefix || normalized.startsWith(`${normalizedPrefix}/`)
  })
  if (!allowed) throw new Error(`Dynamic Worker workspace ${action} denied for ${normalized}`)
}

function normalizePath(input: string): string {
  const parts: string[] = []
  for (const part of input.replace(/\\/g, '/').split('/')) {
    if (!part || part === '.') continue
    if (part === '..') parts.pop()
    else parts.push(part)
  }
  return `/${parts.join('/')}`
}

function sanitizeArtifactName(name: string): string {
  const parts = name
    .replace(/\\/g, '/')
    .split('/')
    .filter(part => part && part !== '.' && part !== '..')
  return parts.join('/') || 'artifact'
}

function byteLength(data: WorkspaceData): number {
  return typeof data === 'string' ? new TextEncoder().encode(data).byteLength : data.byteLength
}

function unique(values: string[]): string[] {
  return [...new Set(values)]
}
