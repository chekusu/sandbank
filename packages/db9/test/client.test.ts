import { describe, it, expect, vi, beforeEach } from 'vitest'
import { Db9Client } from '../src/client.js'

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

describe('Db9Client', () => {
  let client: Db9Client

  beforeEach(() => {
    mockFetch.mockReset()
    client = new Db9Client({ token: 'test-token', baseUrl: 'https://db9.ai/api' })
  })

  it('sends authorization header', async () => {
    mockFetch.mockResolvedValueOnce(jsonResponse([]))
    await client.listDatabases()
    expect(mockFetch).toHaveBeenCalledWith(
      'https://db9.ai/api/customer/databases',
      expect.objectContaining({
        headers: expect.objectContaining({
          Authorization: 'Bearer test-token',
        }),
      }),
    )
  })

  it('createDatabase sends POST with name', async () => {
    const db = { id: 'db-1', name: 'myapp', state: 'ready' }
    mockFetch.mockResolvedValueOnce(jsonResponse(db))
    const result = await client.createDatabase('myapp')
    expect(result.id).toBe('db-1')
    expect(mockFetch).toHaveBeenCalledWith(
      'https://db9.ai/api/customer/databases',
      expect.objectContaining({
        method: 'POST',
        body: JSON.stringify({ name: 'myapp' }),
      }),
    )
  })

  it('getDatabase sends GET with id', async () => {
    const db = { id: 'db-1', name: 'myapp', state: 'ready' }
    mockFetch.mockResolvedValueOnce(jsonResponse(db))
    const result = await client.getDatabase('db-1')
    expect(result.id).toBe('db-1')
    expect(mockFetch).toHaveBeenCalledWith(
      'https://db9.ai/api/customer/databases/db-1',
      expect.objectContaining({ method: 'GET' }),
    )
  })

  it('deleteDatabase sends DELETE', async () => {
    mockFetch.mockResolvedValueOnce(emptyResponse())
    await client.deleteDatabase('db-1')
    expect(mockFetch).toHaveBeenCalledWith(
      'https://db9.ai/api/customer/databases/db-1',
      expect.objectContaining({ method: 'DELETE' }),
    )
  })

  it('executeSQL sends POST with query', async () => {
    const result = { columns: ['count'], rows: [[42]], row_count: 1 }
    mockFetch.mockResolvedValueOnce(jsonResponse(result))
    const res = await client.executeSQL('db-1', 'SELECT count(*) FROM users')
    expect(res.row_count).toBe(1)
    expect(mockFetch).toHaveBeenCalledWith(
      'https://db9.ai/api/customer/databases/db-1/sql',
      expect.objectContaining({
        method: 'POST',
        body: JSON.stringify({ query: 'SELECT count(*) FROM users' }),
      }),
    )
  })

  it('createBranch sends POST to branch endpoint', async () => {
    const branch = { id: 'br-1', name: 'feature', state: 'ready' }
    mockFetch.mockResolvedValueOnce(jsonResponse(branch))
    const result = await client.createBranch('db-1', 'feature')
    expect(result.id).toBe('br-1')
    expect(mockFetch).toHaveBeenCalledWith(
      'https://db9.ai/api/customer/databases/db-1/branch',
      expect.objectContaining({
        method: 'POST',
        body: JSON.stringify({ name: 'feature' }),
      }),
    )
  })

  it('throws on non-ok response', async () => {
    mockFetch.mockResolvedValueOnce(
      new Response(JSON.stringify({ error: 'Not found' }), { status: 404 }),
    )
    await expect(client.getDatabase('nonexistent')).rejects.toThrow('db9 API error')
  })

  it('throws on non-ok response without json body', async () => {
    mockFetch.mockResolvedValueOnce(
      new Response('Internal Server Error', { status: 500, statusText: 'Internal Server Error' }),
    )
    await expect(client.listDatabases()).rejects.toThrow('500')
  })

  it('uses message field from error response when error field is absent', async () => {
    mockFetch.mockResolvedValueOnce(
      new Response(JSON.stringify({ message: 'quota exceeded' }), { status: 429 }),
    )
    await expect(client.listDatabases()).rejects.toThrow('quota exceeded')
  })

  it('deleteBranch delegates to deleteDatabase', async () => {
    mockFetch.mockResolvedValueOnce(emptyResponse())
    await client.deleteBranch('br-1')
    expect(mockFetch).toHaveBeenCalledWith(
      'https://db9.ai/api/customer/databases/br-1',
      expect.objectContaining({ method: 'DELETE' }),
    )
  })

  it('uses default baseUrl when none provided', async () => {
    const defaultClient = new Db9Client({ token: 'tok' })
    mockFetch.mockResolvedValueOnce(jsonResponse([]))
    await defaultClient.listDatabases()
    expect(mockFetch).toHaveBeenCalledWith(
      'https://db9.ai/api/customer/databases',
      expect.anything(),
    )
  })

  it('strips trailing slash from baseUrl', async () => {
    const slashClient = new Db9Client({ token: 'tok', baseUrl: 'https://db9.ai/api/' })
    mockFetch.mockResolvedValueOnce(jsonResponse([]))
    await slashClient.listDatabases()
    expect(mockFetch).toHaveBeenCalledWith(
      'https://db9.ai/api/customer/databases',
      expect.anything(),
    )
  })
})
