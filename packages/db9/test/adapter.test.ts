import { describe, it, expect, vi, beforeEach } from 'vitest'
import { Db9ServiceAdapter } from '../src/adapter.js'
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

function emptyResponse(status = 204) {
  return new Response(null, { status })
}

const MOCK_DB: Db9Database = {
  id: 'db-123',
  name: 'test-db',
  state: 'ready',
  host: 'pg.db9.io',
  port: 5433,
  username: 'db-123.admin',
  password: 'secret',
  database: 'postgres',
  connection_string: 'postgresql://db-123.admin:secret@pg.db9.io:5433/postgres',
  created_at: '2026-03-09T00:00:00Z',
}

describe('Db9ServiceAdapter', () => {
  let adapter: Db9ServiceAdapter

  beforeEach(() => {
    mockFetch.mockReset()
    adapter = new Db9ServiceAdapter({ token: 'test-token' })
  })

  describe('createService', () => {
    it('creates a database and returns ServiceInfo', async () => {
      mockFetch.mockResolvedValueOnce(jsonResponse(MOCK_DB))
      const info = await adapter.createService({ type: 'postgres', name: 'test-db' })
      expect(info.id).toBe('db-123')
      expect(info.type).toBe('postgres')
      expect(info.state).toBe('ready')
      expect(info.credentials.url).toBe(MOCK_DB.connection_string)
      expect(info.credentials.env.DATABASE_URL).toBe(MOCK_DB.connection_string)
      expect(info.credentials.env.PGHOST).toBe('pg.db9.io')
      expect(info.credentials.env.PGPORT).toBe('5433')
      expect(info.credentials.env.DB9_DATABASE_ID).toBe('db-123')
    })
  })

  describe('getService', () => {
    it('gets database details and returns ServiceInfo', async () => {
      mockFetch.mockResolvedValueOnce(jsonResponse(MOCK_DB))
      const info = await adapter.getService('db-123')
      expect(info.id).toBe('db-123')
      expect(info.credentials.env.PGUSER).toBe('db-123.admin')
    })
  })

  describe('listServices', () => {
    it('lists all databases as ServiceInfo[]', async () => {
      mockFetch.mockResolvedValueOnce(jsonResponse([MOCK_DB]))
      const list = await adapter.listServices()
      expect(list).toHaveLength(1)
      expect(list[0]!.id).toBe('db-123')
    })
  })

  describe('destroyService', () => {
    it('deletes the database', async () => {
      mockFetch.mockResolvedValueOnce(emptyResponse())
      await adapter.destroyService('db-123')
      expect(mockFetch).toHaveBeenCalledWith(
        expect.stringContaining('/databases/db-123'),
        expect.objectContaining({ method: 'DELETE' }),
      )
    })
  })

  describe('branchService', () => {
    it('creates a branch and returns ServiceInfo', async () => {
      const branchDb = { ...MOCK_DB, id: 'br-1', name: 'feature' }
      mockFetch.mockResolvedValueOnce(jsonResponse(branchDb))
      const info = await adapter.branchService('db-123', 'feature')
      expect(info.id).toBe('br-1')
      expect(info.name).toBe('feature')
    })

    it('deletes a branch', async () => {
      mockFetch.mockResolvedValueOnce(emptyResponse())
      await adapter.deleteBranch('br-1')
      expect(mockFetch).toHaveBeenCalledWith(
        expect.stringContaining('/databases/br-1'),
        expect.objectContaining({ method: 'DELETE' }),
      )
    })
  })

  describe('state mapping', () => {
    it('maps creating state', async () => {
      mockFetch.mockResolvedValueOnce(jsonResponse({ ...MOCK_DB, state: 'creating' }))
      const info = await adapter.getService('db-123')
      expect(info.state).toBe('creating')
    })

    it('maps terminated state', async () => {
      mockFetch.mockResolvedValueOnce(jsonResponse({ ...MOCK_DB, state: 'terminated' }))
      const info = await adapter.getService('db-123')
      expect(info.state).toBe('terminated')
    })

    it('maps deleted state to terminated', async () => {
      mockFetch.mockResolvedValueOnce(jsonResponse({ ...MOCK_DB, state: 'deleted' }))
      const info = await adapter.getService('db-123')
      expect(info.state).toBe('terminated')
    })

    it('maps unknown state to error', async () => {
      mockFetch.mockResolvedValueOnce(jsonResponse({ ...MOCK_DB, state: 'unknown' }))
      const info = await adapter.getService('db-123')
      expect(info.state).toBe('error')
    })
  })

  describe('getSkill', () => {
    beforeEach(() => clearSkillCache())

    it('uses custom skillContent when provided', async () => {
      const custom = new Db9ServiceAdapter({ token: 'test', skillContent: '# Custom Skill' })
      const skill = await custom.getSkill()
      expect(skill.name).toBe('db9-postgres')
      expect(skill.content).toBe('# Custom Skill')
    })

    it('fetches from remote when no custom content', async () => {
      mockFetch.mockResolvedValueOnce(new Response('# db9 Skill', { status: 200 }))
      const skill = await adapter.getSkill()
      expect(skill.name).toBe('db9-postgres')
      expect(skill.content).toBe('# db9 Skill')
    })
  })
})
