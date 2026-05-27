import { describe, expect, it } from 'vitest'
import { MemoryWorkspaceAdapter } from '@sandbank.dev/workspace'
import { createAgentWorkspaceClient } from '../src/workspace.js'

describe('createAgentWorkspaceClient', () => {
  it('maps durable state, tasks, artifacts, and op commits onto workspace paths', async () => {
    const workspace = new MemoryWorkspaceAdapter()
    const client = createAgentWorkspaceClient(workspace, { agentId: 'coder' })

    await client.writeState('summary.md', 'ready')
    await expect(client.readState('summary.md')).resolves.toBe('ready')

    await workspace.write('/messages/inbox/coder/task-1.json', JSON.stringify({ id: 'task-1' }))
    await expect(client.readTask<{ id: string }>('task-1')).resolves.toEqual({ id: 'task-1' })

    await client.writeArtifact('result.txt', 'done')
    await expect(workspace.read('/.artifacts/coder/result.txt')).resolves.toBe('done')

    const opId = await client.commitOp({ action: 'workspace.write', path: '/.artifacts/coder/result.txt' })
    const log = await workspace.query({ kind: 'log' })
    expect(log.rows.some(row => (row as { id: string }).id === opId)).toBe(true)
  })
})
