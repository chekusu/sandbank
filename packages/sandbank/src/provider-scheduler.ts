import {
  resolveProviderCreateConfig,
  type Capability,
  type CreateConfig,
  type ExecResult,
  type Sandbox,
  type SandboxProvider,
  type ProviderImageCatalog,
} from '@sandbank.dev/core'
import {
  materializeWorkspaceToSandbox,
  syncWorkspaceFromSandbox,
  type Checkpoint,
  type SyncWorkspaceResult,
  type WorkspaceAdapter,
  type WorkspaceBridgeResult,
  type WorkspaceCapabilities,
  type WorkspaceData,
  type WorkspaceEntry,
  type WorkspaceLock,
} from '@sandbank.dev/workspace'

export type SandboxSchedulerCapability =
  | Capability
  | 'runtime.node'
  | 'runtime.python'
  | 'runtime.codex'
  | 'codex.exec'
  | 'codex.goal'
  | 'workspace.snapshot'
  | 'workspace.live'
  | 'workspace.branch'
  | 'workspace.merge'

export interface SandboxProviderCandidate {
  provider: SandboxProvider
  capabilities?: Iterable<SandboxSchedulerCapability>
  priority?: number
  createConfig?: CreateConfig
}

export type WorkspaceMountMode = 'snapshot' | 'live'
export type WorkspaceConsistencyMode = 'exclusive-lock' | 'branch-merge' | 'none'
export type WorkspaceConflictResolution = 'fail' | 'workspace' | 'sandbox' | 'keep-both'

export interface WorkspaceSandboxMountOptions {
  mode?: WorkspaceMountMode
  workspacePath?: string
  sandboxPath?: string
}

export interface WorkspaceSandboxConsistencyOptions {
  mode?: WorkspaceConsistencyMode
  conflictResolution?: WorkspaceConflictResolution
  lockTtlMs?: number
  deleteMissing?: boolean
  conflictRoot?: string
}

export interface WorkspaceSandboxTaskBase {
  image?: string
  createConfig?: CreateConfig
  mount?: WorkspaceSandboxMountOptions
  requiredCapabilities?: SandboxSchedulerCapability[]
  timeoutMs?: number
}

export interface WorkspaceCommandTask extends WorkspaceSandboxTaskBase {
  kind: 'command'
  command: string
}

export interface WorkspacePythonTask extends WorkspaceSandboxTaskBase {
  kind: 'python'
  path: string
  args?: string[]
  python?: string
}

export interface WorkspaceCodexExecTask extends WorkspaceSandboxTaskBase {
  kind: 'codex.exec'
  prompt?: string
  promptPath?: string
  codex?: string
  dangerouslyBypassApprovalsAndSandbox?: boolean
}

export interface WorkspaceCodexGoalTask extends WorkspaceSandboxTaskBase {
  kind: 'codex.goal'
  goal?: string
  goalPath?: string
  sessionName?: string
  codex?: string
}

export type WorkspaceSandboxTask =
  | WorkspaceCommandTask
  | WorkspacePythonTask
  | WorkspaceCodexExecTask
  | WorkspaceCodexGoalTask

export interface WorkspaceSandboxSchedulerOptions {
  runId?: string
  workspace: WorkspaceAdapter
  providers: SandboxProviderCandidate[]
  task: WorkspaceSandboxTask
  imageCatalog?: ProviderImageCatalog
  consistency?: WorkspaceSandboxConsistencyOptions
  destroySandbox?: boolean
  preflight?: WorkspaceSandboxPreflightConfig | false
}

export interface SelectedSandboxProvider {
  candidate: SandboxProviderCandidate
  provider: SandboxProvider
  capabilities: ReadonlySet<SandboxSchedulerCapability>
  createConfig: CreateConfig
}

export interface WorkspaceMergeConflict {
  path: string
  kind: 'added' | 'modified' | 'removed'
  resolution: WorkspaceConflictResolution
  conflictPath?: string
}

export interface WorkspaceMergeResult {
  applied: number
  skipped: number
  conflicts: WorkspaceMergeConflict[]
}

export interface WorkspaceSandboxCodexResult {
  mode: 'exec' | 'goal'
  promptPath?: string
  goalPath?: string
  sessionName?: string
}

export interface WorkspaceSandboxTaskResult {
  runId: string
  providerName: string
  sandboxId: string
  command?: string
  exec?: ExecResult
  codex?: WorkspaceSandboxCodexResult
  materialized?: WorkspaceBridgeResult
  synced?: SyncWorkspaceResult
  merge?: WorkspaceMergeResult
  preflight?: WorkspaceSandboxPreflightResult
  checkpoints: {
    before?: Checkpoint
    after?: Checkpoint
  }
}

export interface WorkspaceSandboxPreflightConfig {
  /** Create a temporary sandbox and probe image-level tools such as python/codex/tmux/tar/gzip. */
  runtime?: boolean
  /** Additional image probes to run after Sandbank's default probes for the task. */
  probes?: WorkspaceSandboxRuntimeProbe[]
  /** Runtime probe timeout in milliseconds. Defaults to 10 seconds. */
  probeTimeoutMs?: number
  /** Destroy the temporary probe sandbox. Defaults to true. */
  destroySandbox?: boolean
}

export interface WorkspaceSandboxPreflightOptions {
  runId?: string
  workspace: WorkspaceAdapter
  providers: SandboxProviderCandidate[]
  task: WorkspaceSandboxTask
  imageCatalog?: ProviderImageCatalog
  consistency?: WorkspaceSandboxConsistencyOptions
  preflight?: WorkspaceSandboxPreflightConfig
}

export interface WorkspaceSandboxRuntimeProbe {
  name: string
  command: string
  required?: boolean
}

export interface WorkspaceSandboxPreflightCheck {
  kind: 'workspace' | 'provider' | 'runtime'
  name: string
  ok: boolean
  required: boolean
  detail?: string
  command?: string
}

export interface WorkspaceSandboxPreflightResult {
  ok: boolean
  runId: string
  providerName?: string
  createConfig?: CreateConfig
  selected?: SelectedSandboxProvider
  checks: WorkspaceSandboxPreflightCheck[]
  errors: string[]
}

interface FileSnapshot {
  data: Uint8Array
  key: string
}

interface RunContext {
  runId: string
  workspace: WorkspaceAdapter
  task: WorkspaceSandboxTask
  mount: Required<WorkspaceSandboxMountOptions>
  consistency: Required<Omit<WorkspaceSandboxConsistencyOptions, 'conflictRoot'>>
    & Pick<WorkspaceSandboxConsistencyOptions, 'conflictRoot'>
  selected: SelectedSandboxProvider
  destroySandbox: boolean
  preflight?: WorkspaceSandboxPreflightResult
}

type WorkspaceCapabilityName = keyof WorkspaceCapabilities

const textEncoder = new TextEncoder()
const textDecoder = new TextDecoder('utf-8', { fatal: true })
const DEFAULT_LOCK_TTL_MS = 30 * 60 * 1000
const DEFAULT_PREFLIGHT_PROBE_TIMEOUT_MS = 10_000

export function selectSandboxProvider(
  providers: SandboxProviderCandidate[],
  task: WorkspaceSandboxTask,
  imageCatalog: ProviderImageCatalog = {},
): SelectedSandboxProvider {
  const required = requiredCapabilitiesForTask(task)
  const candidates = providers
    .map((candidate, index) => ({ candidate, index }))
    .sort((a, b) => (b.candidate.priority ?? 0) - (a.candidate.priority ?? 0) || a.index - b.index)
  const misses: string[] = []

  for (const { candidate } of candidates) {
    const capabilities = effectiveCapabilities(candidate)
    const missing = required.filter(capability => !capabilities.has(capability))
    if (missing.length > 0) {
      misses.push(`${candidate.provider.name} missing ${missing.join(', ')}`)
      continue
    }

    return {
      candidate,
      provider: candidate.provider,
      capabilities,
      createConfig: resolveProviderCreateConfig(
        createConfigForTask(candidate.createConfig, task),
        candidate.provider.name,
        imageCatalog,
      ),
    }
  }

  const requiredList = required.length > 0 ? required.join(', ') : 'none'
  throw new Error(`No sandbox provider can satisfy task "${task.kind}". Required: ${requiredList}. ${misses.join('; ')}`)
}

export async function runWorkspaceSandboxTask(
  options: WorkspaceSandboxSchedulerOptions,
): Promise<WorkspaceSandboxTaskResult> {
  const runId = options.runId ?? createRunId()
  const preflight = options.preflight === false
    ? undefined
    : await preflightWorkspaceSandboxTask({
      runId,
      workspace: options.workspace,
      providers: options.providers,
      task: options.task,
      imageCatalog: options.imageCatalog,
      consistency: options.consistency,
      preflight: options.preflight ?? { runtime: false },
    })
  if (preflight && !preflight.ok) {
    throw new Error(`Sandbox preflight failed: ${preflight.errors.join('; ')}`)
  }
  const selected = preflight?.selected ?? selectSandboxProvider(options.providers, options.task, options.imageCatalog)
  const mount = normalizeMount(options.task.mount)
  const consistency = normalizeConsistency(options.consistency)
  const destroySandbox = options.destroySandbox ?? options.task.kind !== 'codex.goal'
  const context: RunContext = {
    runId,
    workspace: options.workspace,
    task: options.task,
    mount,
    consistency,
    selected,
    destroySandbox,
    preflight,
  }

  if (consistency.mode === 'exclusive-lock') {
    return withWorkspaceLock(options.workspace, mount.workspacePath, consistency.lockTtlMs, () => runSelectedTask(context))
  }

  return runSelectedTask(context)
}

export async function preflightWorkspaceSandboxTask(
  options: WorkspaceSandboxPreflightOptions,
): Promise<WorkspaceSandboxPreflightResult> {
  const runId = options.runId ?? createRunId()
  const mount = normalizeMount(options.task.mount)
  const consistency = normalizeConsistency(options.consistency)
  const checks: WorkspaceSandboxPreflightCheck[] = []
  const errors: string[] = []

  for (const capability of requiredWorkspaceCapabilitiesForTask(options.task, consistency)) {
    const ok = Boolean(options.workspace.capabilities[capability])
    checks.push({ kind: 'workspace', name: capability, ok, required: true })
    if (!ok) errors.push(`Workspace capability "${capability}" is required for this sandbox task.`)
  }

  if (errors.length > 0) {
    return { ok: false, runId, checks, errors }
  }

  let selected: SelectedSandboxProvider
  try {
    selected = selectSandboxProvider(options.providers, options.task, options.imageCatalog)
    checks.push({
      kind: 'provider',
      name: 'required capabilities',
      ok: true,
      required: true,
      detail: `${selected.provider.name}: ${requiredCapabilitiesForTask(options.task).join(', ')}`,
    })
  } catch (err) {
    const message = err instanceof Error ? err.message : 'Provider capability selection failed.'
    checks.push({
      kind: 'provider',
      name: 'required capabilities',
      ok: false,
      required: true,
      detail: message,
    })
    errors.push(message)
    return { ok: false, runId, checks, errors }
  }

  const preflight = options.preflight ?? { runtime: false }
  if (preflight.runtime) {
    await preflightSandboxRuntime({
      selected,
      task: options.task,
      mount,
      config: preflight,
      checks,
      errors,
    })
  }

  return {
    ok: errors.length === 0,
    runId,
    providerName: selected.provider.name,
    createConfig: selected.createConfig,
    selected,
    checks,
    errors,
  }
}

async function runSelectedTask(context: RunContext): Promise<WorkspaceSandboxTaskResult> {
  const { runId, workspace, task, mount, selected } = context
  const checkpoints: WorkspaceSandboxTaskResult['checkpoints'] = {}
  const baseFiles = context.consistency.mode === 'branch-merge'
    ? await collectWorkspaceFiles(workspace, mount.workspacePath)
    : undefined

  if (workspace.capabilities.checkpoint) {
    checkpoints.before = await workspace.checkpoint(`sandbox:${runId}:before`)
  }

  const sandbox = await selected.provider.create(selected.createConfig)
  let keepSandbox = false

  try {
    const materialized = mount.mode === 'snapshot'
      ? await materializeWorkspaceToSandbox(workspace, sandbox, {
        workspacePath: mount.workspacePath,
        sandboxPath: mount.sandboxPath,
      })
      : undefined

    const execution = await executeTaskInSandbox(context, sandbox)
    if (execution.exec.exitCode !== 0) {
      throw new Error(`Sandbox task "${task.kind}" failed with exit code ${execution.exec.exitCode}: ${execution.exec.stderr}`)
    }

    if (task.kind === 'codex.goal') {
      keepSandbox = true
      return {
        runId,
        providerName: selected.provider.name,
        sandboxId: sandbox.id,
        command: execution.command,
        exec: execution.exec,
        codex: execution.codex,
        materialized,
        preflight: context.preflight,
        checkpoints,
      }
    }

    if (mount.mode === 'live') {
      if (workspace.capabilities.checkpoint) {
        checkpoints.after = await workspace.checkpoint(`sandbox:${runId}:after`)
      }
      return {
        runId,
        providerName: selected.provider.name,
        sandboxId: sandbox.id,
        command: execution.command,
        exec: execution.exec,
        codex: execution.codex,
        materialized,
        preflight: context.preflight,
        checkpoints,
      }
    }

    if (context.consistency.mode === 'branch-merge') {
      const stagePath = `/.sandbank/provider-runs/${runId}/branch`
      await workspace.remove(stagePath, { recursive: true, missingOk: true })
      await syncWorkspaceFromSandbox(workspace, sandbox, {
        workspacePath: stagePath,
        sandboxPath: mount.sandboxPath,
        deleteMissing: true,
        checkpointLabel: false,
      })
      const merge = await withWorkspaceLock(workspace, mount.workspacePath, context.consistency.lockTtlMs, async () => {
        const stageFiles = await collectWorkspaceFiles(workspace, stagePath)
        return mergeSandboxBranch({
          runId,
          workspace,
          workspacePath: mount.workspacePath,
          baseFiles: baseFiles ?? new Map(),
          stageFiles,
          consistency: context.consistency,
        })
      })
      if (workspace.capabilities.checkpoint) {
        checkpoints.after = await workspace.checkpoint(`sandbox:${runId}:after`)
      }
      return {
        runId,
        providerName: selected.provider.name,
        sandboxId: sandbox.id,
        command: execution.command,
        exec: execution.exec,
        codex: execution.codex,
        materialized,
        merge,
        preflight: context.preflight,
        checkpoints,
      }
    }

    const synced = await syncWorkspaceFromSandbox(workspace, sandbox, {
      workspacePath: mount.workspacePath,
      sandboxPath: mount.sandboxPath,
      deleteMissing: context.consistency.deleteMissing,
      checkpointLabel: workspace.capabilities.checkpoint ? `sandbox:${runId}:after` : false,
    })
    checkpoints.after = synced.checkpoint

    return {
      runId,
      providerName: selected.provider.name,
      sandboxId: sandbox.id,
      command: execution.command,
      exec: execution.exec,
      codex: execution.codex,
      materialized,
      synced,
      preflight: context.preflight,
      checkpoints,
    }
  } finally {
    if (context.destroySandbox && !keepSandbox) {
      await selected.provider.destroy(sandbox.id).catch(() => undefined)
    }
  }
}

async function executeTaskInSandbox(
  context: RunContext,
  sandbox: Sandbox,
): Promise<{ command: string; exec: ExecResult; codex?: WorkspaceSandboxCodexResult }> {
  const { task, mount, runId } = context
  if (task.kind === 'command') {
    return execCommand(sandbox, task.command, task.timeoutMs)
  }

  if (task.kind === 'python') {
    const command = [
      shellQuote(task.python ?? 'python'),
      shellQuote(mapWorkspacePathToSandboxPath(task.path, mount)),
      ...(task.args ?? []).map(shellQuote),
    ].join(' ')
    return execCommand(sandbox, command, task.timeoutMs)
  }

  if (task.kind === 'codex.exec') {
    const promptPath = await resolveCodexPromptPath(sandbox, task, mount, runId)
    const bypass = task.dangerouslyBypassApprovalsAndSandbox ?? true
    const command = [
      shellQuote(task.codex ?? 'codex'),
      'exec',
      '--json',
      '--skip-git-repo-check',
      bypass ? '--dangerously-bypass-approvals-and-sandbox' : undefined,
      `"$(cat ${shellQuote(promptPath)})"`,
    ].filter(Boolean).join(' ')
    const result = await execCommand(sandbox, command, task.timeoutMs)
    return {
      ...result,
      codex: { mode: 'exec', promptPath },
    }
  }

  const goalPath = await resolveCodexGoalPath(sandbox, task, mount, runId)
  const sessionName = sanitizeTmuxSessionName(task.sessionName ?? `goal_${runId}`)
  const codexCommand = `${task.codex ?? 'codex'} --cd ${mount.sandboxPath} --no-alt-screen`
  const goalCommand = `/goal Read and follow this sandbox goal file exactly: ${goalPath}`
  const command = [
    'set -euo pipefail',
    `tmux has-session -t ${shellQuote(sessionName)} 2>/dev/null && tmux kill-session -t ${shellQuote(sessionName)} || true`,
    `tmux new-session -d -s ${shellQuote(sessionName)} -c ${shellQuote(mount.sandboxPath)} ${shellQuote(codexCommand)}`,
    `tmux send-keys -t ${shellQuote(sessionName)} ${shellQuote(goalCommand)} C-m`,
  ].join('\n')
  const result = await execCommand(sandbox, command, task.timeoutMs)
  return {
    ...result,
    codex: { mode: 'goal', goalPath, sessionName },
  }
}

async function execCommand(
  sandbox: Sandbox,
  command: string,
  timeoutMs?: number,
): Promise<{ command: string; exec: ExecResult }> {
  const exec = await sandbox.exec(command, timeoutMs ? { timeout: timeoutMs } : undefined)
  return { command, exec }
}

async function resolveCodexPromptPath(
  sandbox: Sandbox,
  task: WorkspaceCodexExecTask,
  mount: Required<WorkspaceSandboxMountOptions>,
  runId: string,
): Promise<string> {
  if (task.promptPath) return mapWorkspacePathToSandboxPath(task.promptPath, mount)
  if (task.prompt === undefined) throw new Error('codex.exec task requires prompt or promptPath')
  const promptPath = joinAbsolutePath(mount.sandboxPath, `.sandbank/codex/${runId}.prompt.md`)
  await sandbox.writeFile(promptPath, task.prompt)
  return promptPath
}

async function resolveCodexGoalPath(
  sandbox: Sandbox,
  task: WorkspaceCodexGoalTask,
  mount: Required<WorkspaceSandboxMountOptions>,
  runId: string,
): Promise<string> {
  if (task.goalPath) return mapWorkspacePathToSandboxPath(task.goalPath, mount)
  if (task.goal === undefined) throw new Error('codex.goal task requires goal or goalPath')
  const goalPath = joinAbsolutePath(mount.sandboxPath, `.sandbank/codex-goals/${runId}.goal.md`)
  await sandbox.writeFile(goalPath, task.goal)
  return goalPath
}

async function mergeSandboxBranch(options: {
  runId: string
  workspace: WorkspaceAdapter
  workspacePath: string
  baseFiles: Map<string, FileSnapshot>
  stageFiles: Map<string, FileSnapshot>
  consistency: Required<Omit<WorkspaceSandboxConsistencyOptions, 'conflictRoot'>>
    & Pick<WorkspaceSandboxConsistencyOptions, 'conflictRoot'>
}): Promise<WorkspaceMergeResult> {
  const currentFiles = await collectWorkspaceFiles(options.workspace, options.workspacePath)
  const paths = new Set([
    ...options.baseFiles.keys(),
    ...options.stageFiles.keys(),
    ...currentFiles.keys(),
  ])
  const conflicts: WorkspaceMergeConflict[] = []
  let applied = 0
  let skipped = 0

  for (const relativePath of [...paths].sort()) {
    const base = options.baseFiles.get(relativePath)
    const staged = options.stageFiles.get(relativePath)
    const current = currentFiles.get(relativePath)
    const sandboxChanged = fileKey(staged) !== fileKey(base)
    if (!sandboxChanged) continue

    const workspaceChanged = fileKey(current) !== fileKey(base)
    const targetPath = joinAbsolutePath(options.workspacePath, relativePath)
    if (workspaceChanged && fileKey(current) !== fileKey(staged)) {
      const kind = mergeKind(base, staged)
      const conflict = await resolveConflict({
        workspace: options.workspace,
        runId: options.runId,
        targetPath,
        relativePath,
        kind,
        staged,
        resolution: options.consistency.conflictResolution,
        conflictRoot: options.consistency.conflictRoot,
      })
      conflicts.push(conflict)
      if (conflict.resolution === 'sandbox') applied++
      else skipped++
      continue
    }

    await applyStagedFile(options.workspace, targetPath, staged)
    applied++
  }

  if (options.consistency.conflictResolution === 'fail' && conflicts.length > 0) {
    throw new Error(`Sandbox branch merge conflict: ${conflicts.map(conflict => conflict.path).join(', ')}`)
  }

  return { applied, skipped, conflicts }
}

async function resolveConflict(options: {
  workspace: WorkspaceAdapter
  runId: string
  targetPath: string
  relativePath: string
  kind: WorkspaceMergeConflict['kind']
  staged: FileSnapshot | undefined
  resolution: WorkspaceConflictResolution
  conflictRoot?: string
}): Promise<WorkspaceMergeConflict> {
  if (options.resolution === 'sandbox') {
    await applyStagedFile(options.workspace, options.targetPath, options.staged)
    return { path: options.targetPath, kind: options.kind, resolution: 'sandbox' }
  }

  if (options.resolution === 'keep-both') {
    const conflictRoot = options.conflictRoot ?? `/.sandbank/conflicts/${options.runId}`
    const conflictPath = joinAbsolutePath(conflictRoot, options.relativePath)
    if (options.staged) {
      await options.workspace.write(conflictPath, workspaceDataFromBytes(options.staged.data))
    } else {
      await options.workspace.write(`${conflictPath}.delete.json`, JSON.stringify({
        path: options.targetPath,
        deletedBySandbox: true,
      }))
    }
    return { path: options.targetPath, kind: options.kind, resolution: 'keep-both', conflictPath }
  }

  return { path: options.targetPath, kind: options.kind, resolution: options.resolution }
}

async function applyStagedFile(
  workspace: WorkspaceAdapter,
  targetPath: string,
  staged: FileSnapshot | undefined,
): Promise<void> {
  if (!staged) {
    await workspace.remove(targetPath, { missingOk: true })
    return
  }
  await workspace.write(targetPath, workspaceDataFromBytes(staged.data))
}

async function collectWorkspaceFiles(
  workspace: WorkspaceAdapter,
  rootPath: string,
): Promise<Map<string, FileSnapshot>> {
  const root = normalizeAbsolutePath(rootPath)
  const entries = await workspace.list(root, { recursive: true })
  const files = new Map<string, FileSnapshot>()
  for (const entry of entries) {
    if (!isFileLike(entry)) continue
    const data = await workspace.read(entry.path, { encoding: 'bytes' })
    const bytes = data instanceof Uint8Array ? copyBytes(data) : textEncoder.encode(data)
    files.set(relativePath(root, entry.path), {
      data: bytes,
      key: dataKey(bytes),
    })
  }
  return files
}

async function withWorkspaceLock<T>(
  workspace: WorkspaceAdapter,
  resource: string,
  ttlMs: number,
  fn: () => Promise<T>,
): Promise<T> {
  let lock: WorkspaceLock | undefined
  if (workspace.capabilities.lock) {
    lock = await workspace.lock(resource, ttlMs)
  }
  try {
    return await fn()
  } finally {
    await lock?.release().catch(() => undefined)
  }
}

async function preflightSandboxRuntime(options: {
  selected: SelectedSandboxProvider
  task: WorkspaceSandboxTask
  mount: Required<WorkspaceSandboxMountOptions>
  config: WorkspaceSandboxPreflightConfig
  checks: WorkspaceSandboxPreflightCheck[]
  errors: string[]
}): Promise<void> {
  let sandbox: Sandbox | undefined
  try {
    sandbox = await options.selected.provider.create(options.selected.createConfig)
    const probes = [
      ...defaultRuntimeProbesForTask(options.task, options.mount),
      ...(options.config.probes ?? []),
    ]
    for (const probe of probes) {
      const required = probe.required ?? true
      const result = await sandbox.exec(probe.command, {
        timeout: options.config.probeTimeoutMs ?? DEFAULT_PREFLIGHT_PROBE_TIMEOUT_MS,
      })
      const ok = result.exitCode === 0
      const detail = ok
        ? result.stdout.trim()
        : (result.stderr || result.stdout || `exit ${result.exitCode}`).trim()
      options.checks.push({
        kind: 'runtime',
        name: probe.name,
        ok,
        required,
        command: probe.command,
        detail,
      })
      if (!ok && required) {
        options.errors.push(`Runtime probe "${probe.name}" failed on provider "${options.selected.provider.name}": ${detail}`)
      }
    }
  } catch (err) {
    const message = err instanceof Error ? err.message : 'Runtime preflight failed.'
    options.checks.push({
      kind: 'runtime',
      name: 'sandbox.create',
      ok: false,
      required: true,
      detail: message,
    })
    options.errors.push(`Runtime preflight failed on provider "${options.selected.provider.name}": ${message}`)
  } finally {
    if (sandbox && options.config.destroySandbox !== false) {
      await options.selected.provider.destroy(sandbox.id).catch(() => undefined)
    }
  }
}

function defaultRuntimeProbesForTask(
  task: WorkspaceSandboxTask,
  mount: Required<WorkspaceSandboxMountOptions>,
): WorkspaceSandboxRuntimeProbe[] {
  const probes: WorkspaceSandboxRuntimeProbe[] = []
  if (task.kind === 'python') {
    probes.push({ name: 'python', command: `command -v ${shellQuote(task.python ?? 'python')}` })
  }
  if (task.kind === 'codex.exec' || task.kind === 'codex.goal') {
    probes.push({ name: 'codex', command: `command -v ${shellQuote(task.codex ?? 'codex')}` })
    probes.push({ name: 'git', command: 'command -v git' })
  }
  if (task.kind === 'codex.goal') {
    probes.push({ name: 'tmux', command: 'command -v tmux' })
    probes.push({ name: 'bash', command: 'command -v bash' })
    probes.push({ name: 'gh', command: 'command -v gh' })
  }
  if (mount.mode === 'snapshot') {
    probes.push({ name: 'tar', command: 'command -v tar' })
    probes.push({ name: 'gzip', command: 'command -v gzip' })
  }
  if (mount.mode === 'live') {
    probes.push({ name: 'sandbank', command: 'command -v sandbank' })
  }
  return probes
}

function requiredWorkspaceCapabilitiesForTask(
  task: WorkspaceSandboxTask,
  consistency: Required<Omit<WorkspaceSandboxConsistencyOptions, 'conflictRoot'>>
    & Pick<WorkspaceSandboxConsistencyOptions, 'conflictRoot'>,
): WorkspaceCapabilityName[] {
  const required = new Set<WorkspaceCapabilityName>(['list', 'read', 'write'])
  if (consistency.mode !== 'none') required.add('checkpoint')
  if (consistency.mode === 'exclusive-lock' || consistency.mode === 'branch-merge') {
    required.add('lock')
  }
  if (consistency.mode === 'branch-merge' || consistency.deleteMissing) {
    required.add('remove')
  }
  if (task.mount?.mode === 'live') {
    required.add('watch')
  }
  return [...required]
}

function requiredCapabilitiesForTask(task: WorkspaceSandboxTask): SandboxSchedulerCapability[] {
  const required = new Set<SandboxSchedulerCapability>(task.requiredCapabilities ?? [])
  required.add(task.mount?.mode === 'live' ? 'workspace.live' : 'workspace.snapshot')
  if (task.kind === 'python') required.add('runtime.python')
  if (task.kind === 'codex.exec') {
    required.add('runtime.codex')
    required.add('codex.exec')
  }
  if (task.kind === 'codex.goal') {
    required.add('runtime.codex')
    required.add('codex.goal')
  }
  return [...required]
}

function effectiveCapabilities(candidate: SandboxProviderCandidate): ReadonlySet<SandboxSchedulerCapability> {
  const capabilities = new Set<SandboxSchedulerCapability>(candidate.capabilities ?? [])
  for (const capability of candidate.provider.capabilities) capabilities.add(capability)
  capabilities.add('workspace.snapshot')
  return capabilities
}

function createConfigForTask(
  candidateConfig: CreateConfig | undefined,
  task: WorkspaceSandboxTask,
): CreateConfig {
  const taskConfig = task.createConfig ?? {}
  return mergeCreateConfig(
    candidateConfig ?? {},
    task.image ? { ...taskConfig, image: task.image } : taskConfig,
  )
}

function mergeCreateConfig(base: CreateConfig, override: CreateConfig): CreateConfig {
  return {
    ...base,
    ...override,
    env: base.env || override.env
      ? { ...base.env, ...override.env }
      : undefined,
  }
}

function normalizeMount(mount: WorkspaceSandboxMountOptions = {}): Required<WorkspaceSandboxMountOptions> {
  return {
    mode: mount.mode ?? 'snapshot',
    workspacePath: normalizeAbsolutePath(mount.workspacePath ?? '/workspace'),
    sandboxPath: normalizeAbsolutePath(mount.sandboxPath ?? '/workspace'),
  }
}

function normalizeConsistency(
  consistency: WorkspaceSandboxConsistencyOptions = {},
): Required<Omit<WorkspaceSandboxConsistencyOptions, 'conflictRoot'>>
  & Pick<WorkspaceSandboxConsistencyOptions, 'conflictRoot'> {
  return {
    mode: consistency.mode ?? 'exclusive-lock',
    conflictResolution: consistency.conflictResolution ?? 'fail',
    lockTtlMs: consistency.lockTtlMs ?? DEFAULT_LOCK_TTL_MS,
    deleteMissing: consistency.deleteMissing ?? false,
    conflictRoot: consistency.conflictRoot,
  }
}

function mapWorkspacePathToSandboxPath(path: string, mount: Required<WorkspaceSandboxMountOptions>): string {
  const normalized = normalizeAbsolutePath(path)
  if (normalized === mount.workspacePath) return mount.sandboxPath
  if (!normalized.startsWith(`${mount.workspacePath}/`)) return normalized
  return joinAbsolutePath(mount.sandboxPath, normalized.slice(mount.workspacePath.length + 1))
}

function mergeKind(base: FileSnapshot | undefined, staged: FileSnapshot | undefined): WorkspaceMergeConflict['kind'] {
  if (!base && staged) return 'added'
  if (base && !staged) return 'removed'
  return 'modified'
}

function fileKey(file: FileSnapshot | undefined): string | undefined {
  return file?.key
}

function dataKey(data: Uint8Array): string {
  let result = ''
  for (const byte of data) result += String.fromCharCode(byte)
  return btoa(result)
}

function isFileLike(entry: WorkspaceEntry): boolean {
  return entry.type !== 'directory'
}

function copyBytes(data: Uint8Array): Uint8Array {
  const copy = new Uint8Array(data.byteLength)
  copy.set(data)
  return copy
}

function workspaceDataFromBytes(data: Uint8Array): WorkspaceData {
  try {
    const text = textDecoder.decode(data)
    if (hasBinaryControlChars(text)) return copyBytes(data)
    return text
  } catch {
    return copyBytes(data)
  }
}

function hasBinaryControlChars(text: string): boolean {
  for (let i = 0; i < text.length; i++) {
    const code = text.charCodeAt(i)
    if (code < 32 && code !== 9 && code !== 10 && code !== 13) return true
  }
  return false
}

function normalizeAbsolutePath(input: string): string {
  const parts: string[] = []
  for (const part of input.replace(/\\/g, '/').split('/')) {
    if (!part || part === '.') continue
    if (part === '..') parts.pop()
    else parts.push(part)
  }
  return `/${parts.join('/')}`
}

function joinAbsolutePath(basePath: string, relative: string): string {
  const base = normalizeAbsolutePath(basePath)
  const parts = relative.replace(/\\/g, '/').split('/').filter(Boolean)
  const joined = parts.reduce((path, part) => {
    if (part === '.') return path
    if (part === '..') throw new Error(`Path cannot escape workspace root: ${relative}`)
    return path === '/' ? `/${part}` : `${path}/${part}`
  }, base)
  return normalizeAbsolutePath(joined)
}

function relativePath(rootPath: string, path: string): string {
  const root = normalizeAbsolutePath(rootPath)
  const normalized = normalizeAbsolutePath(path)
  if (root === '/') return normalized.slice(1)
  if (normalized === root) return normalized.split('/').pop() ?? ''
  if (!normalized.startsWith(`${root}/`)) throw new Error(`Workspace path ${normalized} is outside ${root}`)
  return normalized.slice(root.length + 1)
}

function shellQuote(value: string): string {
  if (/^[A-Za-z0-9_/:=.,@%+-]+$/.test(value)) return value
  return `'${value.replace(/'/g, `'\\''`)}'`
}

function sanitizeTmuxSessionName(name: string): string {
  const sanitized = name.replace(/[^A-Za-z0-9_.-]/g, '_')
  return sanitized || 'goal_sandbank'
}

function createRunId(): string {
  return `sandbox_${Date.now().toString(36)}_${Math.random().toString(36).slice(2)}`
}
