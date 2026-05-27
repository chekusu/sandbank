import { describe, expect, it } from 'vitest'
import { MemoryWorkspaceAdapter, WorkspaceError } from '../src/index.js'

describe('MemoryWorkspaceAdapter', () => {
  it('supports file lifecycle operations with directory listing and metadata', async () => {
    const workspace = new MemoryWorkspaceAdapter()

    await workspace.write('/files/notes/a.txt', 'hello')
    await workspace.append('/files/notes/a.txt', ' world')
    await workspace.write('/files/notes/b.txt', 'second')

    await expect(workspace.read('/files/notes/a.txt')).resolves.toBe('hello world')
    await expect(workspace.stat('/files/notes/a.txt')).resolves.toMatchObject({
      path: '/files/notes/a.txt',
      name: 'a.txt',
      type: 'file',
      size: 11,
    })

    const direct = await workspace.list('/files')
    expect(direct.map(entry => `${entry.type}:${entry.path}`)).toEqual(['directory:/files/notes'])

    await workspace.move('/files/notes/b.txt', '/files/archive/b.txt')
    await expect(workspace.read('/files/archive/b.txt')).resolves.toBe('second')

    await workspace.remove('/files/notes/a.txt')
    await expect(workspace.read('/files/notes/a.txt')).rejects.toThrow(WorkspaceError)
  })

  it('queries files and op log without pretending to support SQL', async () => {
    const workspace = new MemoryWorkspaceAdapter()

    await workspace.write('/files/a.txt', 'a')
    await workspace.write('/files/b.txt', 'b')
    const opId = await workspace.log({ action: 'agent.note', path: '/files/a.txt' })

    const files = await workspace.query({ kind: 'files', path: '/files' })
    expect(files.rows.map(row => (row as { path: string }).path)).toEqual([
      '/files/a.txt',
      '/files/b.txt',
    ])

    const log = await workspace.query({ kind: 'log' })
    expect(log.rows.some(row => (row as { id: string }).id === opId)).toBe(true)
    await expect(workspace.query({ sql: 'select 1' })).rejects.toThrow('SQL query is not supported')
  })

  it('checkpoints, diffs, and rolls back file state', async () => {
    const workspace = new MemoryWorkspaceAdapter()

    await workspace.write('/files/report.md', 'draft')
    const before = await workspace.checkpoint('before edit')
    await workspace.write('/files/report.md', 'final')
    await workspace.write('/files/new.md', 'new')

    const diff = await workspace.diff(before.ref, 'current')
    expect(diff.entries.map(entry => `${entry.kind}:${entry.path}`)).toEqual([
      'modified:/files/report.md',
      'added:/files/new.md',
    ])

    await workspace.rollback(before.ref)
    await expect(workspace.read('/files/report.md')).resolves.toBe('draft')
    await expect(workspace.stat('/files/new.md')).rejects.toThrow(WorkspaceError)
  })

  it('supports transactions, watches, and expiring locks', async () => {
    const workspace = new MemoryWorkspaceAdapter()
    const events = workspace.watch('/files')
    const iterator = events[Symbol.asyncIterator]()

    await workspace.transaction(async tx => {
      await tx.write('/files/inside.txt', 'committed')
    })

    const event = await iterator.next()
    expect(event.value).toMatchObject({ type: 'write', path: '/files/inside.txt' })
    await iterator.return?.()

    await expect(workspace.read('/files/inside.txt')).resolves.toBe('committed')

    const lock = await workspace.lock('/files/inside.txt', 1_000)
    await expect(workspace.lock('/files/inside.txt', 1_000)).rejects.toThrow('already locked')
    await lock.release()
    await expect(workspace.lock('/files/inside.txt', 1_000)).resolves.toMatchObject({
      resource: '/files/inside.txt',
    })
  })
})
