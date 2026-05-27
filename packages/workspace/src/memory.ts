import { WorkspaceError } from './errors.js'
import type {
  AgentOp,
  Checkpoint,
  ListOptions,
  MoveOptions,
  OpId,
  OpLogEntry,
  QueryResult,
  ReadOptions,
  RemoveOptions,
  TransactionOptions,
  WatchOptions,
  WorkspaceAdapter,
  WorkspaceCapabilities,
  WorkspaceData,
  WorkspaceDiff,
  WorkspaceDiffEntry,
  WorkspaceEntry,
  WorkspaceEvent,
  WorkspaceLock,
  WorkspaceQuery,
  WorkspaceRef,
  WorkspaceTx,
  WriteOptions,
} from './types.js'

interface MemoryFile {
  data: WorkspaceData
  createdAt: string
  modifiedAt: string
  version: number
}

interface StoredFile {
  path: string
  data: string
  encoding: 'text' | 'base64'
  createdAt: string
  modifiedAt: string
  version: number
}

interface StoredCheckpoint {
  checkpoint: Checkpoint
  files: StoredFile[]
}

export interface MemoryWorkspaceSnapshot {
  files: StoredFile[]
  checkpoints?: StoredCheckpoint[]
  opLog?: OpLogEntry[]
}

type Watcher = (event: WorkspaceEvent) => void

const encoder = new TextEncoder()
const decoder = new TextDecoder()

export const memoryWorkspaceCapabilities: WorkspaceCapabilities = {
  list: true,
  read: true,
  write: true,
  append: true,
  remove: true,
  move: true,
  stat: true,
  query: true,
  transaction: true,
  checkpoint: true,
  diff: true,
  rollback: true,
  watch: true,
  lock: true,
  log: true,
  sqlQuery: false,
  nativeWatch: true,
  branch: false,
  fileAsTable: false,
  vectorSearch: false,
  functionRuntime: false,
}

export class MemoryWorkspaceAdapter implements WorkspaceAdapter, WorkspaceTx {
  readonly id: string
  readonly kind = 'memory'
  readonly capabilities = memoryWorkspaceCapabilities
  readonly transactionId: string
  private files = new Map<string, MemoryFile>()
  private checkpoints = new Map<string, { checkpoint: Checkpoint; files: Map<string, MemoryFile> }>()
  private opLog: OpLogEntry[] = []
  private watchers = new Set<Watcher>()
  private locks = new Map<string, { token: string; expiresAt: number }>()
  private nextId = 0
  private readonly emitEnabled: boolean

  constructor(snapshot?: MemoryWorkspaceSnapshot, opts: { id?: string; emitEnabled?: boolean } = {}) {
    this.id = opts.id ?? 'memory'
    this.transactionId = opts.id ?? this.id
    this.emitEnabled = opts.emitEnabled ?? true

    if (snapshot) {
      this.files = filesFromStored(snapshot.files)
      this.opLog = [...(snapshot.opLog ?? [])]
      for (const stored of snapshot.checkpoints ?? []) {
        this.checkpoints.set(stored.checkpoint.ref, {
          checkpoint: stored.checkpoint,
          files: filesFromStored(stored.files),
        })
      }
      this.nextId = Math.max(
        ...this.opLog.map(op => parseNumericSuffix(op.id)),
        ...[...this.checkpoints.values()].map(item => parseNumericSuffix(item.checkpoint.id)),
        0,
      )
    }
  }

  static fromSnapshot(snapshot: MemoryWorkspaceSnapshot): MemoryWorkspaceAdapter {
    return new MemoryWorkspaceAdapter(snapshot)
  }

  exportSnapshot(): MemoryWorkspaceSnapshot {
    return {
      files: storedFromFiles(this.files),
      checkpoints: [...this.checkpoints.values()].map(item => ({
        checkpoint: item.checkpoint,
        files: storedFromFiles(item.files),
      })),
      opLog: [...this.opLog],
    }
  }

  async list(path: string, opts: ListOptions = {}): Promise<WorkspaceEntry[]> {
    const normalized = normalizePath(path)
    const entries = opts.recursive
      ? this.recursiveEntries(normalized)
      : this.directEntries(normalized)
    return entries.slice(0, opts.limit ?? entries.length)
  }

  async read(path: string, opts: ReadOptions = {}): Promise<WorkspaceData> {
    const file = this.requireFile(path)
    if (opts.encoding === 'bytes') return toBytes(file.data)
    return cloneData(file.data)
  }

  async write(path: string, data: WorkspaceData, opts: WriteOptions = {}): Promise<WorkspaceEntry> {
    const normalized = assertFilePath(path)
    const existing = this.files.get(normalized)
    if (opts.ifMatch !== undefined && existing?.version !== opts.ifMatch) {
      throw new WorkspaceError('CONFLICT', `Version mismatch for ${normalized}`)
    }

    const now = timestamp()
    const file: MemoryFile = {
      data: cloneData(data),
      createdAt: existing?.createdAt ?? now,
      modifiedAt: now,
      version: (existing?.version ?? 0) + 1,
    }
    this.files.set(normalized, file)
    const entry = this.entryForFile(normalized, file)
    const op = this.record({ action: 'workspace.write', path: normalized })
    this.emit({ type: 'write', timestamp: op.createdAt, path: normalized, entry, op })
    return entry
  }

  async append(path: string, data: WorkspaceData): Promise<WorkspaceEntry> {
    const normalized = assertFilePath(path)
    const existing = this.files.get(normalized)
    const nextData = existing ? appendData(existing.data, data) : cloneData(data)
    const now = timestamp()
    const file: MemoryFile = {
      data: nextData,
      createdAt: existing?.createdAt ?? now,
      modifiedAt: now,
      version: (existing?.version ?? 0) + 1,
    }
    this.files.set(normalized, file)
    const entry = this.entryForFile(normalized, file)
    const op = this.record({ action: 'workspace.append', path: normalized })
    this.emit({ type: 'append', timestamp: op.createdAt, path: normalized, entry, op })
    return entry
  }

  async remove(path: string, opts: RemoveOptions = {}): Promise<void> {
    const normalized = normalizePath(path)
    if (this.files.delete(normalized)) {
      const op = this.record({ action: 'workspace.remove', path: normalized })
      this.emit({ type: 'remove', timestamp: op.createdAt, path: normalized, op })
      return
    }

    const children = [...this.files.keys()].filter(filePath => isUnder(filePath, normalized))
    if (children.length === 0) {
      if (opts.missingOk) return
      throw new WorkspaceError('NOT_FOUND', `Workspace path not found: ${normalized}`)
    }
    if (!opts.recursive) {
      throw new WorkspaceError('CONFLICT', `Directory is not empty: ${normalized}`)
    }
    for (const child of children) this.files.delete(child)
    const op = this.record({ action: 'workspace.remove', path: normalized })
    this.emit({ type: 'remove', timestamp: op.createdAt, path: normalized, op })
  }

  async move(from: string, to: string, opts: MoveOptions = {}): Promise<void> {
    const source = normalizePath(from)
    const target = assertFilePath(to)
    if (source === target) return
    if (isUnder(target, source)) {
      throw new WorkspaceError('CONFLICT', `Cannot move ${source} into itself`)
    }

    const sourceFile = this.files.get(source)
    if (sourceFile) {
      if (!opts.overwrite && this.exists(target)) {
        throw new WorkspaceError('ALREADY_EXISTS', `Workspace path already exists: ${target}`)
      }
      this.files.delete(source)
      this.files.set(target, cloneFile(sourceFile))
      const op = this.record({ action: 'workspace.move', path: source, targetPath: target })
      this.emit({ type: 'move', timestamp: op.createdAt, path: source, targetPath: target, op })
      return
    }

    const descendants = [...this.files.entries()]
      .filter(([filePath]) => isUnder(filePath, source))
      .sort(([a], [b]) => a.localeCompare(b))
    if (descendants.length === 0) {
      throw new WorkspaceError('NOT_FOUND', `Workspace path not found: ${source}`)
    }
    if (!opts.overwrite && this.exists(target)) {
      throw new WorkspaceError('ALREADY_EXISTS', `Workspace path already exists: ${target}`)
    }
    if (opts.overwrite) {
      for (const filePath of [...this.files.keys()].filter(filePath => isUnder(filePath, target) || filePath === target)) {
        this.files.delete(filePath)
      }
    }
    for (const [filePath, file] of descendants) {
      const suffix = filePath.slice(source.length)
      this.files.delete(filePath)
      this.files.set(`${target}${suffix}`, cloneFile(file))
    }
    const op = this.record({ action: 'workspace.move', path: source, targetPath: target })
    this.emit({ type: 'move', timestamp: op.createdAt, path: source, targetPath: target, op })
  }

  async stat(path: string): Promise<WorkspaceEntry> {
    const normalized = normalizePath(path)
    const file = this.files.get(normalized)
    if (file) return this.entryForFile(normalized, file)
    if (normalized === '/' || [...this.files.keys()].some(filePath => isUnder(filePath, normalized))) {
      return directoryEntry(normalized)
    }
    throw new WorkspaceError('NOT_FOUND', `Workspace path not found: ${normalized}`)
  }

  async query(expr: WorkspaceQuery): Promise<QueryResult> {
    if (expr.sql) {
      throw new WorkspaceError('UNSUPPORTED', 'SQL query is not supported by MemoryWorkspaceAdapter')
    }
    if (expr.kind === 'log') {
      const rows = this.opLog.slice(0, expr.limit ?? this.opLog.length)
      return { rows, rowCount: rows.length }
    }
    if (expr.kind === 'checkpoints') {
      const rows = [...this.checkpoints.values()].map(item => item.checkpoint)
      return { rows: rows.slice(0, expr.limit ?? rows.length), rowCount: rows.length }
    }
    const rows = await this.list(expr.path ?? '/', { recursive: true, limit: expr.limit })
    return { rows, rowCount: rows.length }
  }

  async transaction<T>(fn: (tx: WorkspaceTx) => Promise<T>, _opts: TransactionOptions = {}): Promise<T> {
    const tx = this.cloneForTransaction()
    const result = await fn(tx)
    const previousOpCount = this.opLog.length
    this.files = tx.files
    this.checkpoints = tx.checkpoints
    this.opLog = tx.opLog
    this.nextId = tx.nextId
    for (const op of this.opLog.slice(previousOpCount)) {
      this.emit(eventFromOp(op))
    }
    return result
  }

  async checkpoint(label?: string): Promise<Checkpoint> {
    const id = this.newId('checkpoint')
    const checkpoint: Checkpoint = {
      id,
      ref: `checkpoint:${id}`,
      label,
      createdAt: timestamp(),
    }
    this.checkpoints.set(checkpoint.ref, {
      checkpoint,
      files: cloneFiles(this.files),
    })
    const op = this.record({ action: 'workspace.checkpoint', metadata: { ref: checkpoint.ref, label } })
    this.emit({ type: 'checkpoint', timestamp: op.createdAt, checkpoint, op })
    return checkpoint
  }

  async diff(a: WorkspaceRef, b: WorkspaceRef): Promise<WorkspaceDiff> {
    const left = this.resolveRef(a)
    const right = this.resolveRef(b)
    const entries: WorkspaceDiffEntry[] = []
    const paths = [...new Set([...left.files.keys(), ...right.files.keys()])].sort()
    for (const path of paths) {
      const oldFile = left.files.get(path)
      const newFile = right.files.get(path)
      if (!oldFile && newFile) {
        entries.push({ path, kind: 'added', newSize: dataSize(newFile.data) })
      } else if (oldFile && !newFile) {
        entries.push({ path, kind: 'removed', oldSize: dataSize(oldFile.data) })
      } else if (oldFile && newFile && dataKey(oldFile.data) !== dataKey(newFile.data)) {
        entries.push({
          path,
          kind: 'modified',
          oldSize: dataSize(oldFile.data),
          newSize: dataSize(newFile.data),
        })
      }
    }
    entries.sort((a, b) => diffKindRank(a.kind) - diffKindRank(b.kind) || a.path.localeCompare(b.path))
    return { from: left.ref, to: right.ref, entries }
  }

  async rollback(ref: WorkspaceRef): Promise<void> {
    const resolved = this.resolveRef(ref)
    if (resolved.ref === 'current') return
    this.files = cloneFiles(resolved.files)
    const op = this.record({ action: 'workspace.rollback', metadata: { ref: resolved.ref } })
    this.emit({ type: 'rollback', timestamp: op.createdAt, op })
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
      while (waits.length > 0) {
        const wait = waits.shift()
        wait?.({ value: undefined, done: true })
      }
    }

    const watcher: Watcher = event => {
      if (!eventMatches(prefix, event)) return
      if (waits.length > 0) {
        const wait = waits.shift()
        wait?.({ value: event, done: false })
      } else {
        queue.push(event)
      }
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
            if (queue.length > 0) {
              const value = queue.shift()
              if (value) return { value, done: false }
            }
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

  async lock(resource: string, ttlMs: number): Promise<WorkspaceLock> {
    const normalized = normalizePath(resource)
    const now = Date.now()
    const existing = this.locks.get(normalized)
    if (existing && existing.expiresAt > now) {
      throw new WorkspaceError('LOCKED', `Workspace resource is already locked: ${normalized}`)
    }
    const token = this.newId('lock')
    const expiresAtMs = now + ttlMs
    this.locks.set(normalized, { token, expiresAt: expiresAtMs })
    const expiresAt = new Date(expiresAtMs).toISOString()
    const op = this.record({ action: 'workspace.lock', path: normalized, metadata: { token, expiresAt } })
    this.emit({ type: 'lock', timestamp: op.createdAt, path: normalized, op })
    return {
      resource: normalized,
      token,
      expiresAt,
      release: async () => {
        const current = this.locks.get(normalized)
        if (current?.token === token) {
          this.locks.delete(normalized)
          const unlockOp = this.record({ action: 'workspace.unlock', path: normalized, metadata: { token } })
          this.emit({ type: 'unlock', timestamp: unlockOp.createdAt, path: normalized, op: unlockOp })
        }
      },
    }
  }

  async log(op: AgentOp): Promise<OpId> {
    const entry = this.record(op)
    this.emit({ type: 'log', timestamp: entry.createdAt, path: entry.path, targetPath: entry.targetPath, op: entry })
    return entry.id
  }

  private cloneForTransaction(): MemoryWorkspaceAdapter {
    const tx = new MemoryWorkspaceAdapter(this.exportSnapshot(), {
      id: this.newId('tx'),
      emitEnabled: false,
    })
    tx.nextId = this.nextId
    tx.locks = new Map(this.locks)
    return tx
  }

  private directEntries(path: string): WorkspaceEntry[] {
    if (this.files.has(path)) return [this.entryForFile(path, this.files.get(path)!)]
    const entries = new Map<string, WorkspaceEntry>()
    for (const [filePath, file] of this.files) {
      if (!isUnder(filePath, path)) continue
      const suffix = path === '/' ? filePath.slice(1) : filePath.slice(path.length + 1)
      const [first] = suffix.split('/')
      if (!first) continue
      const childPath = joinPath(path, first)
      if (childPath === filePath) entries.set(childPath, this.entryForFile(filePath, file))
      else entries.set(childPath, directoryEntry(childPath))
    }
    return [...entries.values()].sort((a, b) => a.path.localeCompare(b.path))
  }

  private recursiveEntries(path: string): WorkspaceEntry[] {
    const entries = new Map<string, WorkspaceEntry>()
    for (const [filePath, file] of this.files) {
      if (!isUnder(filePath, path) && filePath !== path) continue
      const parts = filePath.split('/').filter(Boolean)
      let current = ''
      for (const part of parts.slice(0, -1)) {
        current = `${current}/${part}`
        if (isUnder(current, path) || current === path) entries.set(current, directoryEntry(current))
      }
      entries.set(filePath, this.entryForFile(filePath, file))
    }
    entries.delete(path)
    return [...entries.values()].sort((a, b) => a.path.localeCompare(b.path))
  }

  private entryForFile(path: string, file: MemoryFile): WorkspaceEntry {
    return {
      path,
      name: basename(path),
      type: entryTypeForPath(path),
      size: dataSize(file.data),
      createdAt: file.createdAt,
      modifiedAt: file.modifiedAt,
      version: file.version,
    }
  }

  private requireFile(path: string): MemoryFile {
    const normalized = normalizePath(path)
    const file = this.files.get(normalized)
    if (!file) throw new WorkspaceError('NOT_FOUND', `Workspace path not found: ${normalized}`)
    return file
  }

  private exists(path: string): boolean {
    return this.files.has(path) || [...this.files.keys()].some(filePath => isUnder(filePath, path))
  }

  private resolveRef(ref: WorkspaceRef): { ref: string; files: Map<string, MemoryFile> } {
    if (ref === 'current') return { ref: 'current', files: this.files }
    const refName = typeof ref === 'string' ? ref : ref.ref
    const checkpoint = this.checkpoints.get(refName)
    if (!checkpoint) throw new WorkspaceError('NOT_FOUND', `Workspace checkpoint not found: ${refName}`)
    return { ref: refName, files: checkpoint.files }
  }

  private record(op: AgentOp): OpLogEntry {
    const entry: OpLogEntry = {
      ...op,
      id: this.newId('op'),
      createdAt: timestamp(),
    }
    this.opLog.push(entry)
    return entry
  }

  private emit(event: WorkspaceEvent): void {
    if (!this.emitEnabled) return
    for (const watcher of this.watchers) watcher(event)
  }

  private newId(prefix: string): string {
    this.nextId += 1
    return `${prefix}-${this.nextId}`
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

function assertFilePath(path: string): string {
  const normalized = normalizePath(path)
  if (normalized === '/') throw new WorkspaceError('INVALID_PATH', 'Workspace file path cannot be root')
  return normalized
}

function basename(path: string): string {
  if (path === '/') return '/'
  return path.slice(path.lastIndexOf('/') + 1)
}

function joinPath(parent: string, child: string): string {
  return parent === '/' ? `/${child}` : `${parent}/${child}`
}

function isUnder(path: string, parent: string): boolean {
  return parent === '/' ? path !== '/' : path.startsWith(`${parent}/`)
}

function directoryEntry(path: string): WorkspaceEntry {
  return { path, name: basename(path), type: 'directory', size: 0 }
}

function entryTypeForPath(path: string): WorkspaceEntry['type'] {
  if (path.startsWith('/messages/')) return 'message'
  if (path.startsWith('/.artifacts/')) return 'artifact'
  if (path.startsWith('/tables/')) return 'table'
  return 'file'
}

function cloneData(data: WorkspaceData): WorkspaceData {
  return typeof data === 'string' ? data : new Uint8Array(data)
}

function cloneFile(file: MemoryFile): MemoryFile {
  return { ...file, data: cloneData(file.data) }
}

function cloneFiles(files: Map<string, MemoryFile>): Map<string, MemoryFile> {
  return new Map([...files.entries()].map(([path, file]) => [path, cloneFile(file)]))
}

function toBytes(data: WorkspaceData): Uint8Array {
  return typeof data === 'string' ? encoder.encode(data) : new Uint8Array(data)
}

function appendData(left: WorkspaceData, right: WorkspaceData): WorkspaceData {
  if (typeof left === 'string' && typeof right === 'string') return left + right
  const a = toBytes(left)
  const b = toBytes(right)
  const merged = new Uint8Array(a.byteLength + b.byteLength)
  merged.set(a, 0)
  merged.set(b, a.byteLength)
  return merged
}

function dataSize(data: WorkspaceData): number {
  return toBytes(data).byteLength
}

function dataKey(data: WorkspaceData): string {
  return typeof data === 'string'
    ? `text:${data}`
    : `bytes:${bytesToBase64(data)}`
}

function storedFromFiles(files: Map<string, MemoryFile>): StoredFile[] {
  return [...files.entries()]
    .sort(([a], [b]) => a.localeCompare(b))
    .map(([path, file]) => {
      if (typeof file.data === 'string') {
        return { path, data: file.data, encoding: 'text', createdAt: file.createdAt, modifiedAt: file.modifiedAt, version: file.version }
      }
      return {
        path,
        data: bytesToBase64(file.data),
        encoding: 'base64',
        createdAt: file.createdAt,
        modifiedAt: file.modifiedAt,
        version: file.version,
      }
    })
}

function filesFromStored(files: StoredFile[]): Map<string, MemoryFile> {
  return new Map(files.map(file => [
    normalizePath(file.path),
    {
      data: file.encoding === 'base64' ? base64ToBytes(file.data) : file.data,
      createdAt: file.createdAt,
      modifiedAt: file.modifiedAt,
      version: file.version,
    },
  ]))
}

function eventFromOp(op: OpLogEntry): WorkspaceEvent {
  const raw = op.action.startsWith('workspace.') ? op.action.slice('workspace.'.length) : 'log'
  const type = (
    raw === 'write' || raw === 'append' || raw === 'remove' || raw === 'move'
      || raw === 'checkpoint' || raw === 'rollback' || raw === 'lock' || raw === 'unlock'
      ? raw
      : 'log'
  )
  return { type, timestamp: op.createdAt, path: op.path, targetPath: op.targetPath, op }
}

function eventMatches(prefix: string, event: WorkspaceEvent): boolean {
  return (event.path !== undefined && (event.path === prefix || isUnder(event.path, prefix)))
    || (event.targetPath !== undefined && (event.targetPath === prefix || isUnder(event.targetPath, prefix)))
}

function parseNumericSuffix(value: string): number {
  const suffix = value.match(/(\d+)$/)?.[1]
  return suffix ? Number(suffix) : 0
}

function diffKindRank(kind: WorkspaceDiffEntry['kind']): number {
  if (kind === 'modified') return 0
  if (kind === 'added') return 1
  return 2
}

function bytesToBase64(data: Uint8Array): string {
  let binary = ''
  for (const byte of data) binary += String.fromCharCode(byte)
  return btoa(binary)
}

function base64ToBytes(data: string): Uint8Array {
  const binary = atob(data)
  const bytes = new Uint8Array(binary.length)
  for (let index = 0; index < binary.length; index += 1) {
    bytes[index] = binary.charCodeAt(index)
  }
  return bytes
}

function timestamp(): string {
  return new Date().toISOString()
}
