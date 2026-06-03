import { WorkspaceError, type WorkspaceAdapter } from '@sandbank.dev/workspace'

export type AgentMemoryType = 'pinned' | 'insight' | 'session'
export type AgentMemoryState = 'active' | 'paused' | 'archived' | 'deleted'

export interface AgentMemory {
  id: string
  agentId: string
  content: string
  memoryType: AgentMemoryType
  state: AgentMemoryState
  tags: string[]
  metadata?: Record<string, unknown>
  runId?: string
  sessionId?: string
  source?: string
  createdAt: string
  updatedAt: string
}

export interface AgentMemoryStoreOptions {
  agentId: string
  workspace: WorkspaceAdapter
  id?: () => string
  now?: () => Date
}

export interface CreateAgentMemoryInput {
  content: string
  memoryType?: AgentMemoryType
  tags?: string[]
  metadata?: Record<string, unknown>
  runId?: string
  sessionId?: string
  source?: string
}

export interface RecordSessionMemoryInput {
  inputText: string
  outputText: string
  runId: string
  sessionId?: string
  metadata?: Record<string, unknown>
}

export interface SearchAgentMemoriesInput {
  query?: string
  limit?: number
  memoryTypes?: AgentMemoryType[]
  tags?: string[]
  sessionId?: string
  state?: AgentMemoryState
}

const DEFAULT_LIMIT = 5

export class AgentMemoryStore {
  private readonly agentId: string
  private readonly workspace: WorkspaceAdapter
  private readonly id: () => string
  private readonly now: () => Date

  constructor(options: AgentMemoryStoreOptions) {
    this.agentId = sanitizePathSegment(options.agentId)
    this.workspace = options.workspace
    this.id = options.id ?? (() => createMemoryId())
    this.now = options.now ?? (() => new Date())
  }

  async createMemory(input: CreateAgentMemoryInput): Promise<AgentMemory> {
    const content = normalizeContent(input.content)
    if (!content) throw new Error('Agent memory content is required.')
    const timestamp = this.now().toISOString()
    const memory: AgentMemory = {
      id: this.id(),
      agentId: this.agentId,
      content,
      memoryType: input.memoryType ?? 'pinned',
      state: 'active',
      tags: normalizeTags(input.tags),
      metadata: input.metadata,
      runId: input.runId,
      sessionId: input.sessionId,
      source: input.source,
      createdAt: timestamp,
      updatedAt: timestamp,
    }
    await this.workspace.append(this.memoryIndexPath(), `${JSON.stringify(toStoredMemory(memory))}\n`)
    return memory
  }

  async recordSessionMemory(input: RecordSessionMemoryInput): Promise<AgentMemory | undefined> {
    const content = [
      input.inputText.trim() ? `User: ${input.inputText.trim()}` : '',
      input.outputText.trim() ? `Assistant: ${input.outputText.trim()}` : '',
    ].filter(Boolean).join('\n')
    if (!content) return undefined
    return this.createMemory({
      content,
      memoryType: 'session',
      tags: ['session'],
      metadata: input.metadata,
      runId: input.runId,
      sessionId: input.sessionId ?? input.runId,
      source: 'harness-run',
    })
  }

  async searchMemories(input: SearchAgentMemoriesInput = {}): Promise<AgentMemory[]> {
    const memories = await this.listMemories()
    const state = input.state ?? 'active'
    const types = new Set(input.memoryTypes ?? ['pinned', 'insight', 'session'])
    const tags = new Set(normalizeTags(input.tags))
    const query = input.query?.trim() ?? ''
    const scored = memories
      .filter(memory => memory.agentId === this.agentId)
      .filter(memory => memory.state === state)
      .filter(memory => types.has(memory.memoryType))
      .filter(memory => !input.sessionId || memory.sessionId === input.sessionId)
      .filter(memory => tags.size === 0 || memory.tags.some(tag => tags.has(tag)))
      .map(memory => ({ memory, score: scoreMemory(memory, query) }))
      .filter(item => !query || item.score > 0 || isMemoryRecallQuery(query))
      .sort((a, b) => b.score - a.score || b.memory.updatedAt.localeCompare(a.memory.updatedAt))

    return scored.slice(0, clampLimit(input.limit)).map(item => item.memory)
  }

  async listMemories(): Promise<AgentMemory[]> {
    const raw = await this.workspace.read(this.memoryIndexPath()).catch(err => {
      if (err instanceof WorkspaceError && err.code === 'NOT_FOUND') return ''
      throw err
    })
    return String(raw)
      .split('\n')
      .map(line => line.trim())
      .filter(Boolean)
      .map(line => parseMemoryLine(line))
      .filter((memory): memory is AgentMemory => Boolean(memory))
  }

  memoryIndexPath(): string {
    return `/agents/${this.agentId}/memory/memories.jsonl`
  }
}

export function formatAgentMemoriesForPrompt(memories: AgentMemory[]): string {
  if (memories.length === 0) return ''
  const lines = [
    '<relevant-memories>',
    ...memories.map(memory => {
      const tags = memory.tags.length ? ` tags=${memory.tags.join(',')}` : ''
      return `- [${memory.memoryType}] ${memory.content}${tags}`
    }),
    '</relevant-memories>',
  ]
  return lines.join('\n')
}

export function extractExplicitMemoryContent(text: string | undefined): string | undefined {
  const value = text?.trim()
  if (!value) return undefined
  const patterns = [
    /\b(?:please\s+)?remember(?:\s+that)?[:：]?\s+(.+)$/i,
    /\b(?:save|store)\s+(?:this\s+)?(?:memory|fact)[:：]?\s+(.+)$/i,
    /(?:请)?记住[:：]?\s*(.+)$/i,
    /帮我记住[:：]?\s*(.+)$/i,
  ]
  for (const pattern of patterns) {
    const match = pattern.exec(value)
    const content = normalizeContent(match?.[1] ?? '')
    if (content) return content
  }
  return undefined
}

function scoreMemory(memory: AgentMemory, query: string): number {
  if (!query) return baseTypeScore(memory)
  const queryTokens = tokenSet(query)
  const contentTokens = tokenSet(`${memory.content} ${memory.tags.join(' ')}`)
  let score = baseTypeScore(memory)
  for (const token of queryTokens) {
    if (contentTokens.has(token)) score += 3
    else if (memory.content.toLowerCase().includes(token)) score += 1
  }
  if (memory.content.toLowerCase().includes(query.toLowerCase())) score += 4
  if (isMemoryRecallQuery(query)) score += 1
  return score
}

function baseTypeScore(memory: AgentMemory): number {
  if (memory.memoryType === 'pinned') return 3
  if (memory.memoryType === 'insight') return 2
  return 0
}

function isMemoryRecallQuery(query: string): boolean {
  return /remember|memory|recall|what do you know|记得|记住|记忆/i.test(query)
}

function tokenSet(value: string): Set<string> {
  return new Set(value.toLowerCase().match(/[\p{L}\p{N}]+/gu) ?? [])
}

function parseMemoryLine(line: string): AgentMemory | undefined {
  try {
    const raw = JSON.parse(line) as Record<string, unknown>
    const content = normalizeContent(String(raw['content'] ?? ''))
    const agentId = normalizeContent(String(raw['agent_id'] ?? raw['agentId'] ?? ''))
    const id = normalizeContent(String(raw['id'] ?? ''))
    if (!content || !agentId || !id) return undefined
    return {
      id,
      agentId: sanitizePathSegment(agentId),
      content,
      memoryType: normalizeMemoryType(raw['memory_type'] ?? raw['memoryType']),
      state: normalizeMemoryState(raw['state']),
      tags: Array.isArray(raw['tags']) ? normalizeTags(raw['tags'].map(String)) : [],
      metadata: isRecord(raw['metadata']) ? raw['metadata'] : undefined,
      runId: stringOrUndefined(raw['run_id'] ?? raw['runId']),
      sessionId: stringOrUndefined(raw['session_id'] ?? raw['sessionId']),
      source: stringOrUndefined(raw['source']),
      createdAt: stringOrUndefined(raw['created_at'] ?? raw['createdAt']) ?? '',
      updatedAt: stringOrUndefined(raw['updated_at'] ?? raw['updatedAt']) ?? '',
    }
  } catch {
    return undefined
  }
}

function toStoredMemory(memory: AgentMemory): Record<string, unknown> {
  return {
    id: memory.id,
    agent_id: memory.agentId,
    content: memory.content,
    memory_type: memory.memoryType,
    state: memory.state,
    tags: memory.tags,
    metadata: memory.metadata,
    run_id: memory.runId,
    session_id: memory.sessionId,
    source: memory.source,
    created_at: memory.createdAt,
    updated_at: memory.updatedAt,
  }
}

function normalizeMemoryType(value: unknown): AgentMemoryType {
  return value === 'insight' || value === 'session' || value === 'pinned' ? value : 'pinned'
}

function normalizeMemoryState(value: unknown): AgentMemoryState {
  return value === 'paused' || value === 'archived' || value === 'deleted' || value === 'active' ? value : 'active'
}

function normalizeTags(tags: string[] | undefined): string[] {
  return [...new Set((tags ?? [])
    .map(tag => tag.trim().toLowerCase())
    .filter(Boolean))]
}

function normalizeContent(value: string): string {
  return value.replace(/\s+/g, ' ').trim()
}

function stringOrUndefined(value: unknown): string | undefined {
  return typeof value === 'string' && value ? value : undefined
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return Boolean(value) && typeof value === 'object' && !Array.isArray(value)
}

function sanitizePathSegment(input: string): string {
  return input.replace(/\\/g, '/').split('/').filter(Boolean).join('_') || 'agent'
}

function clampLimit(limit: number | undefined): number {
  return Math.max(1, Math.min(50, Math.floor(limit ?? DEFAULT_LIMIT)))
}

function createMemoryId(): string {
  const random = typeof crypto !== 'undefined' && 'randomUUID' in crypto
    ? crypto.randomUUID().slice(0, 8)
    : Math.random().toString(36).slice(2, 10)
  return `mem_${Date.now().toString(36)}_${random}`
}
