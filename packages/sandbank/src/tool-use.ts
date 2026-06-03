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
export type ToolUseResourceKind = typeof CLOUDFLARE_TOOL_RESOURCE_KINDS[number] | 'sandbox.provider' | 'runtime.python' | (string & {})

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
