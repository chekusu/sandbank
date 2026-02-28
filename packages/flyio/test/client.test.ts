import { describe, it, expect, vi, beforeEach } from 'vitest'
import { createFlyioClient } from '../src/client.js'

// --- Mock global fetch ---

const mockFetch = vi.fn()
vi.stubGlobal('fetch', mockFetch)

function mockResponse(body: unknown, status = 200) {
  return {
    ok: status >= 200 && status < 300,
    status,
    text: vi.fn().mockResolvedValue(typeof body === 'string' ? body : JSON.stringify(body)),
  }
}

function emptyResponse(status = 200) {
  return {
    ok: status >= 200 && status < 300,
    status,
    text: vi.fn().mockResolvedValue(''),
  }
}

const config = { apiToken: 'test-token-123', appName: 'my-app' }

describe('createFlyioClient', () => {
  beforeEach(() => {
    vi.clearAllMocks()
  })

  it('sends correct auth header', async () => {
    mockFetch.mockResolvedValue(mockResponse([]))
    const client = createFlyioClient(config)

    await client.listMachines()

    expect(mockFetch).toHaveBeenCalledWith(
      'https://api.machines.dev/v1/apps/my-app/machines',
      expect.objectContaining({
        headers: expect.objectContaining({
          'Authorization': 'Bearer test-token-123',
          'Content-Type': 'application/json',
        }),
      }),
    )
  })

  it('throws on non-ok response', async () => {
    mockFetch.mockResolvedValue(mockResponse('not found', 404))
    const client = createFlyioClient(config)

    await expect(client.getMachine('m-123')).rejects.toThrow('Fly.io API error 404: not found')
  })

  it('createMachine sends correct body', async () => {
    const machine = { id: 'm-1', name: 'test', state: 'started', region: 'nrt', config: {} }
    mockFetch.mockResolvedValue(mockResponse(machine))
    const client = createFlyioClient(config)

    await client.createMachine({
      image: 'node:22',
      env: { NODE_ENV: 'production' },
      guest: { cpu_kind: 'shared', cpus: 2, memory_mb: 512 },
    })

    const [url, opts] = mockFetch.mock.calls[0]!
    expect(url).toBe('https://api.machines.dev/v1/apps/my-app/machines')
    expect(opts.method).toBe('POST')
    const body = JSON.parse(opts.body as string)
    expect(body.config.image).toBe('node:22')
    expect(body.config.env).toEqual({ NODE_ENV: 'production' })
    expect(body.config.guest).toEqual({ cpu_kind: 'shared', cpus: 2, memory_mb: 512 })
  })

  it('exec wraps command in bash -c', async () => {
    mockFetch.mockResolvedValue(mockResponse({ stdout: 'out', stderr: '', exit_code: 0 }))
    const client = createFlyioClient(config)

    await client.exec('m-1', 'echo hello world')

    const [url, opts] = mockFetch.mock.calls[0]!
    expect(url).toBe('https://api.machines.dev/v1/apps/my-app/machines/m-1/exec')
    expect(opts.method).toBe('POST')
    const body = JSON.parse(opts.body as string)
    expect(body.cmd).toBe('bash -c "echo hello world"')
  })

  it('waitForState calls correct URL with params', async () => {
    mockFetch.mockResolvedValue(emptyResponse())
    const client = createFlyioClient(config)

    await client.waitForState('m-1', 'started', 30)

    expect(mockFetch).toHaveBeenCalledWith(
      'https://api.machines.dev/v1/apps/my-app/machines/m-1/wait?state=started&timeout=30',
      expect.any(Object),
    )
  })

  it('destroyMachine uses force=true', async () => {
    mockFetch.mockResolvedValue(emptyResponse())
    const client = createFlyioClient(config)

    await client.destroyMachine('m-1')

    expect(mockFetch).toHaveBeenCalledWith(
      'https://api.machines.dev/v1/apps/my-app/machines/m-1?force=true',
      expect.objectContaining({ method: 'DELETE' }),
    )
  })

  it('createVolume sends correct body', async () => {
    const vol = { id: 'vol-1', name: 'data', region: 'nrt', size_gb: 5, state: 'created', attached_machine_id: null, created_at: '' }
    mockFetch.mockResolvedValue(mockResponse(vol))
    const client = createFlyioClient({ ...config, region: 'nrt' })

    await client.createVolume({ name: 'data', sizeGB: 5 })

    const [url, opts] = mockFetch.mock.calls[0]!
    expect(url).toBe('https://api.machines.dev/v1/apps/my-app/volumes')
    expect(opts.method).toBe('POST')
    const body = JSON.parse(opts.body as string)
    expect(body.name).toBe('data')
    expect(body.size_gb).toBe(5)
    expect(body.region).toBe('nrt')
  })

  it('stopMachine sends POST', async () => {
    mockFetch.mockResolvedValue(emptyResponse())
    const client = createFlyioClient(config)

    await client.stopMachine('m-1')

    expect(mockFetch).toHaveBeenCalledWith(
      'https://api.machines.dev/v1/apps/my-app/machines/m-1/stop',
      expect.objectContaining({ method: 'POST' }),
    )
  })
})
