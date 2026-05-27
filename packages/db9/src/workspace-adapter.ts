import {
  WorkspaceError,
  type AgentOp,
  type Checkpoint,
  type OpLogEntry,
  type ListOptions,
  type MoveOptions,
  type OpId,
  type QueryResult,
  type ReadOptions,
  type RemoveOptions,
  type TransactionOptions,
  type WatchOptions,
  type WorkspaceAdapter,
  type WorkspaceCapabilities,
  type WorkspaceData,
  type WorkspaceDiff,
  type WorkspaceDiffEntry,
  type WorkspaceEntry,
  type WorkspaceEvent,
  type WorkspaceLock,
  type WorkspaceQuery,
  type WorkspaceRef,
  type WorkspaceTx,
  type WriteOptions,
} from '@sandbank.dev/workspace'
import { Db9Client, type Db9ClientConfig } from './client.js'
import type {
  Db9Database,
  Db9FunctionInvokeOptions,
  Db9FunctionInvokeResult,
  Db9ScopedToken,
  Db9ScopedTokenRequest,
  Db9SqlResult,
} from './types.js'

export interface Db9SqlExecutor {
  executeSQL(dbId: string, query: string): Promise<Db9SqlResult>
}

export interface Db9FunctionInvoker {
  invokeFunction(
    dbId: string,
    name: string,
    input: unknown,
    options?: Db9FunctionInvokeOptions,
  ): Promise<Db9FunctionInvokeResult>
}

export interface Db9ScopedTokenIssuer {
  createScopedToken(dbId: string, request: Db9ScopedTokenRequest): Promise<Db9ScopedToken>
}

export interface Db9BranchManager {
  createBranch(dbId: string, name: string): Promise<Db9Database>
}

export interface Db9WatchTransport {
  watch(dbId: string, path: string, opts?: WatchOptions): AsyncIterable<WorkspaceEvent>
}

export type Db9WorkspaceClient =
  Db9SqlExecutor
  & Partial<Db9FunctionInvoker>
  & Partial<Db9ScopedTokenIssuer>
  & Partial<Db9BranchManager>

export interface Db9SearchOptions {
  text: string
  mode?: 'fts' | 'vector'
  path?: string
  table?: string
  column?: string
  vector?: number[]
  vectorColumn?: string
  limit?: number
}

export interface Db9WorkspaceAdapterConfig extends Partial<Db9ClientConfig> {
  dbId: string
  client?: Db9WorkspaceClient
  watchTransport?: Db9WatchTransport
}

function db9WorkspaceCapabilities(options: {
  nativeWatch: boolean
  functionRuntime: boolean
  scopedTokens: boolean
  branch: boolean
}): WorkspaceCapabilities {
  return {
    list: true,
    read: true,
    write: true,
    append: true,
    remove: true,
    move: false,
    stat: true,
    query: true,
    transaction: false,
    checkpoint: true,
    diff: true,
    rollback: true,
    watch: true,
    lock: false,
    log: true,
    sqlQuery: true,
    nativeWatch: options.nativeWatch,
    branch: options.branch,
    fileAsTable: true,
    vectorSearch: true,
    functionRuntime: options.functionRuntime,
    provider: {
      db9Fs9: true,
      watch: options.nativeWatch ? 'transport' : 'local-write-only',
      checkpoint: 'fs9-snapshot',
      rollback: 'fs9-snapshot',
      branch: options.branch ? 'db9-rest' : 'unsupported',
      ftsSearch: 'sql-entry',
      vectorSearch: 'sql-entry',
      functionRuntime: options.functionRuntime ? 'db9-function' : 'unsupported',
      scopedToken: options.scopedTokens ? 'db9-rest' : 'unsupported',
      functionFs9Scope: options.functionRuntime ? 'db9-function-option' : 'unsupported',
    },
  }
}

type Watcher = (event: WorkspaceEvent) => void

interface Db9CheckpointFile {
  path: string
  data: string
}

interface Db9CheckpointSnapshot {
  version: 1
  checkpoint: Checkpoint
  files: Db9CheckpointFile[]
}

type Db9WorkspaceQuery = WorkspaceQuery & {
  kind?: WorkspaceQuery['kind'] | 'search'
  text?: string
  mode?: 'fts' | 'vector'
  table?: string
  column?: string
  vector?: number[]
  vectorColumn?: string
}

export class Db9WorkspaceAdapter implements WorkspaceAdapter {
  readonly id: string
  readonly kind = 'db9'
  readonly capabilities: WorkspaceCapabilities
  private readonly dbId: string
  private readonly client: Db9SqlExecutor
  private readonly functionInvoker?: Db9FunctionInvoker
  private readonly scopedTokenIssuer?: Db9ScopedTokenIssuer
  private readonly branchManager?: Db9BranchManager
  private readonly watchTransport?: Db9WatchTransport
  private readonly watchers = new Set<Watcher>()

  constructor(config: Db9WorkspaceAdapterConfig) {
    this.dbId = config.dbId
    this.id = `db9:${config.dbId}`
    if (config.client) {
      this.client = config.client
      this.functionInvoker = isFunctionInvoker(config.client) ? config.client : undefined
      this.scopedTokenIssuer = isScopedTokenIssuer(config.client) ? config.client : undefined
      this.branchManager = isBranchManager(config.client) ? config.client : undefined
      this.watchTransport = config.watchTransport
      this.capabilities = db9WorkspaceCapabilities({
        nativeWatch: Boolean(this.watchTransport),
        functionRuntime: Boolean(this.functionInvoker),
        scopedTokens: Boolean(this.scopedTokenIssuer),
        branch: Boolean(this.branchManager),
      })
      return
    }
    if (!config.token) throw new Error('Missing db9 token for Db9WorkspaceAdapter')
    const client = new Db9Client({ token: config.token, baseUrl: config.baseUrl })
    this.client = client
    this.functionInvoker = client
    this.scopedTokenIssuer = client
    this.branchManager = client
    this.watchTransport = config.watchTransport
    this.capabilities = db9WorkspaceCapabilities({
      nativeWatch: Boolean(this.watchTransport),
      functionRuntime: true,
      scopedTokens: true,
      branch: true,
    })
  }

  async list(path: string, opts: ListOptions = {}): Promise<WorkspaceEntry[]> {
    const result = await this.exec(
      `SELECT * FROM extensions.fs9_list(${sqlString(normalizePath(path))}, ${opts.recursive ? 'true' : 'false'})`,
    )
    return rowsAsObjects(result).map(rowToEntry)
  }

  async read(path: string, opts: ReadOptions = {}): Promise<WorkspaceData> {
    const result = await this.exec(`SELECT extensions.fs9_read(${sqlString(normalizePath(path))}) AS data`)
    const value = result.rows[0]?.[0]
    if (value === undefined || value === null) {
      throw new WorkspaceError('NOT_FOUND', `db9 fs9 path not found: ${normalizePath(path)}`)
    }
    const text = String(value)
    return opts.encoding === 'bytes' ? new TextEncoder().encode(text) : text
  }

  async write(path: string, data: WorkspaceData, _opts: WriteOptions = {}): Promise<WorkspaceEntry> {
    const normalized = normalizePath(path)
    await this.exec(
      `SELECT extensions.fs9_write(${sqlString(normalized)}, ${sqlString(dataToText(data))}) AS ok`,
    )
    const entry = await this.syntheticEntry(normalized, data)
    this.emit({ type: 'write', timestamp: timestamp(), path: normalized, entry })
    return entry
  }

  async append(path: string, data: WorkspaceData): Promise<WorkspaceEntry> {
    const normalized = normalizePath(path)
    await this.exec(
      `SELECT extensions.fs9_append(${sqlString(normalized)}, ${sqlString(dataToText(data))}) AS ok`,
    )
    const entry = await this.syntheticEntry(normalized, data)
    this.emit({ type: 'append', timestamp: timestamp(), path: normalized, entry })
    return entry
  }

  async remove(path: string, _opts: RemoveOptions = {}): Promise<void> {
    const normalized = normalizePath(path)
    await this.exec(`SELECT extensions.fs9_remove(${sqlString(normalized)}) AS ok`)
    this.emit({ type: 'remove', timestamp: timestamp(), path: normalized })
  }

  async move(_from: string, _to: string, _opts: MoveOptions = {}): Promise<void> {
    throw unsupported('move')
  }

  async stat(path: string): Promise<WorkspaceEntry> {
    const normalized = normalizePath(path)
    const result = await this.exec(`SELECT * FROM extensions.fs9_stat(${sqlString(normalized)})`)
    const row = rowsAsObjects(result)[0]
    if (!row) throw new WorkspaceError('NOT_FOUND', `db9 fs9 path not found: ${normalized}`)
    return rowToEntry(row)
  }

  async query(expr: WorkspaceQuery): Promise<QueryResult> {
    const query = expr as Db9WorkspaceQuery
    if (!query.sql) {
      if (query.kind === 'search') {
        if (!query.text) throw new WorkspaceError('INVALID_PATH', 'Db9WorkspaceAdapter search query requires text')
        return this.search({
          text: query.text,
          mode: query.mode,
          path: query.path,
          table: query.table,
          column: query.column,
          vector: query.vector,
          vectorColumn: query.vectorColumn,
          limit: query.limit,
        })
      }
      if (query.kind === 'checkpoints') {
        return this.listCheckpoints(query.limit)
      }
      if (query.kind === 'files') {
        const rows = await this.list(query.path ?? '/', { recursive: true, limit: query.limit })
        return { rows, rowCount: rows.length }
      }
      throw unsupported('non-SQL workspace query')
    }
    const result = await this.exec(query.sql)
    const rows = rowsAsObjects(result)
    return {
      columns: result.columns,
      rows,
      rowCount: result.row_count,
    }
  }

  async transaction<T>(_fn: (tx: WorkspaceTx) => Promise<T>, _opts: TransactionOptions = {}): Promise<T> {
    throw unsupported('transaction')
  }

  async checkpoint(label?: string): Promise<Checkpoint> {
    const id = createId('checkpoint')
    const checkpoint: Checkpoint = {
      id,
      ref: `db9-checkpoint:${id}`,
      label,
      createdAt: timestamp(),
    }
    const files = await this.snapshotFiles()
    const snapshot: Db9CheckpointSnapshot = { version: 1, checkpoint, files }
    await this.write(checkpointPath(checkpoint), JSON.stringify(snapshot, null, 2))
    this.emit({ type: 'checkpoint', timestamp: checkpoint.createdAt, checkpoint })
    return checkpoint
  }

  async diff(a: WorkspaceRef, b: WorkspaceRef): Promise<WorkspaceDiff> {
    const from = await this.loadSnapshot(a)
    const to = await this.loadSnapshot(b)
    const fromFiles = new Map(from.files.map(file => [file.path, file]))
    const toFiles = new Map(to.files.map(file => [file.path, file]))
    const paths = new Set([...fromFiles.keys(), ...toFiles.keys()])
    const entries: WorkspaceDiffEntry[] = []
    for (const path of [...paths].sort()) {
      const left = fromFiles.get(path)
      const right = toFiles.get(path)
      if (!left && right) entries.push({ path, kind: 'added', newSize: byteLength(right.data) })
      else if (left && !right) entries.push({ path, kind: 'removed', oldSize: byteLength(left.data) })
      if (left && right && left.data !== right.data) {
        entries.push({ path, kind: 'modified', oldSize: byteLength(left.data), newSize: byteLength(right.data) })
      }
    }
    return { from: from.checkpoint.ref, to: to.checkpoint.ref, entries }
  }

  async rollback(ref: WorkspaceRef): Promise<void> {
    const snapshot = await this.loadSnapshot(ref)
    const desired = new Map(snapshot.files.map(file => [file.path, file.data]))
    const current = await this.snapshotFiles()

    for (const file of current) {
      if (!desired.has(file.path)) await this.remove(file.path, { missingOk: true })
    }
    for (const [path, data] of desired) {
      await this.write(path, data)
    }
    this.emit({ type: 'rollback', timestamp: timestamp() })
  }

  watch(path: string, opts: WatchOptions = {}): AsyncIterable<WorkspaceEvent> {
    const prefix = normalizePath(path)
    if (this.watchTransport) return this.watchTransport.watch(this.dbId, prefix, opts)

    const queue: WorkspaceEvent[] = []
    const waits: Array<(result: IteratorResult<WorkspaceEvent>) => void> = []
    let done = false

    const complete = () => {
      if (done) return
      done = true
      this.watchers.delete(watcher)
      while (waits.length > 0) waits.shift()?.({ value: undefined, done: true })
    }

    const watcher: Watcher = event => {
      if (!event.path || (event.path !== prefix && !event.path.startsWith(`${prefix}/`))) return
      const wait = waits.shift()
      if (wait) wait({ value: event, done: false })
      else queue.push(event)
    }

    if (opts.signal) {
      if (opts.signal.aborted) complete()
      else opts.signal.addEventListener('abort', complete, { once: true })
    }
    this.watchers.add(watcher)

    return {
      [Symbol.asyncIterator]() {
        return {
          next: async () => {
            const value = queue.shift()
            if (value) return { value, done: false }
            if (done) return { value: undefined, done: true }
            return new Promise<IteratorResult<WorkspaceEvent>>(resolve => waits.push(resolve))
          },
          return: async () => {
            complete()
            return { value: undefined, done: true }
          },
        }
      },
    }
  }

  async lock(_resource: string, _ttlMs: number): Promise<WorkspaceLock> {
    throw unsupported('lock')
  }

  async log(op: AgentOp): Promise<OpId> {
    const entry: OpLogEntry = {
      ...op,
      id: createId('op'),
      createdAt: timestamp(),
    }
    await this.append('/.sandbank/oplog.jsonl', `${JSON.stringify(entry)}\n`)
    this.emit({ type: 'log', timestamp: entry.createdAt, op: entry, path: op.path, targetPath: op.targetPath })
    return entry.id
  }

  async search(options: Db9SearchOptions): Promise<QueryResult> {
    const limit = sqlLimit(options.limit)
    const mode = options.mode ?? 'fts'
    const path = normalizePath(options.path ?? '/')
    if (mode === 'vector' && !options.vector?.length) {
      throw new WorkspaceError('INVALID_PATH', 'Db9WorkspaceAdapter vector search requires a vector')
    }
    const sql = mode === 'vector'
      ? `SELECT * FROM extensions.fs9_vector_search(${sqlString(path)}, ${sqlVector(options.vector ?? [])}, ${limit})`
      : `SELECT * FROM extensions.fs9_search(${sqlString(path)}, ${sqlString(options.text)}, ${limit})`
    const result = await this.exec(sql)
    const rows = rowsAsObjects(result)
    return { columns: result.columns, rows, rowCount: result.row_count }
  }

  async invokeFunction(
    name: string,
    input: unknown,
    options: Db9FunctionInvokeOptions = {},
  ): Promise<Db9FunctionInvokeResult> {
    if (!this.functionInvoker) throw unsupported('function runtime')
    return this.functionInvoker.invokeFunction(this.dbId, name, input, options)
  }

  async createScopedToken(request: Db9ScopedTokenRequest): Promise<Db9ScopedToken> {
    if (!this.scopedTokenIssuer) throw unsupported('scoped token')
    return this.scopedTokenIssuer.createScopedToken(this.dbId, request)
  }

  async createBranch(name: string): Promise<Db9Database> {
    if (!this.branchManager) throw unsupported('branch')
    return this.branchManager.createBranch(this.dbId, name)
  }

  private async exec(sql: string): Promise<Db9SqlResult> {
    return this.client.executeSQL(this.dbId, sql)
  }

  private async snapshotFiles(): Promise<Db9CheckpointFile[]> {
    const entries = await this.list('/', { recursive: true })
    const files: Db9CheckpointFile[] = []
    for (const entry of entries) {
      if (entry.type === 'directory') continue
      if (entry.path.startsWith('/.sandbank/checkpoints/')) continue
      const data = await this.read(entry.path)
      files.push({ path: entry.path, data: dataToText(data) })
    }
    return files.sort((a, b) => a.path.localeCompare(b.path))
  }

  private async loadSnapshot(ref: WorkspaceRef): Promise<Db9CheckpointSnapshot> {
    const checkpoint = typeof ref === 'string' ? { id: idFromCheckpointRef(ref), ref, createdAt: '' } : ref
    if (!checkpoint.ref.startsWith('db9-checkpoint:')) {
      throw new WorkspaceError('UNSUPPORTED', `Unsupported db9 checkpoint ref: ${checkpoint.ref}`)
    }
    const raw = await this.read(checkpointPath(checkpoint))
    const parsed = JSON.parse(dataToText(raw)) as Db9CheckpointSnapshot
    if (parsed.version !== 1 || !Array.isArray(parsed.files)) {
      throw new WorkspaceError('CONFLICT', `Invalid db9 checkpoint snapshot: ${checkpoint.ref}`)
    }
    return parsed
  }

  private async listCheckpoints(limit?: number): Promise<QueryResult> {
    const entries = await this.list('/.sandbank/checkpoints', { recursive: false }).catch(err => {
      if (err instanceof WorkspaceError && err.code === 'NOT_FOUND') return [] as WorkspaceEntry[]
      throw err
    })
    const checkpoints: Checkpoint[] = []
    for (const entry of entries.slice(0, limit ?? entries.length)) {
      try {
        const snapshot = await this.loadSnapshot(`db9-checkpoint:${entry.name.replace(/\.json$/, '')}`)
        checkpoints.push(snapshot.checkpoint)
      } catch {
        // Ignore malformed checkpoint files; direct read still reports an error if requested.
      }
    }
    return { rows: checkpoints, rowCount: checkpoints.length }
  }

  private async syntheticEntry(path: string, data: WorkspaceData): Promise<WorkspaceEntry> {
    return {
      path,
      name: basename(path),
      type: path.startsWith('/messages/') ? 'message' : path.startsWith('/.artifacts/') ? 'artifact' : 'file',
      size: new TextEncoder().encode(dataToText(data)).byteLength,
      modifiedAt: timestamp(),
    }
  }

  private emit(event: WorkspaceEvent): void {
    for (const watcher of this.watchers) watcher(event)
  }

}

function rowsAsObjects(result: Db9SqlResult): Record<string, unknown>[] {
  return result.rows.map(row => Object.fromEntries(result.columns.map((column, index) => [column, row[index]])))
}

function isFunctionInvoker(value: Db9WorkspaceClient): value is Db9WorkspaceClient & Db9FunctionInvoker {
  return typeof value.invokeFunction === 'function'
}

function isScopedTokenIssuer(value: Db9WorkspaceClient): value is Db9WorkspaceClient & Db9ScopedTokenIssuer {
  return typeof value.createScopedToken === 'function'
}

function isBranchManager(value: Db9WorkspaceClient): value is Db9WorkspaceClient & Db9BranchManager {
  return typeof value.createBranch === 'function'
}

function checkpointPath(checkpoint: Pick<Checkpoint, 'id'>): string {
  return `/.sandbank/checkpoints/${checkpoint.id}.json`
}

function idFromCheckpointRef(ref: string): string {
  return ref.replace(/^db9-checkpoint:/, '')
}

function createId(prefix: string): string {
  const random = typeof crypto !== 'undefined' && 'randomUUID' in crypto
    ? crypto.randomUUID().slice(0, 8)
    : Math.random().toString(36).slice(2, 10)
  return `${prefix}_${Date.now().toString(36)}_${random}`
}

function sqlLimit(limit: number | undefined): string {
  const value = Math.max(1, Math.min(1000, Math.floor(limit ?? 20)))
  return String(value)
}

function sqlVector(vector: number[]): string {
  return sqlString(JSON.stringify(vector.filter(value => Number.isFinite(value))))
}

function byteLength(data: string): number {
  return new TextEncoder().encode(data).byteLength
}

function rowToEntry(row: Record<string, unknown>): WorkspaceEntry {
  const path = normalizePath(String(row['path'] ?? row['file_path'] ?? row['name'] ?? '/'))
  const rawType = String(row['type'] ?? row['kind'] ?? 'file')
  return {
    path,
    name: String(row['name'] ?? basename(path)),
    type: rawType === 'directory' ? 'directory'
      : path.startsWith('/messages/') ? 'message'
      : path.startsWith('/.artifacts/') ? 'artifact'
      : path.startsWith('/tables/') ? 'table'
      : 'file',
    size: numberOrUndefined(row['size'] ?? row['bytes']),
    createdAt: stringOrUndefined(row['created_at']),
    modifiedAt: stringOrUndefined(row['modified_at'] ?? row['updated_at']),
  }
}

function normalizePath(input: string): string {
  if (!input) return '/'
  const parts: string[] = []
  for (const part of input.replace(/\\/g, '/').split('/')) {
    if (!part || part === '.') continue
    if (part === '..') parts.pop()
    else parts.push(part)
  }
  return `/${parts.join('/')}`
}

function basename(path: string): string {
  if (path === '/') return '/'
  return path.slice(path.lastIndexOf('/') + 1)
}

function sqlString(value: string): string {
  return `'${value.replace(/'/g, "''")}'`
}

function dataToText(data: WorkspaceData): string {
  return typeof data === 'string' ? data : new TextDecoder().decode(data)
}

function timestamp(): string {
  return new Date().toISOString()
}

function numberOrUndefined(value: unknown): number | undefined {
  if (value === undefined || value === null || value === '') return undefined
  const number = Number(value)
  return Number.isFinite(number) ? number : undefined
}

function stringOrUndefined(value: unknown): string | undefined {
  return typeof value === 'string' ? value : undefined
}

function unsupported(feature: string): never {
  throw new WorkspaceError('UNSUPPORTED', `Db9WorkspaceAdapter ${feature} is not supported`)
}
