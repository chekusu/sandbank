import { describe, expect, it, vi } from 'vitest'
import { Db9WorkspaceAdapter } from '../src/workspace-adapter.js'

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

  it('declares unsupported advanced capabilities instead of emulating them', async () => {
    const workspace = new Db9WorkspaceAdapter({
      dbId: 'db-1',
      client: { executeSQL: vi.fn() },
    })

    expect(workspace.capabilities.checkpoint).toBe(false)
    await expect(workspace.checkpoint('demo')).rejects.toThrow('not supported')
  })
})
