import { describe, expect, it, vi } from 'vitest'
import { WorkspaceError, type WorkspaceEvent } from '@sandbank.dev/workspace'
import { Db9WorkspaceAdapter, type Db9WorkspaceClient } from '../src/workspace-adapter.js'

function db9Result(columns: string[], rows: unknown[][]) {
  return { columns, rows, row_count: rows.length }
}

describe('Db9WorkspaceAdapter', () => {
  it('maps read/write/list/stat/remove to fs9 SQL calls', async () => {
    const executeSQL = vi.fn()
      .mockResolvedValueOnce(db9Result(['data'], [['hello']]))
      .mockResolvedValueOnce(db9Result(['ok'], [[true]]))
      .mockResolvedValueOnce(db9Result(['path', 'name', 'type', 'size', 'modified_at'], [
        ['/workspace/a.txt', 'a.txt', 'file', 5, '2026-05-27T00:00:00.000Z'],
      ]))
      .mockResolvedValueOnce(db9Result(['path', 'name', 'type', 'size', 'modified_at'], [
        ['/workspace/a.txt', 'a.txt', 'file', 5, '2026-05-27T00:00:00.000Z'],
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
    expect(executeSQL).toHaveBeenNthCalledWith(2, 'db-1', expect.stringContaining('fs9_write'))
    expect(executeSQL).toHaveBeenNthCalledWith(3, 'db-1', expect.stringContaining('fs9_list'))
    expect(executeSQL).toHaveBeenNthCalledWith(4, 'db-1', expect.stringContaining('fs9_stat'))
    expect(executeSQL).toHaveBeenNthCalledWith(5, 'db-1', expect.stringContaining('fs9_remove'))
  })

  it('runs SQL queries and exposes local watch events for adapter writes', async () => {
    const executeSQL = vi.fn()
      .mockResolvedValueOnce(db9Result(['answer'], [[42]]))
      .mockResolvedValueOnce(db9Result(['ok'], [[true]]))
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
    if (sql.includes('fs9_list')) {
      const prefix = args[0] ?? '/'
      const rows = [...files.entries()]
        .filter(([path]) => path === prefix || path.startsWith(`${prefix === '/' ? '' : prefix}/`))
        .map(([path, data]) => [path, path.split('/').pop() ?? path, 'file', new TextEncoder().encode(data).byteLength, '2026-05-27T00:00:00.000Z'])
      return db9Result(['path', 'name', 'type', 'size', 'modified_at'], rows)
    }
    if (sql.includes('fs9_read')) {
      return db9Result(['data'], [[files.get(args[0] ?? '/') ?? null]])
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
