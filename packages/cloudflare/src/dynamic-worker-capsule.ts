/// <reference types="@cloudflare/workers-types" />

export interface DynamicWorkerLoader {
  load(code: DynamicWorkerCode): DynamicWorkerStub | Promise<DynamicWorkerStub>
  get(id: string, getCodeCallback: () => Promise<DynamicWorkerCode>): DynamicWorkerStub | Promise<DynamicWorkerStub>
}

export interface DynamicWorkerStub {
  getEntrypoint?(): DynamicWorkerEntrypoint
  fetch?(request: Request): Promise<Response>
}

export interface DynamicWorkerEntrypoint {
  fetch(request: Request): Promise<Response>
}

export interface DynamicWorkerModule {
  name: string
  content: string
  type?: 'esm' | 'text' | 'data' | 'compiled-wasm'
}

export interface DynamicWorkerCode {
  compatibilityDate: string
  compatibilityFlags?: string[]
  mainModule: string
  modules: DynamicWorkerModule[]
  env?: Record<string, unknown>
  globalOutbound?: unknown | null
  tails?: unknown[]
}

export type DynamicWorkerEgressPolicy =
  | { mode: 'deny' }
  | { mode: 'inherit' }
  | { mode: 'gateway'; binding: unknown; allowedHosts?: string[] }

export interface DynamicWorkerCapsuleConfig {
  loader: DynamicWorkerLoader
  compatibilityDate?: string
  compatibilityFlags?: string[]
  bindingAllowlist?: string[]
  defaultEgress?: DynamicWorkerEgressPolicy
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

  constructor(config: DynamicWorkerCapsuleConfig) {
    this.loader = config.loader
    this.compatibilityDate = config.compatibilityDate ?? DEFAULT_COMPATIBILITY_DATE
    this.compatibilityFlags = config.compatibilityFlags
    this.bindingAllowlist = config.bindingAllowlist ?? []
    this.defaultEgress = config.defaultEgress ?? { mode: 'deny' }
  }

  async invoke(options: DynamicWorkerInvokeOptions): Promise<DynamicWorkerInvokeResult> {
    const code = buildDynamicWorkerCode({
      compatibilityDate: this.compatibilityDate,
      compatibilityFlags: this.compatibilityFlags,
      bindingAllowlist: options.bindingAllowlist ?? this.bindingAllowlist,
      code: options.code,
      mainModule: options.mainModule ?? DEFAULT_MAIN_MODULE,
      bindings: options.bindings,
      egress: options.egress ?? this.defaultEgress,
      tails: options.tails,
    })
    const stub = options.id
      ? await this.loader.get(options.id, async () => code)
      : await this.loader.load(code)
    const entrypoint = getEntrypoint(stub)
    const response = await entrypoint.fetch(options.request ?? new Request('https://dynamic-worker.sandbank.dev/'))
    return {
      status: response.status,
      headers: headersToObject(response.headers),
      body: await response.text(),
    }
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
    modules: [{
      name: options.mainModule ?? DEFAULT_MAIN_MODULE,
      content: options.code,
      type: 'esm',
    }],
    env,
    globalOutbound: toGlobalOutbound(egress),
    tails: options.tails,
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

function getEntrypoint(stub: DynamicWorkerStub): DynamicWorkerEntrypoint {
  const entrypoint = stub.getEntrypoint?.()
  if (entrypoint) return entrypoint
  if (stub.fetch) return { fetch: request => stub.fetch!(request) }
  throw new Error('Dynamic Worker stub does not expose fetch() or getEntrypoint().fetch().')
}

function headersToObject(headers: Headers): Record<string, string> {
  const out: Record<string, string> = {}
  headers.forEach((value, key) => {
    out[key] = value
  })
  return out
}
