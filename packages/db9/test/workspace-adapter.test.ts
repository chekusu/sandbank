import { describe, expect, it, vi } from 'vitest'
import { WorkspaceError, type WorkspaceEvent } from '@sandbank.dev/workspace'
import { Db9WorkspaceAdapter, type Db9WorkspaceClient } from '../src/workspace-adapter.js'

function db9Result(columns: Array<string | { name: string; type?: string }>, rows: unknown[][]) {
  return { columns, rows, row_count: rows.length }
}

function db9Error(error: string) {
  return { columns: [], rows: [], row_count: 0, command: 'ERROR', error }
}

describe('Db9WorkspaceAdapter', () => {
  it('maps read/write/list/stat/remove to fs9 SQL calls', async () => {
    const executeSQL = vi.fn()
      .mockResolvedValueOnce(db9Result(['data'], [['hello']]))
      .mockResolvedValueOnce(db9Result(['ok'], [[true]]))
      .mockResolvedValueOnce(db9Result(['bytes'], [[5]]))
      .mockResolvedValueOnce(db9Result([], []))
      .mockResolvedValueOnce(db9Result(['path', 'type', 'size', 'mtime'], [
        ['/workspace/a.txt', 'file', 5, '2026-05-27T00:00:00.000Z'],
      ]))
      .mockResolvedValueOnce(db9Result(['exists', 'size', 'modified_at'], [
        [true, 5, '2026-05-27T00:00:00.000Z'],
      ]))
      .mockResolvedValueOnce(db9Result(['ok'], [[true]]))

    const workspace = new Db9WorkspaceAdapter({ dbId: 'db-1', client: { executeSQL } })

    await expect(workspace.read('/workspace/a.txt')).resolves.toBe('hello')
    await workspace.write('/workspace/a.txt', 'hello')
    await expect(workspace.list('/workspace')).resolves.toHaveLength(1)
    await expect(workspace.stat('/workspace/a.txt')).resolves.toMatchObject({
      path: '/workspace/a.txt',
      type: 'file',
      size: 5,
    })
    await workspace.remove('/workspace/a.txt')

    expect(executeSQL).toHaveBeenNthCalledWith(1, 'db-1', expect.stringContaining('fs9_read'))
    expect(executeSQL).toHaveBeenNthCalledWith(2, 'db-1', "SELECT fs9_mkdir('/workspace', true) AS ok")
    expect(executeSQL).toHaveBeenNthCalledWith(3, 'db-1', expect.stringContaining('fs9_write'))
    expect(executeSQL).toHaveBeenNthCalledWith(4, 'db-1', 'CREATE EXTENSION IF NOT EXISTS fs9')
    expect(executeSQL).toHaveBeenNthCalledWith(5, 'db-1', "SELECT path, type, size, mode, mtime FROM extensions.fs9('/workspace/')")
    expect(executeSQL).toHaveBeenNthCalledWith(6, 'db-1', expect.stringContaining('fs9_exists'))
    expect(executeSQL).toHaveBeenNthCalledWith(7, 'db-1', expect.stringContaining('fs9_remove'))
  })

  it('runs SQL queries and exposes local watch events for adapter writes', async () => {
    const executeSQL = vi.fn()
      .mockResolvedValueOnce(db9Result(['answer'], [[42]]))
      .mockResolvedValueOnce(db9Result(['ok'], [[true]]))
      .mockResolvedValueOnce(db9Result(['bytes'], [[5]]))
    const workspace = new Db9WorkspaceAdapter({ dbId: 'db-1', client: { executeSQL } })

    const result = await workspace.query({ sql: 'select 42 as answer' })
    expect(result).toEqual({ columns: ['answer'], rows: [{ answer: 42 }], rowCount: 1 })

    const events = workspace.watch('/workspace')
    const iterator = events[Symbol.asyncIterator]()
    await workspace.write('/workspace/a.txt', 'hello')
    const event = await iterator.next()
    expect(event.value).toMatchObject({ type: 'write', path: '/workspace/a.txt' })
    await iterator.return?.()
  })

  it('creates parent directories before writing nested fs9 paths', async () => {
    const executeSQL = vi.fn()
      .mockResolvedValueOnce(db9Result(['ok'], [[true]]))
      .mockResolvedValueOnce(db9Result(['bytes'], [[5]]))
    const workspace = new Db9WorkspaceAdapter({ dbId: 'db-1', client: { executeSQL } })

    await workspace.write('/runs/run_1/dynamic-worker/request.json', 'hello')

    expect(executeSQL).toHaveBeenNthCalledWith(1, 'db-1', "SELECT fs9_mkdir('/runs/run_1/dynamic-worker', true) AS ok")
    expect(executeSQL).toHaveBeenNthCalledWith(2, 'db-1', expect.stringContaining("fs9_write('/runs/run_1/dynamic-worker/request.json'"))
  })

  it('surfaces db9 SQL-level errors even when the HTTP request succeeded', async () => {
    const executeSQL = vi.fn()
      .mockResolvedValueOnce(db9Result(['ok'], [[true]]))
      .mockResolvedValueOnce(db9Error('ERROR: fs: NotFound: put_file /runs/run_1/request.json: fs: not found | sqlstate: XX000'))
    const workspace = new Db9WorkspaceAdapter({ dbId: 'db-1', client: { executeSQL } })

    await expect(workspace.write('/runs/run_1/request.json', 'hello')).rejects.toThrow('db9 SQL error')
  })

  it('uses the documented fs9 table function when listing files', async () => {
    const executeSQL = vi.fn()
      .mockResolvedValueOnce(db9Result([], []))
      .mockResolvedValueOnce(db9Result([{ name: 'path' }, { name: 'type' }, { name: 'size' }, { name: 'mtime' }], [
        ['/runs/run_1/request.json', 'file', 5, '2026-05-27T00:00:00.000Z'],
      ]))
    const workspace = new Db9WorkspaceAdapter({ dbId: 'db-1', client: { executeSQL } })

    await expect(workspace.list('/runs', { recursive: true })).resolves.toEqual([expect.objectContaining({
      path: '/runs/run_1/request.json',
      name: 'request.json',
      type: 'file',
      size: 5,
      modifiedAt: '2026-05-27T00:00:00.000Z',
    })])

    expect(executeSQL).toHaveBeenNthCalledWith(1, 'db-1', 'CREATE EXTENSION IF NOT EXISTS fs9')
    expect(executeSQL).toHaveBeenNthCalledWith(2, 'db-1', "SELECT DISTINCT _path AS path, 'file' AS type, NULL::bigint AS size, NULL::bigint AS mode, NULL::text AS mtime FROM extensions.fs9('/runs/**/*')")
  })

  it('uses a transport-backed db9 watch path when one is configured', async () => {
    const event: WorkspaceEvent = {
      type: 'write',
      timestamp: '2026-05-27T00:00:00.000Z',
      path: '/workspace/a.txt',
    }
    const watch = vi.fn(async function* () {
      yield event
    })
    const workspace = new Db9WorkspaceAdapter({
      dbId: 'db-1',
      client: { executeSQL: vi.fn() },
      watchTransport: { watch },
    })

    const iterator = workspace.watch('/workspace')[Symbol.asyncIterator]()

    await expect(iterator.next()).resolves.toEqual({ value: event, done: false })
    expect(watch).toHaveBeenCalledWith('db-1', '/workspace', {})
    expect(workspace.capabilities.nativeWatch).toBe(true)
    expect(workspace.capabilities.provider?.watch).toBe('transport')
  })

  it('creates fs9-backed checkpoints, diffs, and rollbacks without claiming db9 branch support', async () => {
    const client = createFs9Client({ '/workspace/a.txt': 'one' })
    const workspace = new Db9WorkspaceAdapter({
      dbId: 'db-1',
      client,
    })

    const first = await workspace.checkpoint('first')
    await workspace.write('/workspace/a.txt', 'two')
    const second = await workspace.checkpoint('second')

    const diff = await workspace.diff(first, second)
    expect(diff.entries).toEqual([{
      path: '/workspace/a.txt',
      kind: 'modified',
      oldSize: 3,
      newSize: 3,
    }])

    await workspace.rollback(first)
    await expect(workspace.read('/workspace/a.txt')).resolves.toBe('one')
    const checkpoints = await workspace.query({ kind: 'checkpoints' })
    expect(checkpoints.rows).toHaveLength(2)
    expect(workspace.capabilities.checkpoint).toBe(true)
    expect(workspace.capabilities.branch).toBe(false)
    expect(workspace.capabilities.provider?.checkpoint).toBe('fs9-snapshot')
  })

  it('scopes agent run checkpoints to the active run files', async () => {
    const client = createFs9Client({
      '/agents/codex/runs/run_1/state.json': '{"status":"started"}',
      '/agents/codex/runs/old_run/state.json': '{"status":"old"}',
      '/.sandbank/oplog.jsonl': '{"action":"run.started"}\n',
    })
    const workspace = new Db9WorkspaceAdapter({
      dbId: 'db-1',
      client,
    })

    const checkpoint = await workspace.checkpoint('agent:codex:run:run_1:before')
    const raw = client.files.get(`/.sandbank/checkpoints/${checkpoint.id}.json`)
    expect(raw).toBeTruthy()
    const snapshot = JSON.parse(raw!) as { files: Array<{ path: string }> }

    expect(snapshot.files.map(file => file.path).sort()).toEqual([
      '/.sandbank/oplog.jsonl',
      '/agents/codex/runs/run_1/state.json',
    ])
  })

  it('exposes db9 search, function invoke, scoped token, and branch entrypoints when the client supports them', async () => {
    const invokeFunction = vi.fn(async () => ({ ok: true, output: { value: 1 } }))
    const createScopedToken = vi.fn(async () => ({
      token: 'scoped-token',
      expiresAt: '2026-05-27T00:00:00.000Z',
    }))
    const createBranch = vi.fn(async () => ({
      id: 'branch-1',
      name: 'run-branch',
      state: 'ready',
      host: 'pg.db9.io',
      port: 5433,
      username: 'admin',
      password: 'secret',
      database: 'postgres',
      connection_string: 'postgres://example',
      created_at: '2026-05-27T00:00:00.000Z',
    }))
    const executeSQL = vi.fn(async (_dbId: string, sql: string) => {
      if (sql.includes('fs9_search')) return db9Result(['path', 'score'], [['/workspace/a.md', 0.92]])
      if (sql.includes('fs9_vector_search')) return db9Result(['path', 'score'], [['/workspace/b.md', 0.84]])
      return db9Result(['ok'], [[true]])
    })
    const workspace = new Db9WorkspaceAdapter({
      dbId: 'db-1',
      client: { executeSQL, invokeFunction, createScopedToken, createBranch },
    })

    await expect(workspace.query({ kind: 'search', text: 'agent harness', path: '/workspace', limit: 5 })).resolves.toMatchObject({
      rows: [{ path: '/workspace/a.md', score: 0.92 }],
    })
    await expect(workspace.search({
      mode: 'vector',
      text: 'agent harness',
      vector: [0.1, 0.2],
      path: '/workspace',
    })).resolves.toMatchObject({
      rows: [{ path: '/workspace/b.md', score: 0.84 }],
    })
    await expect(workspace.invokeFunction('summarize', { path: '/workspace/a.md' }, {
      fs9Scope: '/workspace:ro',
    })).resolves.toEqual({ ok: true, output: { value: 1 } })
    await expect(workspace.createScopedToken({
      name: 'capsule',
      fs9Scope: '/workspace:rw',
      sql: 'read',
      functions: ['summarize'],
    })).resolves.toMatchObject({ token: 'scoped-token' })
    await expect(workspace.createBranch('run-branch')).resolves.toMatchObject({ id: 'branch-1' })

    expect(invokeFunction).toHaveBeenCalledWith('db-1', 'summarize', { path: '/workspace/a.md' }, { fs9Scope: '/workspace:ro' })
    expect(createScopedToken).toHaveBeenCalledWith('db-1', {
      name: 'capsule',
      fs9Scope: '/workspace:rw',
      sql: 'read',
      functions: ['summarize'],
    })
    expect(workspace.capabilities.functionRuntime).toBe(true)
    expect(workspace.capabilities.provider?.functionFs9Scope).toBe('db9-function-option')
    expect(workspace.capabilities.provider?.scopedToken).toBe('db9-rest')
  })

  it('keeps unsupported db9 capabilities explicit when no supporting client path exists', async () => {
    const workspace = new Db9WorkspaceAdapter({
      dbId: 'db-1',
      client: { executeSQL: vi.fn() },
    })

    expect(workspace.capabilities.functionRuntime).toBe(false)
    expect(workspace.capabilities.provider?.functionRuntime).toBe('unsupported')
    await expect(workspace.invokeFunction('missing', {})).rejects.toThrow('not supported')
    await expect(workspace.search({ mode: 'vector', text: 'x', path: '/workspace' })).rejects.toThrow(WorkspaceError)
  })
})

function createFs9Client(initial: Record<string, string>): Db9WorkspaceClient & { files: Map<string, string> } {
  const files = new Map(Object.entries(initial))
  const executeSQL = vi.fn(async (_dbId: string, sql: string) => {
    const args = sqlStrings(sql)
    if (sql.startsWith('CREATE EXTENSION')) {
      return db9Result([], [])
    }
    if (sql.includes('extensions.fs9')) {
      const pattern = args.at(-1) ?? '/'
      const prefix = pattern.endsWith('/**/*')
        ? pattern.slice(0, -'/**/*'.length) || '/'
        : pattern
      const normalizedPrefix = prefix.endsWith('/') && prefix !== '/' ? prefix.slice(0, -1) : prefix
      const rows = [...files.entries()]
        .filter(([path]) => normalizedPrefix === '/' ? true : path.startsWith(`${normalizedPrefix}/`))
        .map(([path, data]) => [path, 'file', new TextEncoder().encode(data).byteLength, '2026-05-27T00:00:00.000Z'])
      return db9Result(['path', 'type', 'size', 'mtime'], rows)
    }
    if (sql.includes('fs9_read')) {
      return db9Result(['data'], [[files.get(args[0] ?? '/') ?? null]])
    }
    if (sql.includes('fs9_exists')) {
      const path = args[0] ?? '/'
      const data = files.get(path)
      return db9Result(['exists', 'size', 'modified_at'], [[data !== undefined, data ? new TextEncoder().encode(data).byteLength : null, '2026-05-27T00:00:00.000Z']])
    }
    if (sql.includes('fs9_write')) {
      files.set(args[0] ?? '/', args[1] ?? '')
      return db9Result(['ok'], [[true]])
    }
    if (sql.includes('fs9_append')) {
      const path = args[0] ?? '/'
      files.set(path, `${files.get(path) ?? ''}${args[1] ?? ''}`)
      return db9Result(['ok'], [[true]])
    }
    if (sql.includes('fs9_remove')) {
      files.delete(args[0] ?? '/')
      return db9Result(['ok'], [[true]])
    }
    if (sql.includes('fs9_mkdir')) {
      return db9Result(['ok'], [[true]])
    }
    return db9Result(['ok'], [[true]])
  })
  return { files, executeSQL }
}

function sqlStrings(sql: string): string[] {
  const values: string[] = []
  const pattern = /'((?:''|[^'])*)'/g
  let match: RegExpExecArray | null
  while ((match = pattern.exec(sql))) values.push(match[1]!.replace(/''/g, "'"))
  return values
}
