export type WorkspaceEntryType = 'file' | 'directory' | 'table' | 'message' | 'artifact'
export type WorkspaceEventType =
  | 'write'
  | 'append'
  | 'remove'
  | 'move'
  | 'checkpoint'
  | 'rollback'
  | 'lock'
  | 'unlock'
  | 'log'

export type WorkspaceData = string | Uint8Array
export type WorkspaceRef = string | Checkpoint
export type OpId = string

export interface WorkspaceCapabilities {
  list: boolean
  read: boolean
  write: boolean
  append: boolean
  remove: boolean
  move: boolean
  stat: boolean
  query: boolean
  transaction: boolean
  checkpoint: boolean
  diff: boolean
  rollback: boolean
  watch: boolean
  lock: boolean
  log: boolean
  sqlQuery?: boolean
  nativeWatch?: boolean
  branch?: boolean
  fileAsTable?: boolean
  vectorSearch?: boolean
  functionRuntime?: boolean
  provider?: Record<string, boolean | number | string>
}

export interface WorkspaceEntry {
  path: string
  name: string
  type: WorkspaceEntryType
  size?: number
  createdAt?: string
  modifiedAt?: string
  version?: number
}

export interface ListOptions {
  recursive?: boolean
  limit?: number
}

export interface ReadOptions {
  encoding?: 'utf8' | 'bytes'
}

export interface WriteOptions {
  createParents?: boolean
  ifMatch?: number
}

export interface RemoveOptions {
  recursive?: boolean
  missingOk?: boolean
}

export interface MoveOptions {
  overwrite?: boolean
}

export interface WorkspaceQuery {
  sql?: string
  kind?: 'files' | 'log' | 'checkpoints'
  path?: string
  where?: Record<string, unknown>
  limit?: number
}

export interface QueryResult {
  columns?: string[]
  rows: unknown[]
  rowCount: number
}

export interface TransactionOptions {
  label?: string
}

export interface Checkpoint {
  id: string
  ref: string
  label?: string
  createdAt: string
}

export type WorkspaceDiffKind = 'added' | 'removed' | 'modified'

export interface WorkspaceDiffEntry {
  path: string
  kind: WorkspaceDiffKind
  oldSize?: number
  newSize?: number
}

export interface WorkspaceDiff {
  from: string
  to: string
  entries: WorkspaceDiffEntry[]
}

export interface WatchOptions {
  signal?: AbortSignal
}

export interface AgentOp {
  action: string
  path?: string
  targetPath?: string
  payload?: unknown
  metadata?: Record<string, unknown>
}

export interface OpLogEntry extends AgentOp {
  id: OpId
  createdAt: string
}

export interface WorkspaceEvent {
  type: WorkspaceEventType
  timestamp: string
  path?: string
  targetPath?: string
  entry?: WorkspaceEntry
  checkpoint?: Checkpoint
  op?: OpLogEntry
}

export interface WorkspaceLock {
  resource: string
  token: string
  expiresAt: string
  release(): Promise<void>
}

export interface Workspace {
  list(path: string, opts?: ListOptions): Promise<WorkspaceEntry[]>
  read(path: string, opts?: ReadOptions): Promise<WorkspaceData>
  write(path: string, data: WorkspaceData, opts?: WriteOptions): Promise<WorkspaceEntry>
  append(path: string, data: WorkspaceData): Promise<WorkspaceEntry>
  remove(path: string, opts?: RemoveOptions): Promise<void>
  move(from: string, to: string, opts?: MoveOptions): Promise<void>
  stat(path: string): Promise<WorkspaceEntry>
  query(expr: WorkspaceQuery): Promise<QueryResult>
  transaction<T>(fn: (tx: WorkspaceTx) => Promise<T>, opts?: TransactionOptions): Promise<T>
  checkpoint(label?: string): Promise<Checkpoint>
  diff(a: WorkspaceRef, b: WorkspaceRef): Promise<WorkspaceDiff>
  rollback(ref: WorkspaceRef): Promise<void>
  watch(path: string, opts?: WatchOptions): AsyncIterable<WorkspaceEvent>
  lock(resource: string, ttlMs: number): Promise<WorkspaceLock>
  log(op: AgentOp): Promise<OpId>
}

export interface WorkspaceTx extends Workspace {
  readonly transactionId: string
}

export interface WorkspaceAdapter extends Workspace {
  readonly id: string
  readonly kind: string
  readonly capabilities: WorkspaceCapabilities
  close?(): Promise<void>
}
