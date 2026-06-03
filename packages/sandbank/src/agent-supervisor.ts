import {
  WorkspaceError,
  type AgentOp,
  type Checkpoint,
  type WorkspaceAdapter,
  type WorkspaceData,
  type WorkspaceQuery,
} from '@sandbank.dev/workspace'
import type { ProviderImageCatalog } from '@sandbank.dev/core'
import type {
  SandboxProviderToolCandidate,
  ToolUseAuthorization,
  ToolUsePolicy,
  ToolUseRegistry,
  ToolUseRequest,
} from './tool-use.js'
import type {
  WorkspaceSandboxConsistencyOptions,
  WorkspaceSandboxPreflightConfig,
} from './provider-scheduler.js'

export type AgentRunStatus = 'running' | 'completed' | 'failed'
export type AgentSupervisorOpAction =
  | 'workspace.read'
  | 'workspace.write'
  | 'workspace.append'
  | 'workspace.query'
  | 'function.invoke'
  | 'tool.use'

export interface AgentRunIdentity {
  agentId: string
  workspaceId: string
  runId: string
  modelId: string
}

export interface AgentRunState extends AgentRunIdentity {
  status: AgentRunStatus
  startedAt: string
  completedAt?: string
  failedAt?: string
  checkpoint?: Checkpoint
  error?: string
}

export interface AgentSupervisorPolicy {
  allowedOps?: AgentSupervisorOpAction[]
  writablePaths?: string[]
  readablePaths?: string[]
  query?: 'none' | 'sql' | 'all'
  functions?: string[]
  requireApproval?: AgentSupervisorOpAction[]
}

export interface AgentApprovalRequest {
  run: AgentRunState
  op: AgentSupervisorOp
  reason: string
}

export interface AgentSupervisorEvent {
  type: 'state' | 'audit' | 'approval' | 'checkpoint'
  label: string
  detail?: string
  raw?: unknown
}

export interface AgentSupervisorContext<Input = unknown> {
  run: AgentRunState
  input: Input
  workspace: WorkspaceAdapter
  allowedOps: AgentSupervisorOpAction[]
  capabilities: WorkspaceAdapter['capabilities']
  executeOp: (op: AgentSupervisorOp) => Promise<unknown>
  audit: (action: string, metadata?: Record<string, unknown>) => Promise<void>
  emit: (event: AgentSupervisorEvent) => Promise<void>
}

export interface AgentSupervisorModelResult {
  text: string
  ops?: AgentSupervisorOp[]
  metadata?: Record<string, unknown>
}

export interface AgentSupervisorRunOptions<Input = unknown> {
  input: Input
  modelLoop: (context: AgentSupervisorContext<Input>) => Promise<AgentSupervisorModelResult>
  onEvent?: (event: AgentSupervisorEvent) => Promise<void>
  publicRunRoot?: string
}

export interface AgentSupervisorRunResult {
  run: AgentRunState
  text: string
  checkpoint?: Checkpoint
}

export type AgentSupervisorOp =
  | {
    action: 'workspace.read'
    path: string
    metadata?: Record<string, unknown>
  }
  | {
    action: 'workspace.write' | 'workspace.append'
    path: string
    data: WorkspaceData
    metadata?: Record<string, unknown>
  }
  | {
    action: 'workspace.query'
    query: WorkspaceQuery
    metadata?: Record<string, unknown>
  }
  | {
    action: 'function.invoke'
    name: string
    input?: unknown
    options?: { fs9Scope?: string; timeoutMs?: number; env?: Record<string, string> }
    metadata?: Record<string, unknown>
  }
  | {
    action: 'tool.use'
    request: ToolUseRequest
    metadata?: Record<string, unknown>
  }

export interface AgentSupervisorToolUseConfig {
  registry: ToolUseRegistry
  policy?: ToolUsePolicy
  sandboxProviders?: SandboxProviderToolCandidate[]
  imageCatalog?: ProviderImageCatalog
  sandboxConsistency?: WorkspaceSandboxConsistencyOptions
  sandboxPreflight?: WorkspaceSandboxPreflightConfig | false
}

export interface AgentSupervisorConfig {
  agentId: string
  workspace: WorkspaceAdapter
  modelId: string
  id?: () => string
  now?: () => Date
  policy?: AgentSupervisorPolicy
  approvalHook?: (request: AgentApprovalRequest) => Promise<boolean | 'approved' | 'rejected'>
  checkpointBeforeRun?: boolean
  auditPath?: string
  toolUse?: AgentSupervisorToolUseConfig
}

type InvokableWorkspace = WorkspaceAdapter & {
  invokeFunction(
    name: string,
    input: unknown,
    options?: { fs9Scope?: string; timeoutMs?: number; env?: Record<string, string> },
  ): Promise<unknown>
}

const DEFAULT_ALLOWED_OPS: AgentSupervisorOpAction[] = [
  'workspace.read',
  'workspace.write',
  'workspace.append',
  'workspace.query',
]

export class AgentSupervisor {
  private readonly agentId: string
  private readonly workspace: WorkspaceAdapter
  private readonly modelId: string
  private readonly id: () => string
  private readonly now: () => Date
  private readonly policy: Required<Pick<AgentSupervisorPolicy, 'allowedOps' | 'query' | 'requireApproval'>>
    & Omit<AgentSupervisorPolicy, 'allowedOps' | 'query' | 'requireApproval'>
  private readonly approvalHook?: AgentSupervisorConfig['approvalHook']
  private readonly checkpointBeforeRun: boolean
  private readonly auditPath: string
  private readonly toolUse?: AgentSupervisorToolUseConfig

  constructor(config: AgentSupervisorConfig) {
    this.agentId = config.agentId
    this.workspace = config.workspace
    this.modelId = config.modelId
    this.id = config.id ?? (() => createId('run'))
    this.now = config.now ?? (() => new Date())
    this.policy = {
      allowedOps: config.policy?.allowedOps ?? defaultAllowedOps(config.workspace, Boolean(config.toolUse)),
      query: config.policy?.query ?? 'all',
      requireApproval: config.policy?.requireApproval ?? [],
      writablePaths: config.policy?.writablePaths,
      readablePaths: config.policy?.readablePaths,
      functions: config.policy?.functions,
    }
    this.approvalHook = config.approvalHook
    this.checkpointBeforeRun = config.checkpointBeforeRun ?? true
    this.auditPath = config.auditPath ?? '/.sandbank/agent-ops.jsonl'
    this.toolUse = config.toolUse
  }

  async run<Input>(options: AgentSupervisorRunOptions<Input>): Promise<AgentSupervisorRunResult> {
    let run = this.createRun()
    const emit = async (event: AgentSupervisorEvent) => {
      await options.onEvent?.(event)
    }
    const publicRunRoot = options.publicRunRoot ? normalizePath(options.publicRunRoot) : undefined

    try {
      await this.writeRunState(run)
      await this.audit(run, 'run.started', { modelId: this.modelId })
      await emit({ type: 'state', label: 'run.started', detail: run.runId, raw: run })

      if (this.checkpointBeforeRun && this.workspace.capabilities.checkpoint) {
        const checkpoint = await this.workspace.checkpoint(`agent:${this.agentId}:run:${run.runId}:before`)
        run = { ...run, checkpoint }
        await this.writeRunState(run)
        await this.audit(run, 'run.checkpoint', { checkpoint: checkpoint.ref })
        await emit({ type: 'checkpoint', label: 'checkpoint.created', detail: checkpoint.ref, raw: checkpoint })
      }

      await this.writeJson(`/agents/${this.agentId}/runs/${run.runId}/input.json`, {
        run,
        input: options.input,
      })
      if (publicRunRoot) {
        await this.writeJson(`${publicRunRoot}/request.json`, {
          runId: run.runId,
          agentId: this.agentId,
          modelId: this.modelId,
          createdAt: run.startedAt,
          input: options.input,
        })
        await this.workspace.append('/runs/index.jsonl', `${JSON.stringify({
          id: run.runId,
          agentId: this.agentId,
          model: this.modelId,
          createdAt: run.startedAt,
          status: 'started',
        })}\n`)
      }

      const context: AgentSupervisorContext<Input> = {
        run,
        input: options.input,
        workspace: this.workspace,
        allowedOps: [...this.policy.allowedOps],
        capabilities: this.workspace.capabilities,
        executeOp: op => this.executeOp(run, op, emit),
        audit: (action, metadata) => this.audit(run, action, metadata),
        emit,
      }
      const result = await options.modelLoop(context)
      for (const op of result.ops ?? []) {
        await this.executeOp(run, op, emit)
      }

      await this.writeJson(`/agents/${this.agentId}/runs/${run.runId}/result.json`, {
        text: result.text,
        metadata: result.metadata,
      })
      if (publicRunRoot) {
        await this.workspace.write(`${publicRunRoot}/assistant.md`, result.text)
        await this.workspace.append('/runs/index.jsonl', `${JSON.stringify({
          id: run.runId,
          completedAt: this.now().toISOString(),
          status: 'completed',
          outputBytes: new TextEncoder().encode(result.text).byteLength,
        })}\n`)
      }

      run = { ...run, status: 'completed', completedAt: this.now().toISOString() }
      await this.writeRunState(run)
      await this.audit(run, 'run.completed', { outputBytes: new TextEncoder().encode(result.text).byteLength })
      await emit({ type: 'state', label: 'run.completed', detail: run.runId, raw: run })
      return { run, text: result.text, checkpoint: run.checkpoint }
    } catch (err) {
      run = {
        ...run,
        status: 'failed',
        failedAt: this.now().toISOString(),
        error: err instanceof Error ? err.message : 'Agent supervisor run failed.',
      }
      await this.writeRunState(run).catch(() => undefined)
      await this.audit(run, 'run.failed', { error: run.error }).catch(() => undefined)
      await emit({ type: 'state', label: 'run.failed', detail: run.error, raw: run }).catch(() => undefined)
      throw err
    }
  }

  async executeOp(run: AgentRunState, op: AgentSupervisorOp, emit?: (event: AgentSupervisorEvent) => Promise<void>): Promise<unknown> {
    this.assertAllowed(run, op)
    const toolAuthorization = op.action === 'tool.use'
      ? await this.authorizeToolUse(run, op)
      : undefined
    const approvalReason = toolAuthorization?.requiresApproval
      ? toolAuthorization.approvalReason
      : undefined
    const approvalRequired = this.policy.requireApproval.includes(op.action) || Boolean(toolAuthorization?.requiresApproval)
    let approved = false
    if (approvalRequired) {
      approved = await this.requestApproval(run, op, emit, approvalReason)
      if (!approved) {
        throw new WorkspaceError('LOCKED', `Agent operation rejected by approval hook: ${op.action}`)
      }
    }

    let result: unknown
    if (op.action === 'workspace.read') {
      if (!this.workspace.capabilities.read) throw unsupportedCapability(op.action)
      result = await this.workspace.read(op.path)
    } else if (op.action === 'workspace.write') {
      if (!this.workspace.capabilities.write) throw unsupportedCapability(op.action)
      result = await this.workspace.write(op.path, op.data)
    } else if (op.action === 'workspace.append') {
      if (!this.workspace.capabilities.append) throw unsupportedCapability(op.action)
      result = await this.workspace.append(op.path, op.data)
    } else if (op.action === 'workspace.query') {
      if (!this.workspace.capabilities.query) throw unsupportedCapability(op.action)
      result = await this.workspace.query(op.query)
    } else if (op.action === 'function.invoke') {
      if (!this.workspace.capabilities.functionRuntime || !isInvokableWorkspace(this.workspace)) {
        throw unsupportedCapability(op.action)
      }
      result = await this.workspace.invokeFunction(op.name, op.input, op.options)
    } else if (op.action === 'tool.use') {
      if (!this.toolUse) throw unsupportedCapability(op.action)
      result = await this.toolUse.registry.execute(op.request, this.toolUseContext(run, approved || !approvalRequired))
    } else {
      throw unsupportedCapability((op as { action: string }).action)
    }

    await this.audit(run, `op.${op.action}`, sanitizeOp(op))
    await emit?.({ type: 'audit', label: op.action, detail: opDetail(op), raw: { op, result } })
    return result
  }

  private createRun(): AgentRunState {
    return {
      agentId: this.agentId,
      workspaceId: this.workspace.id,
      runId: this.id(),
      modelId: this.modelId,
      status: 'running',
      startedAt: this.now().toISOString(),
    }
  }

  private async requestApproval(
    run: AgentRunState,
    op: AgentSupervisorOp,
    emit?: (event: AgentSupervisorEvent) => Promise<void>,
    reason = `${op.action} requires approval`,
  ): Promise<boolean> {
    await emit?.({ type: 'approval', label: 'approval.requested', detail: op.action, raw: op })
    await this.audit(run, 'approval.requested', sanitizeOp(op))
    if (!this.approvalHook) return false
    const result = await this.approvalHook({ run, op, reason })
    const approved = result === true || result === 'approved'
    await this.audit(run, approved ? 'approval.approved' : 'approval.rejected', sanitizeOp(op))
    return approved
  }

  private async authorizeToolUse(
    run: AgentRunState,
    op: Extract<AgentSupervisorOp, { action: 'tool.use' }>,
  ): Promise<ToolUseAuthorization> {
    if (!this.toolUse) throw unsupportedCapability(op.action)
    const authorization = await this.toolUse.registry.authorize(op.request, this.toolUseContext(run, false))
    if (!authorization.ok) {
      throw new WorkspaceError(authorization.errorCode ?? 'LOCKED', authorization.error ?? `Tool use denied: ${op.request.tool}`)
    }
    return authorization
  }

  private toolUseContext(run: AgentRunState, approved: boolean) {
    return {
      agentId: this.agentId,
      workspaceId: this.workspace.id,
      runId: run.runId,
      modelId: this.modelId,
      workspace: this.workspace,
      policy: this.toolUse?.policy ?? {},
      sandboxProviders: this.toolUse?.sandboxProviders,
      imageCatalog: this.toolUse?.imageCatalog,
      sandboxConsistency: this.toolUse?.sandboxConsistency,
      sandboxPreflight: this.toolUse?.sandboxPreflight,
      approved,
    }
  }

  private assertAllowed(run: AgentRunState, op: AgentSupervisorOp): void {
    if (run.status !== 'running') throw new WorkspaceError('LOCKED', `Run ${run.runId} is not running`)
    if (!this.policy.allowedOps.includes(op.action)) {
      throw new WorkspaceError('UNSUPPORTED', `Agent policy does not allow ${op.action}`)
    }
    if ((op.action === 'workspace.write' || op.action === 'workspace.append') && !pathAllowed(op.path, this.policy.writablePaths)) {
      throw new WorkspaceError('LOCKED', `Agent policy does not allow writes to ${normalizePath(op.path)}`)
    }
    if (op.action === 'workspace.read' && !pathAllowed(op.path, this.policy.readablePaths)) {
      throw new WorkspaceError('LOCKED', `Agent policy does not allow reads from ${normalizePath(op.path)}`)
    }
    if (op.action === 'workspace.query') {
      if (this.policy.query === 'none') throw new WorkspaceError('UNSUPPORTED', 'Agent policy does not allow workspace queries')
      if (this.policy.query === 'sql' && !op.query.sql) {
        throw new WorkspaceError('UNSUPPORTED', 'Agent policy only allows SQL workspace queries')
      }
    }
    if (op.action === 'function.invoke' && this.policy.functions && !this.policy.functions.includes(op.name)) {
      throw new WorkspaceError('LOCKED', `Agent policy does not allow function ${op.name}`)
    }
  }

  private async writeRunState(run: AgentRunState): Promise<void> {
    await this.writeJson(`/agents/${this.agentId}/runs/${run.runId}/state.json`, run)
  }

  private async writeJson(path: string, value: unknown): Promise<void> {
    await this.workspace.write(path, JSON.stringify(value, null, 2))
  }

  private async audit(run: AgentRunState, action: string, metadata: Record<string, unknown> = {}): Promise<void> {
    const op: AgentOp = {
      action,
      metadata: {
        ...metadata,
        agentId: this.agentId,
        runId: run.runId,
        modelId: this.modelId,
      },
    }
    if (this.workspace.capabilities.log) {
      await this.workspace.log(op)
      return
    }
    await this.workspace.append(this.auditPath, `${JSON.stringify({
      ...op,
      id: createId('op'),
      createdAt: this.now().toISOString(),
    })}\n`)
  }
}

function defaultAllowedOps(workspace: WorkspaceAdapter, toolUseEnabled = false): AgentSupervisorOpAction[] {
  const ops: AgentSupervisorOpAction[] = workspace.capabilities.functionRuntime
    ? [...DEFAULT_ALLOWED_OPS, 'function.invoke']
    : DEFAULT_ALLOWED_OPS
  if (toolUseEnabled) ops.push('tool.use')
  return ops
}

function unsupportedCapability(action: string): WorkspaceError {
  return new WorkspaceError('UNSUPPORTED', `Workspace does not support ${action}`)
}

function isInvokableWorkspace(workspace: WorkspaceAdapter): workspace is InvokableWorkspace {
  return typeof (workspace as { invokeFunction?: unknown }).invokeFunction === 'function'
}

function pathAllowed(path: string, allowedPaths: string[] | undefined): boolean {
  if (!allowedPaths?.length) return true
  const normalized = normalizePath(path)
  return allowedPaths.some(prefix => {
    const normalizedPrefix = normalizePath(prefix)
    return normalized === normalizedPrefix || normalized.startsWith(`${normalizedPrefix}/`)
  })
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

function sanitizeOp(op: AgentSupervisorOp): Record<string, unknown> {
  if (op.action === 'function.invoke') {
    return {
      action: op.action,
      name: op.name,
      options: {
        fs9Scope: op.options?.fs9Scope,
        timeoutMs: op.options?.timeoutMs,
        envKeys: Object.keys(op.options?.env ?? {}),
      },
      metadata: op.metadata,
    }
  }
  if (op.action === 'workspace.query') {
    return {
      action: op.action,
      query: {
        kind: op.query.kind,
        hasSql: Boolean(op.query.sql),
        path: op.query.path,
        limit: op.query.limit,
      },
      metadata: op.metadata,
    }
  }
  if (op.action === 'tool.use') {
    return {
      action: op.action,
      tool: op.request.tool,
      reason: op.request.reason,
      metadata: op.metadata,
      requestMetadata: op.request.metadata,
    }
  }
  return {
    action: op.action,
    path: 'path' in op ? op.path : undefined,
    metadata: op.metadata,
  }
}

function opDetail(op: AgentSupervisorOp): string {
  if (op.action === 'function.invoke') return op.name
  if (op.action === 'tool.use') return op.request.tool
  if (op.action === 'workspace.query') return op.query.kind ?? (op.query.sql ? 'sql' : 'query')
  return op.path
}

function createId(prefix: string): string {
  return `${prefix}_${Date.now().toString(36)}_${Math.random().toString(36).slice(2, 8)}`
}
