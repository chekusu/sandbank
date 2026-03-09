import { describe, it, expect, vi, beforeEach } from 'vitest'
import { createDb9Service, createDb9Brain } from '../src/convenience.js'
import { clearSkillCache } from '../src/skill.js'
import type { Db9Database } from '../src/types.js'

const mockFetch = vi.fn()
vi.stubGlobal('fetch', mockFetch)

function jsonResponse(data: unknown, status = 200) {
  return new Response(JSON.stringify(data), {
    status,
    headers: { 'Content-Type': 'application/json' },
  })
}

const MOCK_DB: Db9Database = {
  id: 'db-conv',
  name: 'conv-db',
  state: 'ready',
  host: 'pg.db9.io',
  port: 5433,
  username: 'admin',
  password: 'pass',
  database: 'postgres',
  connection_string: 'postgresql://admin:pass@pg.db9.io:5433/postgres',
  created_at: '2026-03-09T00:00:00Z',
}

describe('createDb9Service', () => {
  beforeEach(() => {
    mockFetch.mockReset()
    clearSkillCache()
  })

  it('returns service, skill, and adapter', async () => {
    // createDatabase
    mockFetch.mockResolvedValueOnce(jsonResponse(MOCK_DB))
    // fetchDb9Skill
    mockFetch.mockResolvedValueOnce(new Response('# skill', { status: 200 }))

    const { service, skill, adapter } = await createDb9Service({
      token: 'tok',
      name: 'conv-db',
    })

    expect(service.id).toBe('db-conv')
    expect(service.credentials.env.DATABASE_URL).toBeTruthy()
    expect(skill.name).toBe('db9-postgres')
    expect(skill.content).toBe('# skill')
    expect(adapter).toBeDefined()
  })
})

describe('createDb9Brain', () => {
  beforeEach(() => {
    mockFetch.mockReset()
    clearSkillCache()
  })

  it('returns service with brain skills (db9 + brain)', async () => {
    // createDatabase
    mockFetch.mockResolvedValueOnce(jsonResponse(MOCK_DB))
    // fetchDb9Skill
    mockFetch.mockResolvedValueOnce(new Response('# skill', { status: 200 }))
    // initBrainSchema: CREATE EXTENSION
    mockFetch.mockResolvedValueOnce(jsonResponse({ columns: [], rows: [], row_count: 0 }))
    // initBrainSchema: BRAIN_SCHEMA
    mockFetch.mockResolvedValueOnce(jsonResponse({ columns: [], rows: [], row_count: 0 }))

    const { service, skills, adapter } = await createDb9Brain({
      token: 'tok',
      name: 'brain-db',
    })

    expect(service.id).toBe('db-conv')
    expect(skills).toHaveLength(2)
    expect(skills[0]!.name).toBe('db9-postgres')
    expect(skills[1]!.name).toBe('brain')
    expect(adapter).toBeDefined()
  })

  it('throws when database is not ready and cleans up', async () => {
    const creatingDb = { ...MOCK_DB, state: 'creating' }
    mockFetch.mockResolvedValueOnce(jsonResponse(creatingDb))
    mockFetch.mockResolvedValueOnce(new Response('# skill', { status: 200 }))
    // destroyService DELETE call
    mockFetch.mockResolvedValueOnce(new Response(null, { status: 204 }))

    await expect(
      createDb9Brain({ token: 'tok', name: 'brain-db' }),
    ).rejects.toThrow('not ready')

    // Verify destroyService was called to clean up the database
    const deleteCall = mockFetch.mock.calls.find(
      (call) => {
        const url = call[0] as string
        const init = call[1] as RequestInit | undefined
        return url.includes(`/databases/${MOCK_DB.id}`) && init?.method === 'DELETE'
      },
    )
    expect(deleteCall).toBeDefined()
  })

  it('propagates initBrainSchema errors and cleans up database', async () => {
    // createDatabase succeeds
    mockFetch.mockResolvedValueOnce(jsonResponse(MOCK_DB))
    // fetchDb9Skill succeeds
    mockFetch.mockResolvedValueOnce(new Response('# skill', { status: 200 }))
    // initBrainSchema: CREATE EXTENSION fails
    mockFetch.mockResolvedValueOnce(
      new Response(JSON.stringify({ error: 'extension not available' }), { status: 500 }),
    )
    // destroyService DELETE call
    mockFetch.mockResolvedValueOnce(new Response(null, { status: 204 }))

    await expect(
      createDb9Brain({ token: 'tok', name: 'brain-db' }),
    ).rejects.toThrow('extension not available')

    // Verify destroyService was called to clean up the database
    const deleteCall = mockFetch.mock.calls.find(
      (call) => {
        const url = call[0] as string
        const init = call[1] as RequestInit | undefined
        return url.includes(`/databases/${MOCK_DB.id}`) && init?.method === 'DELETE'
      },
    )
    expect(deleteCall).toBeDefined()
  })
})
