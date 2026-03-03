import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest'
import { createBoxLiteClient } from '../src/client.js'

// --- Mock fetch ---

const originalFetch = globalThis.fetch
let mockFetch: ReturnType<typeof vi.fn>

function mockResponse(body: unknown, status = 200, headers?: Record<string, string>): Response {
  const text = typeof body === 'string' ? body : JSON.stringify(body)
  return new Response(text, {
    status,
    statusText: status === 200 ? 'OK' : 'Error',
    headers: { 'Content-Type': 'application/json', ...headers },
  })
}

function sseResponse(events: string): Response {
  return new Response(events, {
    status: 200,
    headers: { 'Content-Type': 'text/event-stream' },
  })
}

function createClient(prefix = 'default') {
  return createBoxLiteClient({
    apiToken: 'test-token',
    apiUrl: 'http://localhost:8080',
    prefix,
  })
}

describe('BoxLiteClient', () => {
  beforeEach(() => {
    mockFetch = vi.fn()
    globalThis.fetch = mockFetch
  })

  afterEach(() => {
    globalThis.fetch = originalFetch
  })

  // --- Box lifecycle ---

  describe('createBox', () => {
    it('should POST to /{prefix}/boxes with correct body', async () => {
      const box = { box_id: 'b-1', status: 'running', created_at: '2026-01-01T00:00:00Z', image: 'ubuntu:24.04', cpus: 1, memory_mib: 512, pid: 123, name: null }
      mockFetch.mockResolvedValueOnce(mockResponse(box))

      const client = createClient()
      const result = await client.createBox({ image: 'ubuntu:24.04', cpus: 2, memory_mib: 1024 })

      expect(result.box_id).toBe('b-1')
      expect(mockFetch).toHaveBeenCalledTimes(1)

      const [url, opts] = mockFetch.mock.calls[0]!
      expect(url).toBe('http://localhost:8080/v1/default/boxes')
      expect(opts.method).toBe('POST')
      expect(opts.headers['Authorization']).toBe('Bearer test-token')
      const body = JSON.parse(opts.body)
      expect(body.image).toBe('ubuntu:24.04')
      expect(body.cpus).toBe(2)
      expect(body.memory_mib).toBe(1024)
    })

    it('should use custom prefix', async () => {
      mockFetch.mockResolvedValueOnce(mockResponse({ box_id: 'b-1' }))

      const client = createClient('myteam')
      await client.createBox({ image: 'ubuntu:24.04' })

      const [url] = mockFetch.mock.calls[0]!
      expect(url).toBe('http://localhost:8080/v1/myteam/boxes')
    })
  })

  describe('getBox', () => {
    it('should GET /{prefix}/boxes/{id}', async () => {
      const box = { box_id: 'b-1', status: 'running' }
      mockFetch.mockResolvedValueOnce(mockResponse(box))

      const client = createClient()
      const result = await client.getBox('b-1')

      expect(result.box_id).toBe('b-1')
      const [url] = mockFetch.mock.calls[0]!
      expect(url).toBe('http://localhost:8080/v1/default/boxes/b-1')
    })

    it('should throw on 404', async () => {
      mockFetch.mockResolvedValueOnce(mockResponse('Not Found', 404))

      const client = createClient()
      await expect(client.getBox('b-999')).rejects.toThrow('BoxLite API error 404')
    })
  })

  describe('listBoxes', () => {
    it('should GET /{prefix}/boxes with no params and unwrap response', async () => {
      const boxes = [{ box_id: 'b-1', status: 'running' }]
      mockFetch.mockResolvedValueOnce(mockResponse({ boxes, next_page_token: null }))

      const client = createClient()
      const result = await client.listBoxes()

      expect(result).toEqual(boxes)
      const [url] = mockFetch.mock.calls[0]!
      expect(url).toBe('http://localhost:8080/v1/default/boxes')
    })

    it('should return empty array when boxes field is missing', async () => {
      mockFetch.mockResolvedValueOnce(mockResponse({}))

      const client = createClient()
      const result = await client.listBoxes()

      expect(result).toEqual([])
    })

    it('should append status and page_size query params', async () => {
      mockFetch.mockResolvedValueOnce(mockResponse({ boxes: [] }))

      const client = createClient()
      await client.listBoxes('running', 10)

      const [url] = mockFetch.mock.calls[0]!
      expect(url).toContain('status=running')
      expect(url).toContain('page_size=10')
    })
  })

  describe('deleteBox', () => {
    it('should DELETE with force=true', async () => {
      mockFetch.mockResolvedValueOnce(mockResponse('', 200))

      const client = createClient()
      await client.deleteBox('b-1', true)

      const [url, opts] = mockFetch.mock.calls[0]!
      expect(url).toBe('http://localhost:8080/v1/default/boxes/b-1?force=true')
      expect(opts.method).toBe('DELETE')
    })
  })

  describe('startBox / stopBox', () => {
    it('should POST to start endpoint', async () => {
      mockFetch.mockResolvedValueOnce(mockResponse(''))

      const client = createClient()
      await client.startBox('b-1')

      const [url, opts] = mockFetch.mock.calls[0]!
      expect(url).toBe('http://localhost:8080/v1/default/boxes/b-1/start')
      expect(opts.method).toBe('POST')
    })

    it('should POST to stop endpoint', async () => {
      mockFetch.mockResolvedValueOnce(mockResponse(''))

      const client = createClient()
      await client.stopBox('b-1')

      const [url, opts] = mockFetch.mock.calls[0]!
      expect(url).toBe('http://localhost:8080/v1/default/boxes/b-1/stop')
      expect(opts.method).toBe('POST')
    })
  })

  // --- Exec ---

  describe('exec', () => {
    it('should POST exec then GET SSE output and parse base64', async () => {
      const execution = { execution_id: 'e-1', status: 'running', exit_code: null }
      const stdout64 = btoa('hello world')
      const sseBody = [
        'event:stdout',
        `data:${stdout64}`,
        '',
        'event:exit',
        'data:{"exit_code":0}',
        '',
      ].join('\n')

      mockFetch
        .mockResolvedValueOnce(mockResponse(execution)) // POST exec
        .mockResolvedValueOnce(sseResponse(sseBody))     // GET output

      const client = createClient()
      const result = await client.exec('b-1', { command: 'echo', args: ['hello', 'world'] })

      expect(result.stdout).toBe('hello world')
      expect(result.stderr).toBe('')
      expect(result.exitCode).toBe(0)

      // Verify POST exec call
      const [postUrl, postOpts] = mockFetch.mock.calls[0]!
      expect(postUrl).toBe('http://localhost:8080/v1/default/boxes/b-1/exec')
      expect(postOpts.method).toBe('POST')
      const body = JSON.parse(postOpts.body)
      expect(body.command).toBe('echo')
      expect(body.args).toEqual(['hello', 'world'])

      // Verify GET output call
      const [getUrl] = mockFetch.mock.calls[1]!
      expect(getUrl).toBe('http://localhost:8080/v1/default/boxes/b-1/executions/e-1/output')
    })

    it('should parse stderr and non-zero exit code', async () => {
      const execution = { execution_id: 'e-2', status: 'running', exit_code: null }
      const stderr64 = btoa('command not found')
      const sseBody = [
        'event:stderr',
        `data:${stderr64}`,
        '',
        'event:exit',
        'data:{"exit_code":127}',
        '',
      ].join('\n')

      mockFetch
        .mockResolvedValueOnce(mockResponse(execution))
        .mockResolvedValueOnce(sseResponse(sseBody))

      const client = createClient()
      const result = await client.exec('b-1', { command: 'nonexistent' })

      expect(result.stdout).toBe('')
      expect(result.stderr).toBe('command not found')
      expect(result.exitCode).toBe(127)
    })

    it('should pass working_dir and timeout_seconds', async () => {
      mockFetch
        .mockResolvedValueOnce(mockResponse({ execution_id: 'e-3', status: 'running', exit_code: null }))
        .mockResolvedValueOnce(sseResponse('event:exit\ndata:{"exit_code":0}\n'))

      const client = createClient()
      await client.exec('b-1', {
        command: 'ls',
        working_dir: '/app',
        timeout_seconds: 30,
      })

      const body = JSON.parse(mockFetch.mock.calls[0]![1].body)
      expect(body.working_dir).toBe('/app')
      expect(body.timeout_seconds).toBe(30)
    })
  })

  // --- Files ---

  describe('uploadFiles', () => {
    it('should PUT tar data with correct content type', async () => {
      mockFetch.mockResolvedValueOnce(mockResponse('', 200))

      const client = createClient()
      const tarData = new Uint8Array([1, 2, 3])
      await client.uploadFiles('b-1', '/app', tarData)

      const [url, opts] = mockFetch.mock.calls[0]!
      expect(url).toBe('http://localhost:8080/v1/default/boxes/b-1/files?path=%2Fapp')
      expect(opts.method).toBe('PUT')
      expect(opts.headers['Content-Type']).toBe('application/x-tar')
      expect(new Uint8Array(opts.body as ArrayBuffer)).toEqual(tarData)
    })
  })

  describe('downloadFiles', () => {
    it('should GET with tar accept header and return body stream', async () => {
      const body = new ReadableStream({
        start(controller) {
          controller.enqueue(new Uint8Array([1, 2, 3]))
          controller.close()
        },
      })
      mockFetch.mockResolvedValueOnce(new Response(body, { status: 200 }))

      const client = createClient()
      const stream = await client.downloadFiles('b-1', '/app')

      expect(stream).toBeInstanceOf(ReadableStream)
      const [url, opts] = mockFetch.mock.calls[0]!
      expect(url).toBe('http://localhost:8080/v1/default/boxes/b-1/files?path=%2Fapp')
      expect(opts.headers['Accept']).toBe('application/x-tar')
    })
  })

  // --- Snapshots ---

  describe('createSnapshot', () => {
    it('should POST to snapshots endpoint', async () => {
      const snapshot = { id: 's-1', box_id: 'b-1', name: 'my-snap', created_at: 1234567890, size_bytes: 1000 }
      mockFetch.mockResolvedValueOnce(mockResponse(snapshot))

      const client = createClient()
      const result = await client.createSnapshot('b-1', 'my-snap')

      expect(result.name).toBe('my-snap')
      const [url, opts] = mockFetch.mock.calls[0]!
      expect(url).toBe('http://localhost:8080/v1/default/boxes/b-1/snapshots')
      expect(opts.method).toBe('POST')
      expect(JSON.parse(opts.body).name).toBe('my-snap')
    })
  })

  describe('restoreSnapshot', () => {
    it('should POST to restore endpoint', async () => {
      mockFetch.mockResolvedValueOnce(mockResponse(''))

      const client = createClient()
      await client.restoreSnapshot('b-1', 'my-snap')

      const [url, opts] = mockFetch.mock.calls[0]!
      expect(url).toBe('http://localhost:8080/v1/default/boxes/b-1/snapshots/my-snap/restore')
      expect(opts.method).toBe('POST')
    })
  })

  describe('listSnapshots', () => {
    it('should GET snapshots', async () => {
      mockFetch.mockResolvedValueOnce(mockResponse([]))

      const client = createClient()
      await client.listSnapshots('b-1')

      const [url] = mockFetch.mock.calls[0]!
      expect(url).toBe('http://localhost:8080/v1/default/boxes/b-1/snapshots')
    })
  })

  describe('deleteSnapshot', () => {
    it('should DELETE snapshot by name', async () => {
      mockFetch.mockResolvedValueOnce(mockResponse(''))

      const client = createClient()
      await client.deleteSnapshot('b-1', 'my-snap')

      const [url, opts] = mockFetch.mock.calls[0]!
      expect(url).toBe('http://localhost:8080/v1/default/boxes/b-1/snapshots/my-snap')
      expect(opts.method).toBe('DELETE')
    })
  })

  // --- OAuth2 token management ---

  describe('OAuth2 token', () => {
    it('should acquire token via client credentials when no apiToken', async () => {
      const oauthClient = createBoxLiteClient({
        apiUrl: 'http://localhost:8080',
        clientId: 'test-client',
        clientSecret: 'test-secret',
      })

      // First call: OAuth2 token request
      mockFetch.mockResolvedValueOnce(
        mockResponse({ access_token: 'oauth-token-123', token_type: 'bearer', expires_in: 3600 }),
      )
      // Second call: actual API request
      mockFetch.mockResolvedValueOnce(mockResponse([]))

      await oauthClient.listBoxes()

      // Verify OAuth2 token request
      const [tokenUrl, tokenOpts] = mockFetch.mock.calls[0]!
      expect(tokenUrl).toBe('http://localhost:8080/v1/oauth/tokens')
      expect(tokenOpts.method).toBe('POST')
      expect(tokenOpts.headers['Content-Type']).toBe('application/x-www-form-urlencoded')

      // Verify API request uses acquired token
      const [, apiOpts] = mockFetch.mock.calls[1]!
      expect(apiOpts.headers['Authorization']).toBe('Bearer oauth-token-123')
    })

    it('should cache token and not re-acquire on subsequent calls', async () => {
      const oauthClient = createBoxLiteClient({
        apiUrl: 'http://localhost:8080',
        clientId: 'test-client',
        clientSecret: 'test-secret',
      })

      // Token + first API call
      mockFetch
        .mockResolvedValueOnce(mockResponse({ access_token: 'cached-token', token_type: 'bearer', expires_in: 3600 }))
        .mockResolvedValueOnce(mockResponse([]))
        .mockResolvedValueOnce(mockResponse([]))

      await oauthClient.listBoxes()
      await oauthClient.listBoxes()

      // Only 1 token request + 2 API requests = 3 total
      expect(mockFetch).toHaveBeenCalledTimes(3)
    })

    it('should throw when neither apiToken nor clientId+clientSecret provided', async () => {
      const badClient = createBoxLiteClient({
        apiUrl: 'http://localhost:8080',
      })

      await expect(badClient.listBoxes()).rejects.toThrow('either apiToken or clientId+clientSecret')
    })
  })

  // --- Error handling ---

  describe('error handling', () => {
    it('should throw on non-OK response', async () => {
      mockFetch.mockResolvedValueOnce(mockResponse('Internal Server Error', 500))

      const client = createClient()
      await expect(client.getBox('b-1')).rejects.toThrow('BoxLite API error 500')
    })

    it('should handle empty response body for DELETE', async () => {
      mockFetch.mockResolvedValueOnce(mockResponse('', 200))

      const client = createClient()
      await expect(client.deleteBox('b-1')).resolves.toBeUndefined()
    })
  })
})
