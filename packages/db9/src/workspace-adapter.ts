import {
  WorkspaceError,
  type AgentOp,
  type Checkpoint,
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
  type WorkspaceEntry,
  type WorkspaceEvent,
  type WorkspaceLock,
  type WorkspaceQuery,
  type WorkspaceRef,
  type WorkspaceTx,
  type WriteOptions,
} from '@sandbank.dev/workspace'
import { Db9Client, type Db9ClientConfig } from './client.js'
import type { Db9SqlResult } from './types.js'

export interface Db9SqlExecutor {
  executeSQL(dbId: string, query: string): Promise<Db9SqlResult>
}

export interface Db9WorkspaceAdapterConfig extends Partial<Db9ClientConfig> {
  dbId: string
  client?: Db9SqlExecutor
}

const db9WorkspaceCapabilities: WorkspaceCapabilities = {
  list: true,
  read: true,
  write: true,
  append: true,
  remove: true,
  move: false,
  stat: true,
  query: true,
  transaction: false,
  checkpoint: false,
  diff: false,
  rollback: false,
  watch: true,
  lock: false,
  log: false,
  sqlQuery: true,
  nativeWatch: false,
  branch: false,
  fileAsTable: true,
  vectorSearch: false,
  functionRuntime: false,
  provider: {
    db9Fs9: true,
    localWriteWatchOnly: true,
  },
}

type Watcher = (event: WorkspaceEvent) => void

export class Db9WorkspaceAdapter implements WorkspaceAdapter {
  readonly id: string
  readonly kind = 'db9'
  readonly capabilities = db9WorkspaceCapabilities
  private readonly dbId: string
  private readonly client: Db9SqlExecutor
  private readonly watchers = new Set<Watcher>()

  constructor(config: Db9WorkspaceAdapterConfig) {
    this.dbId = config.dbId
    this.id = `db9:${config.dbId}`
    if (config.client) {
      this.client = config.client
      return
    }
    if (!config.token) throw new Error('Missing db9 token for Db9WorkspaceAdapter')
    this.client = new Db9Client({ token: config.token, baseUrl: config.baseUrl })
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
    if (!expr.sql) {
      if (expr.kind === 'files') {
        const rows = await this.list(expr.path ?? '/', { recursive: true, limit: expr.limit })
        return { rows, rowCount: rows.length }
      }
      throw unsupported('non-SQL workspace query')
    }
    const result = await this.exec(expr.sql)
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

  async checkpoint(_label?: string): Promise<Checkpoint> {
    throw unsupported('checkpoint')
  }

  async diff(_a: WorkspaceRef, _b: WorkspaceRef): Promise<WorkspaceDiff> {
    throw unsupported('diff')
  }

  async rollback(_ref: WorkspaceRef): Promise<void> {
    throw unsupported('rollback')
  }

  watch(path: string, opts: WatchOptions = {}): AsyncIterable<WorkspaceEvent> {
    const prefix = normalizePath(path)
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

  async log(_op: AgentOp): Promise<OpId> {
    throw unsupported('log')
  }

  private async exec(sql: string): Promise<Db9SqlResult> {
    return this.client.executeSQL(this.dbId, sql)
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
