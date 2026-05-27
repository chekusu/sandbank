import type { AgentOp, OpId, Workspace, WorkspaceData } from '@sandbank.dev/workspace'

export interface AgentWorkspaceClientOptions {
  agentId?: string
  stateRoot?: string
  artifactRoot?: string
  taskInboxRoot?: string
}

export interface AgentWorkspaceClient {
  readonly workspace: Workspace
  readState(path: string): Promise<WorkspaceData>
  writeState(path: string, data: WorkspaceData): Promise<void>
  commitOp(op: AgentOp): Promise<OpId>
  readTask<T = unknown>(taskId: string): Promise<T>
  writeArtifact(path: string, data: WorkspaceData): Promise<void>
}

export function createAgentWorkspaceClient(
  workspace: Workspace,
  options: AgentWorkspaceClientOptions = {},
): AgentWorkspaceClient {
  const agentId = safeSegment(options.agentId ?? 'agent')
  const stateRoot = normalizeRoot(options.stateRoot ?? `/.runs/${agentId}/state`)
  const artifactRoot = normalizeRoot(options.artifactRoot ?? `/.artifacts/${agentId}`)
  const taskInboxRoot = normalizeRoot(options.taskInboxRoot ?? `/messages/inbox/${agentId}`)

  return {
    workspace,

    async readState(path: string): Promise<WorkspaceData> {
      return workspace.read(joinPath(stateRoot, path))
    },

    async writeState(path: string, data: WorkspaceData): Promise<void> {
      await workspace.write(joinPath(stateRoot, path), data)
    },

    async commitOp(op: AgentOp): Promise<OpId> {
      return workspace.log(op)
    },

    async readTask<T = unknown>(taskId: string): Promise<T> {
      const raw = await workspace.read(joinPath(taskInboxRoot, taskFileName(taskId)))
      const text = typeof raw === 'string' ? raw : new TextDecoder().decode(raw)
      return JSON.parse(text) as T
    },

    async writeArtifact(path: string, data: WorkspaceData): Promise<void> {
      await workspace.write(joinPath(artifactRoot, path), data)
    },
  }
}

function taskFileName(taskId: string): string {
  return taskId.endsWith('.json') ? taskId : `${taskId}.json`
}

function safeSegment(value: string): string {
  return value.replace(/[^a-zA-Z0-9._-]+/g, '-').replace(/^-+|-+$/g, '') || 'agent'
}

function normalizeRoot(path: string): string {
  const normalized = normalizePath(path)
  return normalized === '/' ? '' : normalized
}

function joinPath(root: string, path: string): string {
  const normalized = normalizePath(path)
  if (!root) return normalized
  return `${root}${normalized}`
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
