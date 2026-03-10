import { describe, it, expect, vi, beforeEach } from 'vitest'
import { createDb9Observer, EVENTS_SCHEMA } from '../src/db9-observer.js'
import type { Db9Client } from '../src/client.js'
import type { SandboxEvent } from '@sandbank.dev/core'

function mockClient(): Db9Client {
  return {
    executeSQL: vi.fn(async () => ({ columns: [], rows: [] })),
  } as unknown as Db9Client
}

function makeEvent(overrides: Partial<SandboxEvent> = {}): SandboxEvent {
  return {
    type: 'sandbox:exec',
    sandboxId: 'sb-1',
    timestamp: 1710000000000,
    data: { command: 'echo hi', exitCode: 0, duration: 42 },
    ...overrides,
  }
}

describe('createDb9Observer', () => {
  let client: Db9Client

  beforeEach(() => {
    client = mockClient()
  })

  it('initializes schema on first event', async () => {
    const observer = createDb9Observer(client, 'db-test')
    await observer.onEvent(makeEvent())

    const calls = (client.executeSQL as ReturnType<typeof vi.fn>).mock.calls
    expect(calls[0]![0]).toBe('db-test')
    expect(calls[0]![1]).toBe(EVENTS_SCHEMA)
  })

  it('initializes schema only once', async () => {
    const observer = createDb9Observer(client, 'db-test')
    await observer.onEvent(makeEvent())
    await observer.onEvent(makeEvent())
    await observer.onEvent(makeEvent())

    const calls = (client.executeSQL as ReturnType<typeof vi.fn>).mock.calls
    // 1 schema init + 3 inserts = 4 calls
    expect(calls).toHaveLength(4)
    // Only first call is schema init
    expect(calls[0]![1]).toBe(EVENTS_SCHEMA)
    // Rest are inserts
    expect(calls[1]![1]).toContain('INSERT INTO sandbox_events')
    expect(calls[2]![1]).toContain('INSERT INTO sandbox_events')
    expect(calls[3]![1]).toContain('INSERT INTO sandbox_events')
  })

  it('inserts event with correct fields', async () => {
    const observer = createDb9Observer(client, 'db-test')
    await observer.onEvent(makeEvent({ taskId: 'task-1' }))

    const calls = (client.executeSQL as ReturnType<typeof vi.fn>).mock.calls
    const insertSql = calls[1]![1] as string
    expect(insertSql).toContain("'sandbox:exec'")
    expect(insertSql).toContain("'sb-1'")
    expect(insertSql).toContain("'task-1'")
    expect(insertSql).toContain('echo hi')
  })

  it('inserts NULL for taskId when not provided', async () => {
    const observer = createDb9Observer(client, 'db-test')
    await observer.onEvent(makeEvent())

    const calls = (client.executeSQL as ReturnType<typeof vi.fn>).mock.calls
    const insertSql = calls[1]![1] as string
    expect(insertSql).toContain('NULL')
  })

  it('escapes single quotes in data', async () => {
    const observer = createDb9Observer(client, 'db-test')
    await observer.onEvent(makeEvent({
      data: { command: "echo 'hello'" },
    }))

    const calls = (client.executeSQL as ReturnType<typeof vi.fn>).mock.calls
    const insertSql = calls[1]![1] as string
    // Single quotes should be doubled for SQL escaping
    expect(insertSql).toContain("''hello''")
  })

  it('converts timestamp to timestamptz', async () => {
    const observer = createDb9Observer(client, 'db-test')
    await observer.onEvent(makeEvent({ timestamp: 1710000000000 }))

    const calls = (client.executeSQL as ReturnType<typeof vi.fn>).mock.calls
    const insertSql = calls[1]![1] as string
    expect(insertSql).toContain('to_timestamp(1710000000)')
  })

  it('handles different event types', async () => {
    const observer = createDb9Observer(client, 'db-test')

    await observer.onEvent(makeEvent({ type: 'sandbox:writeFile', data: { path: '/a', size: 10 } }))
    await observer.onEvent(makeEvent({ type: 'sandbox:readFile', data: { path: '/b' } }))

    const calls = (client.executeSQL as ReturnType<typeof vi.fn>).mock.calls
    expect(calls[1]![1]).toContain("'sandbox:writeFile'")
    expect(calls[2]![1]).toContain("'sandbox:readFile'")
  })

  it('uses correct dbId for all queries', async () => {
    const observer = createDb9Observer(client, 'my-db-123')
    await observer.onEvent(makeEvent())

    const calls = (client.executeSQL as ReturnType<typeof vi.fn>).mock.calls
    expect(calls[0]![0]).toBe('my-db-123')
    expect(calls[1]![0]).toBe('my-db-123')
  })
})
