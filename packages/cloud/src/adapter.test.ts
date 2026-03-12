import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest'
import { SandbankCloudAdapter } from './adapter.js'

// Mock global fetch
const mockFetch = vi.fn()

beforeEach(() => {
  mockFetch.mockReset()
  vi.stubGlobal('fetch', mockFetch)
})

afterEach(() => {
  vi.restoreAllMocks()
})

function jsonResponse(data: unknown, status = 200) {
  return new Response(JSON.stringify(data), {
    status,
    headers: { 'Content-Type': 'application/json' },
  })
}

const MOCK_BOX = {
  id: 'box-abc123',
  name: null,
  status: 'running',
  created_at: '2026-03-12T00:00:00Z',
  image: 'codebox',
  cpu: 2,
  memory_mb: 1024,
  ports: { '7681': 10000, '8080': 10001 },
}

describe('SandbankCloudAdapter', () => {
  describe('constructor', () => {
    it('uses default URL when none provided', () => {
      const adapter = new SandbankCloudAdapter()
      expect(adapter.name).toBe('sandbank-cloud')
      expect(adapter.capabilities.has('exec.stream')).toBe(true)
      expect(adapter.capabilities.has('port.expose')).toBe(true)
    })
  })

  describe('createSandbox', () => {
    it('creates a sandbox and returns AdapterSandbox', async () => {
      mockFetch.mockResolvedValueOnce(jsonResponse(MOCK_BOX, 201))

      const adapter = new SandbankCloudAdapter({ url: 'https://test.example.com', apiToken: 'test-token' })
      const sandbox = await adapter.createSandbox({ image: 'codebox', resources: { cpu: 2, memory: 1024 } })

      expect(sandbox.id).toBe('box-abc123')
      expect(sandbox.state).toBe('running')

      // Verify fetch was called correctly
      expect(mockFetch).toHaveBeenCalledOnce()
      const [url, opts] = mockFetch.mock.calls[0]!
      expect(url).toBe('https://test.example.com/v1/boxes')
      expect(opts.method).toBe('POST')
      expect(opts.headers['Authorization']).toBe('Bearer test-token')
      const body = JSON.parse(opts.body)
      expect(body.image).toBe('codebox')
      expect(body.cpu).toBe(2)
      expect(body.memory_mb).toBe(1024)
    })

    it('defaults image to codebox', async () => {
      mockFetch.mockResolvedValueOnce(jsonResponse(MOCK_BOX, 201))

      const adapter = new SandbankCloudAdapter({ apiToken: 'tok' })
      await adapter.createSandbox({})

      const body = JSON.parse(mockFetch.mock.calls[0]![1].body)
      expect(body.image).toBe('codebox')
    })

    it('throws ProviderError on failure', async () => {
      mockFetch.mockResolvedValueOnce(jsonResponse({ error: 'Server at capacity' }, 503))

      const adapter = new SandbankCloudAdapter({ apiToken: 'tok' })
      await expect(adapter.createSandbox({})).rejects.toThrow('503')
    })

    it('throws on 402 without wallet', async () => {
      mockFetch.mockResolvedValueOnce(new Response('', { status: 402 }))

      const adapter = new SandbankCloudAdapter({})
      await expect(adapter.createSandbox({})).rejects.toThrow('402 Payment Required')
    })
  })

  describe('getSandbox', () => {
    it('returns sandbox by id', async () => {
      mockFetch.mockResolvedValueOnce(jsonResponse(MOCK_BOX))

      const adapter = new SandbankCloudAdapter({ apiToken: 'tok' })
      const sandbox = await adapter.getSandbox('box-abc123')

      expect(sandbox.id).toBe('box-abc123')
      expect(mockFetch.mock.calls[0]![0]).toContain('/v1/boxes/box-abc123')
    })

    it('throws SandboxNotFoundError on 404', async () => {
      mockFetch.mockResolvedValueOnce(jsonResponse({ error: 'Not found' }, 404))

      const adapter = new SandbankCloudAdapter({ apiToken: 'tok' })
      await expect(adapter.getSandbox('nope')).rejects.toThrow("Sandbox 'nope' not found")
    })
  })

  describe('listSandboxes', () => {
    it('returns list of sandbox infos', async () => {
      mockFetch.mockResolvedValueOnce(jsonResponse([MOCK_BOX]))

      const adapter = new SandbankCloudAdapter({ apiToken: 'tok' })
      const list = await adapter.listSandboxes()

      expect(list).toHaveLength(1)
      expect(list[0]!.id).toBe('box-abc123')
      expect(list[0]!.state).toBe('running')
    })

    it('applies limit filter', async () => {
      mockFetch.mockResolvedValueOnce(jsonResponse([MOCK_BOX, { ...MOCK_BOX, id: 'box-2' }]))

      const adapter = new SandbankCloudAdapter({ apiToken: 'tok' })
      const list = await adapter.listSandboxes({ limit: 1 })

      expect(list).toHaveLength(1)
    })
  })

  describe('destroySandbox', () => {
    it('sends DELETE request', async () => {
      mockFetch.mockResolvedValueOnce(new Response('', { status: 200 }))

      const adapter = new SandbankCloudAdapter({ apiToken: 'tok' })
      await adapter.destroySandbox('box-abc123')

      expect(mockFetch.mock.calls[0]![1].method).toBe('DELETE')
    })

    it('does not throw on 404', async () => {
      mockFetch.mockResolvedValueOnce(jsonResponse({ error: 'Not found' }, 404))

      const adapter = new SandbankCloudAdapter({ apiToken: 'tok' })
      await expect(adapter.destroySandbox('nope')).resolves.toBeUndefined()
    })
  })

  describe('sandbox.exec', () => {
    it('executes command and returns result', async () => {
      // First call: createSandbox
      mockFetch.mockResolvedValueOnce(jsonResponse(MOCK_BOX, 201))
      // Second call: exec
      mockFetch.mockResolvedValueOnce(jsonResponse({
        id: 'exec-1',
        box_id: 'box-abc123',
        cmd: ['bash', '-c', 'echo hello'],
        status: 'exited',
        exit_code: 0,
        stdout: 'hello\n',
        stderr: '',
      }))

      const adapter = new SandbankCloudAdapter({ apiToken: 'tok' })
      const sandbox = await adapter.createSandbox({})
      const result = await sandbox.exec('echo hello')

      expect(result.exitCode).toBe(0)
      expect(result.stdout).toBe('hello\n')

      const execCall = mockFetch.mock.calls[1]!
      expect(execCall[0]).toContain('/v1/boxes/box-abc123/exec')
      const execBody = JSON.parse(execCall[1].body)
      expect(execBody.cmd).toEqual(['bash', '-c', 'echo hello'])
    })
  })

  describe('sandbox.exposePort', () => {
    it('returns proxy URL as fallback', async () => {
      const box = { ...MOCK_BOX, ports: undefined }
      mockFetch.mockResolvedValueOnce(jsonResponse(box, 201))

      const adapter = new SandbankCloudAdapter({ url: 'https://cloud.sandbank.dev', apiToken: 'tok' })
      const sandbox = await adapter.createSandbox({})
      const { url } = await sandbox.exposePort!(8080)

      expect(url).toBe('https://cloud.sandbank.dev/v1/boxes/box-abc123/proxy/8080/')
    })

    it('returns direct host:port URL when port mapping exists', async () => {
      mockFetch.mockResolvedValueOnce(jsonResponse(MOCK_BOX, 201))

      const adapter = new SandbankCloudAdapter({ url: 'https://cloud.sandbank.dev', apiToken: 'tok' })
      const sandbox = await adapter.createSandbox({})
      const { url } = await sandbox.exposePort!(8080)

      expect(url).toBe('http://cloud.sandbank.dev:10001')
    })
  })
})

describe('state mapping', () => {
  it('maps running to running', async () => {
    mockFetch.mockResolvedValueOnce(jsonResponse({ ...MOCK_BOX, status: 'running' }))
    const adapter = new SandbankCloudAdapter({ apiToken: 'tok' })
    const sandbox = await adapter.getSandbox('x')
    expect(sandbox.state).toBe('running')
  })

  it('maps terminated to stopped', async () => {
    mockFetch.mockResolvedValueOnce(jsonResponse({ ...MOCK_BOX, status: 'terminated' }))
    const adapter = new SandbankCloudAdapter({ apiToken: 'tok' })
    const sandbox = await adapter.getSandbox('x')
    expect(sandbox.state).toBe('stopped')
  })

  it('passes through unknown states as-is', async () => {
    mockFetch.mockResolvedValueOnce(jsonResponse({ ...MOCK_BOX, status: 'paused' }))
    const adapter = new SandbankCloudAdapter({ apiToken: 'tok' })
    const sandbox = await adapter.getSandbox('x')
    expect(sandbox.state).toBe('paused')
  })
})
