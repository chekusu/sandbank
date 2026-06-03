import type {
  CreateConfig,
  ProviderImageCatalog,
  SandboxProvider,
} from '@sandbank.dev/core'
import {
  WorkspaceError,
  type WorkspaceAdapter,
} from '@sandbank.dev/workspace'
import {
  runWorkspaceSandboxTask,
  type SandboxSchedulerCapability,
  type WorkspaceSandboxConsistencyOptions,
  type WorkspaceSandboxPreflightConfig,
  type WorkspaceSandboxTaskResult,
} from './provider-scheduler.js'

export const CLOUDFLARE_TOOL_RESOURCE_KINDS = [
  'cloudflare.d1',
  'cloudflare.kv',
  'cloudflare.r2',
  'cloudflare.durable_object',
  'cloudflare.queue',
  'cloudflare.vectorize',
  'cloudflare.workflows',
  'cloudflare.worker',
  'cloudflare.ai',
] as const

export type ToolUsePermissionAction = string
export type ToolUseResourceKind =
  | typeof CLOUDFLARE_TOOL_RESOURCE_KINDS[number]
  | 'dynamic_worker.execution'
  | 'external.search'
  | 'http.egress'
  | 'runtime.javascript'
  | 'runtime.python'
  | 'sandbox.provider'
  | 'workspace.path'
  | (string & {})

export interface ToolUseResourceRef {
  kind: ToolUseResourceKind
  id?: string
  scope?: string
}

export interface ToolUseResourceRequirement extends ToolUseResourceRef {
  action: ToolUsePermissionAction
}

export interface ToolUseResourceGrant extends ToolUseResourceRef {
  actions?: ToolUsePermissionAction[]
}

export interface ToolUseApprovalRule {
  tool?: string
  kind?: ToolUseResourceKind
  id?: string
  action?: ToolUsePermissionAction
}

export interface ToolUsePolicy {
  allowedTools?: string[]
  resources?: ToolUseResourceGrant[]
  requireApproval?: ToolUseApprovalRule[]
}

export interface ToolUseRequest<Input = unknown> {
  tool: string
  input?: Input
  reason?: string
  metadata?: Record<string, unknown>
}

export interface SandboxProviderToolCandidate {
  provider: SandboxProvider
  capabilities?: Iterable<SandboxSchedulerCapability | string>
  priority?: number
  createConfig?: CreateConfig
}

export type ToolUseCodeExecutionEvent =
  | { type: 'stream.chunk'; text: string }
  | { type: 'log'; level: 'debug' | 'info' | 'warn' | 'error'; message: string; metadata?: Record<string, unknown> }
  | { type: 'artifact'; name: string; path: string; mediaType?: string; size?: number; metadata?: Record<string, unknown> }

export type ToolUseCodeExecutionEgressPolicy =
  | { mode: 'deny' }
  | { mode: 'inherit' }
  | { mode: 'gateway'; binding: unknown; allowedHosts?: string[] }

export interface ToolUseCodeExecutionCapsule {
  invoke(options: {
    id?: string
    code: string
    request: Request
    workspace: WorkspaceAdapter
    workspaceScope: {
      readablePaths: string[]
      writablePaths: string[]
      allowList: boolean
      allowQuery: boolean
      artifactRoot: string
    }
    timeoutMs?: number
    limits?: { cpuMs?: number; subRequests?: number }
    bindings?: Record<string, unknown>
    bindingAllowlist?: string[]
    egress?: ToolUseCodeExecutionEgressPolicy
    onEvent?: (event: ToolUseCodeExecutionEvent) => void | Promise<void>
  }): Promise<{ status: number; headers: Record<string, string>; body: string }>
}

export interface ToolUseExecutionContext {
  agentId: string
  workspaceId: string
  runId: string
  modelId: string
  workspace: WorkspaceAdapter
  policy: ToolUsePolicy
  sandboxProviders?: SandboxProviderToolCandidate[]
  imageCatalog?: ProviderImageCatalog
  sandboxConsistency?: WorkspaceSandboxConsistencyOptions
  sandboxPreflight?: WorkspaceSandboxPreflightConfig | false
  dynamicWorker?: ToolUseCodeExecutionCapsule
  approved?: boolean
}

export interface ToolUseAuthorization {
  ok: boolean
  tool: string
  resources: ToolUseResourceRequirement[]
  requiresApproval: boolean
  approvalReason?: string
  error?: string
  errorCode?: WorkspaceError['code']
}

export interface ToolUseDefinition<Input = unknown, Output = unknown> {
  name: string
  description?: string
  resourceRequirements?:
    | ToolUseResourceRequirement[]
    | ((input: Input, context: ToolUseExecutionContext) => ToolUseResourceRequirement[] | Promise<ToolUseResourceRequirement[]>)
  handler: (input: Input, context: ToolUseExecutionContext) => Promise<Output>
}

export class ToolUseRegistry {
  private readonly definitions = new Map<string, ToolUseDefinition<any, any>>()

  register<Input = unknown, Output = unknown>(definition: ToolUseDefinition<Input, Output>): this {
    if (this.definitions.has(definition.name)) {
      throw new Error(`Tool is already registered: ${definition.name}`)
    }
    this.definitions.set(definition.name, definition)
    return this
  }

  get(name: string): ToolUseDefinition | undefined {
    return this.definitions.get(name)
  }

  list(): ToolUseDefinition[] {
    return [...this.definitions.values()]
  }

  async authorize(
    request: ToolUseRequest,
    context: ToolUseExecutionContext,
  ): Promise<ToolUseAuthorization> {
    const definition = this.definitions.get(request.tool)
    if (!definition) {
      return {
        ok: false,
        tool: request.tool,
        resources: [],
        requiresApproval: false,
        error: `Tool is not registered: ${request.tool}`,
        errorCode: 'UNSUPPORTED',
      }
    }

    if (context.policy.allowedTools?.length && !context.policy.allowedTools.includes(request.tool)) {
      return {
        ok: false,
        tool: request.tool,
        resources: [],
        requiresApproval: false,
        error: `Agent policy does not allow tool ${request.tool}`,
        errorCode: 'LOCKED',
      }
    }

    const resources = await resolveResourceRequirements(definition, request.input, context)
    for (const resource of resources) {
      if (!resourceAllowed(resource, context.policy.resources)) {
        return {
          ok: false,
          tool: request.tool,
          resources,
          requiresApproval: false,
          error: `Agent policy does not allow ${formatResourceRequirement(resource)}`,
          errorCode: 'LOCKED',
        }
      }
    }

    const approvalResources = resources.filter(resource => requiresApproval(request.tool, resource, context.policy.requireApproval))
    const approvalReason = approvalResources.length > 0
      ? `tool.use requires approval for ${approvalResources.map(formatResourceRequirement).join(', ')}`
      : undefined

    return {
      ok: true,
      tool: request.tool,
      resources,
      requiresApproval: approvalResources.length > 0,
      approvalReason,
    }
  }

  async execute<Output = unknown>(
    request: ToolUseRequest,
    context: ToolUseExecutionContext,
  ): Promise<Output> {
    const authorization = await this.authorize(request, context)
    if (!authorization.ok) {
      throw new WorkspaceError(authorization.errorCode ?? 'LOCKED', authorization.error ?? `Tool use denied: ${request.tool}`)
    }
    if (authorization.requiresApproval && !context.approved) {
      throw new WorkspaceError('LOCKED', authorization.approvalReason ?? `Tool use requires approval: ${request.tool}`)
    }
    const definition = this.definitions.get(request.tool)
    if (!definition) throw new WorkspaceError('UNSUPPORTED', `Tool is not registered: ${request.tool}`)
    return definition.handler(request.input, context) as Promise<Output>
  }
}

export interface CloudflareResourceToolInput {
  resource: ToolUseResourceRef
  operation?: string
  payload?: unknown
}

export function createCloudflareResourceTool<Output = unknown>(
  action: ToolUsePermissionAction,
  handler: (input: CloudflareResourceToolInput, context: ToolUseExecutionContext) => Promise<Output>,
): ToolUseDefinition<CloudflareResourceToolInput, Output> {
  return {
    name: `cloudflare.resource.${action}`,
    description: `Use a Cloudflare resource with ${action} permission.`,
    resourceRequirements: input => [{
      kind: input.resource.kind,
      id: input.resource.id,
      scope: input.resource.scope,
      action,
    }],
    handler,
  }
}

export interface SearchCodeRunToolInput {
  code: string
  queries?: string[]
  allowedHosts?: string[]
  searchProvider?: string
  artifactRoot?: string
  resultArtifactName?: string
  timeoutMs?: number
  limits?: { cpuMs?: number; subRequests?: number }
  metadata?: Record<string, unknown>
}

export interface SearchCodeProviderContext {
  agentId: string
  workspaceId: string
  runId: string
  modelId: string
  allowedHosts: string[]
  metadata?: Record<string, unknown>
}

export interface SearchCodeProvider {
  provider?: string
  search?: (query: string, context: SearchCodeProviderContext) => Promise<unknown>
  fetchJson?: (url: string, init: RequestInit | undefined, context: SearchCodeProviderContext) => Promise<unknown>
  fetchText?: (url: string, init: RequestInit | undefined, context: SearchCodeProviderContext) => Promise<string>
}

export interface SearchCodeRunToolOptions {
  name?: string
  description?: string
  dynamicWorker?: ToolUseCodeExecutionCapsule
  search?: SearchCodeProvider
  defaultTimeoutMs?: number
  defaultArtifactRoot?: string | ((context: ToolUseExecutionContext) => string)
  defaultResultArtifactName?: string
}

export interface SearchCodeRunToolOutput {
  status: number
  headers: Record<string, string>
  body: string
  result?: unknown
  artifacts: Array<Extract<ToolUseCodeExecutionEvent, { type: 'artifact' }>>
}

export function createSearchCodeRunTool(
  options: SearchCodeRunToolOptions = {},
): ToolUseDefinition<SearchCodeRunToolInput, SearchCodeRunToolOutput> {
  return {
    name: options.name ?? 'search.code.run',
    description: options.description ?? 'Run bounded JavaScript search code in a Dynamic Worker capsule.',
    resourceRequirements: (input, context) => {
      const artifactRoot = resolveSearchCodeArtifactRoot(input, context, options)
      const searchProvider = input.searchProvider ?? options.search?.provider
      return [
        { kind: 'dynamic_worker.execution', action: 'execute' },
        { kind: 'runtime.javascript', action: 'execute' },
        { kind: 'external.search', id: searchProvider, action: 'query' },
        ...normalizeAllowedHosts(input.allowedHosts).map(host => ({ kind: 'http.egress' as const, id: host, action: 'fetch' })),
        { kind: 'workspace.path', scope: artifactRoot, action: 'write' },
      ]
    },
    async handler(input, context) {
      if (!input || typeof input.code !== 'string' || !input.code.trim()) {
        throw new WorkspaceError('INVALID_PATH', 'search.code.run requires a non-empty JavaScript code body.')
      }
      const dynamicWorker = options.dynamicWorker ?? context.dynamicWorker
      if (!dynamicWorker) {
        throw new WorkspaceError('UNSUPPORTED', 'search.code.run requires a Dynamic Worker execution capsule.')
      }

      const artifactRoot = resolveSearchCodeArtifactRoot(input, context, options)
      const resultArtifactName = sanitizeSearchCodeArtifactName(input.resultArtifactName ?? options.defaultResultArtifactName ?? 'search-code-result.json')
      const allowedHosts = normalizeAllowedHosts(input.allowedHosts)
      const events: ToolUseCodeExecutionEvent[] = []
      const result = await dynamicWorker.invoke({
        code: buildSearchCodeWorkerCode(input.code),
        request: new Request('https://dynamic-worker.sandbank.dev/search-code/run', {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({
            agentId: context.agentId,
            workspaceId: context.workspaceId,
            runId: context.runId,
            modelId: context.modelId,
            queries: input.queries ?? [],
            allowedHosts,
            artifactRoot,
            resultArtifactName,
            metadata: input.metadata ?? {},
          }),
        }),
        workspace: context.workspace,
        workspaceScope: {
          readablePaths: [artifactRoot],
          writablePaths: [artifactRoot],
          allowList: false,
          allowQuery: false,
          artifactRoot,
        },
        timeoutMs: input.timeoutMs ?? options.defaultTimeoutMs,
        limits: input.limits,
        bindings: {
          SANDBANK_SEARCH: createSearchCodeBinding(input, context, options, allowedHosts),
        },
        bindingAllowlist: ['SANDBANK_SEARCH'],
        egress: { mode: 'deny' },
        onEvent: event => {
          events.push(event)
        },
      })

      if (result.status < 200 || result.status >= 400) {
        throw new WorkspaceError('CONFLICT', `search.code.run failed with HTTP ${result.status}.`)
      }
      const parsed = parseJsonObject(result.body)
      return {
        status: result.status,
        headers: result.headers,
        body: result.body,
        result: parsed && 'result' in parsed ? parsed.result : parsed,
        artifacts: events.filter((event): event is Extract<ToolUseCodeExecutionEvent, { type: 'artifact' }> => event.type === 'artifact'),
      }
    },
  }
}

function createSearchCodeBinding(
  input: SearchCodeRunToolInput,
  context: ToolUseExecutionContext,
  options: SearchCodeRunToolOptions,
  allowedHosts: string[],
) {
  const provider = options.search
  const providerContext: SearchCodeProviderContext = {
    agentId: context.agentId,
    workspaceId: context.workspaceId,
    runId: context.runId,
    modelId: context.modelId,
    allowedHosts,
    metadata: input.metadata,
  }
  const fetchText = async (url: string, init?: RequestInit): Promise<string> => {
    assertSearchCodeHostAllowed(url, allowedHosts)
    if (!provider?.fetchText) throw new Error('search.code.run fetchText provider is not configured.')
    return provider.fetchText(url, init, providerContext)
  }

  return {
    provider: input.searchProvider ?? provider?.provider,
    allowedHosts,
    async search(query: string): Promise<unknown> {
      if (!provider?.search) throw new Error('search.code.run search provider is not configured.')
      return provider.search(query, providerContext)
    },
    async fetchJson(url: string, init?: RequestInit): Promise<unknown> {
      if (provider?.fetchJson) {
        assertSearchCodeHostAllowed(url, allowedHosts)
        return provider.fetchJson(url, init, providerContext)
      }
      const text = await fetchText(url, init)
      try {
        return JSON.parse(text) as unknown
      } catch (err) {
        throw new Error(`search.code.run fetchJson could not parse JSON from ${url}: ${err instanceof Error ? err.message : 'unknown parse error'}`)
      }
    },
    async fetchText(url: string, init?: RequestInit): Promise<string> {
      return fetchText(url, init)
    },
  }
}

function buildSearchCodeWorkerCode(code: string): string {
  return `
async function __sandbankSearchCodeRun(ctx) {
${indentSearchCode(code)}
}

async function __sandbankArtifact(runtime, name, data, metadata = {}) {
  const payload = typeof data === "string" || data instanceof Uint8Array
    ? data
    : JSON.stringify(data ?? null, null, 2);
  return runtime.artifact(name, payload, metadata);
}

export default {
  async fetch(request, env) {
    const input = await request.json();
    const runtime = env.SANDBANK_RUNTIME;
    const ctx = {
      input,
      search: env.SANDBANK_SEARCH,
      workspace: env.SANDBANK_WORKSPACE,
      runtime: {
        log: (...args) => runtime.log(...args),
        artifact: (name, data, metadata) => __sandbankArtifact(runtime, name, data, metadata),
      },
    };
    const result = await __sandbankSearchCodeRun(ctx);
    await ctx.runtime.artifact(input.resultArtifactName || "search-code-result.json", result ?? null, {
      mediaType: "application/json",
      source: "search.code.run",
    });
    return new Response(JSON.stringify({ ok: true, result: result ?? null }), {
      headers: { "Content-Type": "application/json" },
    });
  }
}
`.trim()
}

function indentSearchCode(code: string): string {
  return code.split('\n').map(line => `  ${line}`).join('\n')
}

function resolveSearchCodeArtifactRoot(
  input: SearchCodeRunToolInput,
  context: ToolUseExecutionContext,
  options: SearchCodeRunToolOptions,
): string {
  const configured = input.artifactRoot
    ?? (typeof options.defaultArtifactRoot === 'function'
      ? options.defaultArtifactRoot(context)
      : options.defaultArtifactRoot)
    ?? `/runs/${context.runId}/artifacts/search-code`
  return normalizeToolPath(configured)
}

function normalizeAllowedHosts(hosts: string[] | undefined): string[] {
  return [...new Set(
    (hosts ?? [])
      .map(host => normalizeHost(host))
      .filter((host): host is string => Boolean(host)),
  )]
}

function normalizeHost(value: string): string | undefined {
  const trimmed = value.trim()
  if (!trimmed) return undefined
  try {
    return new URL(trimmed.includes('://') ? trimmed : `https://${trimmed}`).host.toLowerCase()
  } catch {
    return trimmed.toLowerCase()
  }
}

function assertSearchCodeHostAllowed(url: string, allowedHosts: string[]): void {
  const host = normalizeHost(url)
  if (!host || !allowedHosts.includes(host)) {
    throw new Error(`search.code.run egress host is not allowed: ${host ?? url}`)
  }
}

function sanitizeSearchCodeArtifactName(name: string): string {
  const safe = name
    .split(/[\\/]/)
    .filter(Boolean)
    .pop()
    ?.replace(/[^A-Za-z0-9._-]/g, '-')
    .slice(0, 128)
  return safe || 'search-code-result.json'
}

function normalizeToolPath(path: string): string {
  const trimmed = path.trim()
  const prefixed = trimmed.startsWith('/') ? trimmed : `/${trimmed}`
  return prefixed.replace(/\/+/g, '/').replace(/\/$/, '') || '/'
}

function parseJsonObject(value: string): Record<string, unknown> | undefined {
  try {
    const parsed = JSON.parse(value) as unknown
    return parsed && typeof parsed === 'object' && !Array.isArray(parsed)
      ? parsed as Record<string, unknown>
      : undefined
  } catch {
    return undefined
  }
}

export interface SandboxPythonToolInput {
  path: string
  args?: string[]
  python?: string
  image?: string
  provider?: string
  createConfig?: CreateConfig
  mount?: {
    mode?: 'snapshot' | 'live'
    workspacePath?: string
    sandboxPath?: string
  }
  requiredCapabilities?: SandboxSchedulerCapability[]
  timeoutMs?: number
  consistency?: WorkspaceSandboxConsistencyOptions
  destroySandbox?: boolean
  preflight?: WorkspaceSandboxPreflightConfig | false
}

export function createSandboxPythonTool(): ToolUseDefinition<SandboxPythonToolInput, WorkspaceSandboxTaskResult> {
  return {
    name: 'sandbox.python',
    description: 'Run a Python file from the workspace on an authorized sandbox provider.',
    resourceRequirements: input => [
      { kind: 'sandbox.provider', id: input.provider, action: 'execute' },
      { kind: 'runtime.python', action: 'execute' },
    ],
    async handler(input, context) {
      const providers = filterSandboxProviders(context.sandboxProviders ?? [], context.policy, input.provider)
      if (providers.length === 0) {
        throw new WorkspaceError(
          'LOCKED',
          `Agent policy does not allow sandbox provider ${input.provider ?? 'from configured candidates'}`,
        )
      }
      return runWorkspaceSandboxTask({
        runId: context.runId,
        workspace: context.workspace,
        providers: providers.map(candidate => ({
          ...candidate,
          capabilities: candidate.capabilities as Iterable<SandboxSchedulerCapability> | undefined,
        })),
        imageCatalog: context.imageCatalog,
        consistency: input.consistency ?? context.sandboxConsistency,
        destroySandbox: input.destroySandbox,
        preflight: input.preflight ?? context.sandboxPreflight,
        task: {
          kind: 'python',
          path: input.path,
          args: input.args,
          python: input.python,
          image: input.image,
          createConfig: input.createConfig,
          mount: input.mount,
          requiredCapabilities: input.requiredCapabilities,
          timeoutMs: input.timeoutMs,
        },
      })
    },
  }
}

export function filterSandboxProviders(
  providers: SandboxProviderToolCandidate[],
  policy: ToolUsePolicy,
  requestedProvider?: string,
): SandboxProviderToolCandidate[] {
  return providers.filter(candidate => sandboxProviderAllowed(candidate.provider.name, policy, requestedProvider))
}

function sandboxProviderAllowed(providerName: string, policy: ToolUsePolicy, requestedProvider?: string): boolean {
  if (requestedProvider && providerName !== requestedProvider) return false
  return resourceAllowed({ kind: 'sandbox.provider', id: providerName, action: 'execute' }, policy.resources)
}

async function resolveResourceRequirements(
  definition: ToolUseDefinition<any, any>,
  input: unknown,
  context: ToolUseExecutionContext,
): Promise<ToolUseResourceRequirement[]> {
  const requirements = definition.resourceRequirements
  if (!requirements) return []
  if (typeof requirements !== 'function') return requirements
  return requirements(input, context)
}

function resourceAllowed(resource: ToolUseResourceRequirement, grants: ToolUseResourceGrant[] | undefined): boolean {
  if (!grants?.length) return false
  return grants.some(grant => resourceGrantMatches(grant, resource))
}

function resourceGrantMatches(grant: ToolUseResourceGrant, resource: ToolUseResourceRequirement): boolean {
  if (grant.kind !== '*' && grant.kind !== resource.kind) return false
  if (resource.id && grant.id && grant.id !== '*' && grant.id !== resource.id) return false
  if (grant.scope && resource.scope && grant.scope !== '*' && !resource.scope.startsWith(grant.scope)) return false
  if (grant.actions?.length && !grant.actions.includes('*') && !grant.actions.includes(resource.action)) return false
  return true
}

function requiresApproval(
  tool: string,
  resource: ToolUseResourceRequirement,
  rules: ToolUseApprovalRule[] | undefined,
): boolean {
  if (!rules?.length) return false
  return rules.some(rule => {
    if (rule.tool && rule.tool !== tool) return false
    if (rule.kind && rule.kind !== resource.kind) return false
    if (rule.id && rule.id !== resource.id) return false
    if (rule.action && rule.action !== resource.action) return false
    return true
  })
}

function formatResourceRequirement(resource: ToolUseResourceRequirement): string {
  const id = resource.id ? `:${resource.id}` : ''
  const scope = resource.scope ? ` ${resource.scope}` : ''
  return `${resource.kind}${id} ${resource.action}${scope}`
}
