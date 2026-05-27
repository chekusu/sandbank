import { describe, expect, it, vi } from 'vitest'
import { MemoryWorkspaceAdapter, WorkspaceError } from '@sandbank.dev/workspace'
import { Db9WorkspaceAdapter } from '@sandbank.dev/db9'
import { AgentSupervisor } from './agent-supervisor.js'

describe('AgentSupervisor', () => {
  it('manages run identity, checkpoint, policy-checked ops, audit log, and public run files on memory workspace', async () => {
    const workspace = new MemoryWorkspaceAdapter(undefined, { id: 'memory:test' })
    const events: string[] = []
    const supervisor = new AgentSupervisor({
      agentId: 'agent-a',
      workspace,
      modelId: 'deepseek-v4-pro',
      id: () => 'run_1',
      now: () => new Date('2026-05-27T00:00:00.000Z'),
      policy: {
        allowedOps: ['workspace.write', 'workspace.read', 'workspace.query'],
        writablePaths: ['/workspace'],
      },
    })

    const result = await supervisor.run({
      input: { message: 'draft a plan' },
      publicRunRoot: '/runs/run_1',
      onEvent: async event => { events.push(event.label) },
      modelLoop: async context => {
        expect(context.run.runId).toBe('run_1')
        expect(context.allowedOps).toContain('workspace.write')
        await context.executeOp({
          action: 'workspace.write',
          path: '/workspace/plan.md',
          data: 'plan',
        })
        return { text: 'done' }
      },
    })

    expect(result.run).toMatchObject({
      agentId: 'agent-a',
      workspaceId: 'memory:test',
      runId: 'run_1',
      status: 'completed',
    })
    expect(result.checkpoint?.ref).toContain('checkpoint:')
    await expect(workspace.read('/agents/agent-a/runs/run_1/state.json')).resolves.toContain('"status": "completed"')
    await expect(workspace.read('/runs/run_1/request.json')).resolves.toContain('"message": "draft a plan"')
    await expect(workspace.read('/runs/run_1/assistant.md')).resolves.toBe('done')
    await expect(workspace.read('/workspace/plan.md')).resolves.toBe('plan')
    const log = await workspace.query({ kind: 'log' })
    expect(log.rows.some(row => JSON.stringify(row).includes('op.workspace.write'))).toBe(true)
    expect(events).toEqual(expect.arrayContaining(['run.started', 'checkpoint.created', 'workspace.write', 'run.completed']))
  })

  it('stops restricted operations at the approval hook and records failed run state', async () => {
    const workspace = new MemoryWorkspaceAdapter(undefined, { id: 'memory:approval' })
    const supervisor = new AgentSupervisor({
      agentId: 'agent-a',
      workspace,
      modelId: 'deepseek-v4-pro',
      id: () => 'run_rejected',
      now: () => new Date('2026-05-27T00:00:00.000Z'),
      checkpointBeforeRun: false,
      policy: {
        allowedOps: ['workspace.write'],
        requireApproval: ['workspace.write'],
        writablePaths: ['/workspace'],
      },
      approvalHook: async () => 'rejected',
    })

    await expect(supervisor.run({
      input: { message: 'write secret' },
      modelLoop: async () => ({
        text: 'no-op',
        ops: [{ action: 'workspace.write', path: '/workspace/a.txt', data: 'x' }],
      }),
    })).rejects.toThrow(WorkspaceError)

    await expect(workspace.read('/agents/agent-a/runs/run_rejected/state.json')).resolves.toContain('"status": "failed"')
    await expect(workspace.read('/workspace/a.txt')).rejects.toThrow(WorkspaceError)
  })

  it('runs against a mocked db9 backend and uses db9 function capability when allowed', async () => {
    const executeSQL = vi.fn(async () => ({ columns: ['ok'], rows: [[true]], row_count: 1 }))
    const invokeFunction = vi.fn(async () => ({ ok: true, output: { summary: 'ok' } }))
    const workspace = new Db9WorkspaceAdapter({
      dbId: 'db-1',
      client: { executeSQL, invokeFunction },
    })
    const supervisor = new AgentSupervisor({
      agentId: 'agent-db9',
      workspace,
      modelId: 'deepseek-v4-pro',
      id: () => 'run_db9',
      now: () => new Date('2026-05-27T00:00:00.000Z'),
      checkpointBeforeRun: false,
      policy: {
        allowedOps: ['function.invoke'],
        functions: ['summarize'],
      },
    })

    const result = await supervisor.run({
      input: { message: 'summarize workspace' },
      publicRunRoot: '/runs/run_db9',
      modelLoop: async () => ({
        text: 'summary complete',
        ops: [{
          action: 'function.invoke',
          name: 'summarize',
          input: { path: '/workspace' },
          options: { fs9Scope: '/workspace:ro', timeoutMs: 1000 },
        }],
      }),
    })

    expect(result.run.status).toBe('completed')
    expect(invokeFunction).toHaveBeenCalledWith('db-1', 'summarize', { path: '/workspace' }, {
      fs9Scope: '/workspace:ro',
      timeoutMs: 1000,
    })
    const sqlCalls = executeSQL.mock.calls as unknown as Array<[string, string]>
    expect(sqlCalls.some(([, sql]) => String(sql).includes('fs9_write'))).toBe(true)
    expect(sqlCalls.some(([, sql]) => String(sql).includes('fs9_append'))).toBe(true)
  })
})
