import { describe, expect, it } from 'vitest'
import { MemoryWorkspaceAdapter } from '@sandbank.dev/workspace'
import {
  AgentMemoryStore,
  extractExplicitMemoryContent,
  formatAgentMemoriesForPrompt,
} from './agent-memory.js'

describe('AgentMemoryStore', () => {
  it('creates pinned and session memories and recalls relevant active entries for an agent', async () => {
    const workspace = new MemoryWorkspaceAdapter(undefined, { id: 'db9:test' })
    const store = new AgentMemoryStore({
      agentId: 'codex',
      workspace,
      id: () => 'mem_1',
      now: () => new Date('2026-06-03T00:00:00.000Z'),
    })
    const otherStore = new AgentMemoryStore({
      agentId: 'other',
      workspace,
      id: () => 'mem_other',
      now: () => new Date('2026-06-03T00:00:01.000Z'),
    })

    await store.createMemory({
      content: 'Use Cloudflare Dynamic Workers for harness capsule tests.',
      memoryType: 'pinned',
      tags: ['deployment', 'cloudflare'],
      runId: 'run_1',
    })
    await store.recordSessionMemory({
      inputText: 'We discussed local preview only.',
      outputText: 'No persistent deployment decision.',
      runId: 'run_1',
      sessionId: 'session_1',
    })
    await otherStore.createMemory({
      content: 'Other agent should not leak into codex recall.',
      memoryType: 'pinned',
    })

    const recalled = await store.searchMemories({
      query: 'How should the harness deployment capsule run?',
      limit: 1,
    })

    expect(recalled.map(memory => memory.content)).toEqual([
      'Use Cloudflare Dynamic Workers for harness capsule tests.',
    ])
    await expect(workspace.read('/agents/codex/memory/memories.jsonl')).resolves.toContain('"memory_type":"pinned"')
    expect(formatAgentMemoriesForPrompt(recalled)).toContain('[pinned] Use Cloudflare Dynamic Workers')
  })

  it('extracts explicit remember requests without keeping command scaffolding', () => {
    expect(extractExplicitMemoryContent('please remember that staging uses db9 fs9')).toBe('staging uses db9 fs9')
    expect(extractExplicitMemoryContent('请记住：默认模型是 DeepSeek V4 Pro')).toBe('默认模型是 DeepSeek V4 Pro')
    expect(extractExplicitMemoryContent('what did we deploy yesterday?')).toBeUndefined()
  })
})
