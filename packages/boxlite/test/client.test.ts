import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest'
import { createBoxLiteRestClient } from '../src/client.js'

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

function createClient(prefix = 'default') {
  return createBoxLiteRestClient({
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
      const box = { id: 'box_abc', status: 'running', created_at: '2026-01-01T00:00:00Z', image: 'ubuntu:24.04', cpu: 2, memory_mb: 1024, name: null }
      mockFetch.mockResolvedValueOnce(mockResponse(box))

      const client = createClient()
      const result = await client.createBox({ image: 'ubuntu:24.04', cpu: 2, memory_mb: 1024 })

      expect(result.id).toBe('box_abc')
      expect(mockFetch).toHaveBeenCalledTimes(1)

      const [url, opts] = mockFetch.mock.calls[0]!
      expect(url).toBe('http://localhost:8080/v1/default/boxes')
      expect(opts.method).toBe('POST')
      expect(opts.headers['Authorization']).toBe('Bearer test-token')
      const body = JSON.parse(opts.body)
      expect(body.image).toBe('ubuntu:24.04')
      expect(body.cpu).toBe(2)
      expect(body.memory_mb).toBe(1024)
    })

    it('should use custom prefix', async () => {
      mockFetch.mockResolvedValueOnce(mockResponse({ id: 'box_abc' }))

      const client = createClient('myteam')
      await client.createBox({ image: 'ubuntu:24.04' })

      const [url] = mockFetch.mock.calls[0]!
      expect(url).toBe('http://localhost:8080/v1/myteam/boxes')
    })
  })

  describe('getBox', () => {
    it('should GET /{prefix}/boxes/{id}', async () => {
      const box = { id: 'box_abc', status: 'running' }
      mockFetch.mockResolvedValueOnce(mockResponse(box))

      const client = createClient()
      const result = await client.getBox('box_abc')

      expect(result.id).toBe('box_abc')
      const [url] = mockFetch.mock.calls[0]!
      expect(url).toBe('http://localhost:8080/v1/default/boxes/box_abc')
    })

    it('should throw on 404', async () => {
      mockFetch.mockResolvedValueOnce(mockResponse('Not Found', 404))

      const client = createClient()
      await expect(client.getBox('box_999')).rejects.toThrow('BoxLite API error 404')
    })
  })

  describe('listBoxes', () => {
    it('should GET /{prefix}/boxes and handle bare array response', async () => {
      const boxes = [{ id: 'box_abc', status: 'running' }]
      mockFetch.mockResolvedValueOnce(mockResponse(boxes))

      const client = createClient()
      const result = await client.listBoxes()

      expect(result).toEqual(boxes)
      const [url] = mockFetch.mock.calls[0]!
      expect(url).toBe('http://localhost:8080/v1/default/boxes')
    })

    it('should handle wrapped {boxes: [...]} response as fallback', async () => {
      const boxes = [{ id: 'box_abc', status: 'running' }]
      mockFetch.mockResolvedValueOnce(mockResponse({ boxes }))

      const client = createClient()
      const result = await client.listBoxes()

      expect(result).toEqual(boxes)
    })

    it('should return empty array when response is empty object', async () => {
      mockFetch.mockResolvedValueOnce(mockResponse({}))

      const client = createClient()
      const result = await client.listBoxes()

      expect(result).toEqual([])
    })

    it('should append status and page_size query params', async () => {
      mockFetch.mockResolvedValueOnce(mockResponse([]))

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
      await client.deleteBox('box_abc', true)

      const [url, opts] = mockFetch.mock.calls[0]!
      expect(url).toBe('http://localhost:8080/v1/default/boxes/box_abc?force=true')
      expect(opts.method).toBe('DELETE')
    })
  })

  describe('startBox / stopBox', () => {
    it('should POST to start endpoint', async () => {
      mockFetch.mockResolvedValueOnce(mockResponse(''))

      const client = createClient()
      await client.startBox('box_abc')

      const [url, opts] = mockFetch.mock.calls[0]!
      expect(url).toBe('http://localhost:8080/v1/default/boxes/box_abc/start')
      expect(opts.method).toBe('POST')
    })

    it('should POST to stop endpoint', async () => {
      mockFetch.mockResolvedValueOnce(mockResponse(''))

      const client = createClient()
      await client.stopBox('box_abc')

      const [url, opts] = mockFetch.mock.calls[0]!
      expect(url).toBe('http://localhost:8080/v1/default/boxes/box_abc/stop')
      expect(opts.method).toBe('POST')
    })
  })

  // --- Exec ---

  describe('exec', () => {
    it('should POST exec with cmd array and return result when immediately completed', async () => {
      const execution = { id: 'exec_abc', status: 'exited', exit_code: 0, stdout: 'hello world', stderr: '' }
      mockFetch.mockResolvedValueOnce(mockResponse(execution))

      const client = createClient()
      const result = await client.exec('box_abc', { cmd: ['echo', 'hello', 'world'] })

      expect(result.stdout).toBe('hello world')
      expect(result.stderr).toBe('')
      expect(result.exitCode).toBe(0)

      // Verify POST exec call with cmd format
      const [postUrl, postOpts] = mockFetch.mock.calls[0]!
      expect(postUrl).toBe('http://localhost:8080/v1/default/boxes/box_abc/exec')
      expect(postOpts.method).toBe('POST')
      const body = JSON.parse(postOpts.body)
      expect(body.cmd).toEqual(['echo', 'hello', 'world'])
    })

    it('should poll execution when not immediately completed', async () => {
      const execution = { id: 'exec_abc', status: 'running', exit_code: null }
      const completed = { id: 'exec_abc', status: 'exited', exit_code: 0, stdout: 'done', stderr: '' }

      mockFetch
        .mockResolvedValueOnce(mockResponse(execution)) // POST exec → running
        .mockResolvedValueOnce(mockResponse(completed))  // GET execution → completed

      const client = createClient()
      const result = await client.exec('box_abc', { cmd: ['sleep', '1'] })

      expect(result.stdout).toBe('done')
      expect(result.exitCode).toBe(0)

      // Verify polling endpoint
      const [pollUrl] = mockFetch.mock.calls[1]!
      expect(pollUrl).toBe('http://localhost:8080/v1/default/boxes/box_abc/exec/exec_abc')
    })

    it('should handle non-zero exit code', async () => {
      const execution = { id: 'exec_abc', status: 'exited', exit_code: 127, stdout: '', stderr: 'command not found' }
      mockFetch.mockResolvedValueOnce(mockResponse(execution))

      const client = createClient()
      const result = await client.exec('box_abc', { cmd: ['nonexistent'] })

      expect(result.stdout).toBe('')
      expect(result.stderr).toBe('command not found')
      expect(result.exitCode).toBe(127)
    })

    it('should pass working_dir and timeout_seconds in request', async () => {
      mockFetch.mockResolvedValueOnce(
        mockResponse({ id: 'exec_abc', status: 'exited', exit_code: 0, stdout: '', stderr: '' }),
      )

      const client = createClient()
      await client.exec('box_abc', {
        cmd: ['ls'],
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
      await client.uploadFiles('box_abc', '/app', tarData)

      const [url, opts] = mockFetch.mock.calls[0]!
      expect(url).toBe('http://localhost:8080/v1/default/boxes/box_abc/files?path=%2Fapp')
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
      const stream = await client.downloadFiles('box_abc', '/app')

      expect(stream).toBeInstanceOf(ReadableStream)
      const [url, opts] = mockFetch.mock.calls[0]!
      expect(url).toBe('http://localhost:8080/v1/default/boxes/box_abc/files?path=%2Fapp')
      expect(opts.headers['Accept']).toBe('application/x-tar')
    })
  })

  // --- Snapshots ---

  describe('createSnapshot', () => {
    it('should POST to snapshots endpoint', async () => {
      const snapshot = { id: 's-1', box_id: 'box_abc', name: 'my-snap', created_at: 1234567890, size_bytes: 1000 }
      mockFetch.mockResolvedValueOnce(mockResponse(snapshot))

      const client = createClient()
      const result = await client.createSnapshot('box_abc', 'my-snap')

      expect(result.name).toBe('my-snap')
      const [url, opts] = mockFetch.mock.calls[0]!
      expect(url).toBe('http://localhost:8080/v1/default/boxes/box_abc/snapshots')
      expect(opts.method).toBe('POST')
      expect(JSON.parse(opts.body).name).toBe('my-snap')
    })
  })

  describe('restoreSnapshot', () => {
    it('should POST to restore endpoint', async () => {
      mockFetch.mockResolvedValueOnce(mockResponse(''))

      const client = createClient()
      await client.restoreSnapshot('box_abc', 'my-snap')

      const [url, opts] = mockFetch.mock.calls[0]!
      expect(url).toBe('http://localhost:8080/v1/default/boxes/box_abc/snapshots/my-snap/restore')
      expect(opts.method).toBe('POST')
    })
  })

  describe('listSnapshots', () => {
    it('should GET snapshots', async () => {
      mockFetch.mockResolvedValueOnce(mockResponse([]))

      const client = createClient()
      await client.listSnapshots('box_abc')

      const [url] = mockFetch.mock.calls[0]!
      expect(url).toBe('http://localhost:8080/v1/default/boxes/box_abc/snapshots')
    })
  })

  describe('deleteSnapshot', () => {
    it('should DELETE snapshot by name', async () => {
      mockFetch.mockResolvedValueOnce(mockResponse(''))

      const client = createClient()
      await client.deleteSnapshot('box_abc', 'my-snap')

      const [url, opts] = mockFetch.mock.calls[0]!
      expect(url).toBe('http://localhost:8080/v1/default/boxes/box_abc/snapshots/my-snap')
      expect(opts.method).toBe('DELETE')
    })
  })

  // --- OAuth2 token management ---

  describe('OAuth2 token', () => {
    it('should acquire token via client credentials when no apiToken', async () => {
      const oauthClient = createBoxLiteRestClient({
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
      const oauthClient = createBoxLiteRestClient({
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

    it('should work without auth when neither apiToken nor clientId+clientSecret provided', () => {
      const noAuthClient = createBoxLiteRestClient({
        apiUrl: 'http://localhost:8080',
      })
      // Should not throw — no-auth mode is supported for local BoxRun
      expect(noAuthClient).toBeDefined()
    })
  })

  // --- execStream ---

  describe('execStream', () => {
    it('should return immediately completed stream with stdout and stderr', async () => {
      const execution = { id: 'exec_1', status: 'exited', exit_code: 0, stdout: 'out', stderr: 'err' }
      mockFetch.mockResolvedValueOnce(mockResponse(execution))

      const client = createClient()
      const stream = await client.execStream('box_abc', { cmd: ['echo', 'test'] })

      const reader = stream.getReader()
      const decoder = new TextDecoder()
      const chunks: string[] = []
      while (true) {
        const { done, value } = await reader.read()
        if (done) break
        chunks.push(decoder.decode(value))
      }
      expect(chunks.join('')).toContain('out')
      expect(chunks.join('')).toContain('err')
    })

    it('should return immediately completed stream with only stdout', async () => {
      const execution = { id: 'exec_1', status: 'exited', exit_code: 0, stdout: 'output', stderr: '' }
      mockFetch.mockResolvedValueOnce(mockResponse(execution))

      const client = createClient()
      const stream = await client.execStream('box_abc', { cmd: ['echo'] })

      const reader = stream.getReader()
      const decoder = new TextDecoder()
      const chunks: string[] = []
      while (true) {
        const { done, value } = await reader.read()
        if (done) break
        chunks.push(decoder.decode(value))
      }
      expect(chunks.join('')).toBe('output')
    })

    it('should poll and return stream when not immediately completed', async () => {
      const running = { id: 'exec_1', status: 'running', exit_code: null }
      const completed = { id: 'exec_1', status: 'exited', exit_code: 0, stdout: 'polled', stderr: '' }

      mockFetch
        .mockResolvedValueOnce(mockResponse(running))
        .mockResolvedValueOnce(mockResponse(completed))

      const client = createClient()
      const stream = await client.execStream('box_abc', { cmd: ['sleep', '1'] })

      const reader = stream.getReader()
      const decoder = new TextDecoder()
      const chunks: string[] = []
      while (true) {
        const { done, value } = await reader.read()
        if (done) break
        chunks.push(decoder.decode(value))
      }
      expect(chunks.join('')).toBe('polled')
    })

    it('should error stream on polling failure', async () => {
      const running = { id: 'exec_1', status: 'running', exit_code: null }

      mockFetch
        .mockResolvedValueOnce(mockResponse(running))
        .mockResolvedValueOnce(mockResponse('Server Error', 500))

      const client = createClient()
      const stream = await client.execStream('box_abc', { cmd: ['fail'] })

      const reader = stream.getReader()
      await expect(reader.read()).rejects.toThrow('BoxLite API error 500')
    })

    it('should error stream on timeout', async () => {
      const running = { id: 'exec_1', status: 'running', exit_code: null }

      // Always return running status (new Response each time to avoid body-already-read)
      mockFetch.mockImplementation(() => Promise.resolve(mockResponse(running)))

      const client = createClient()
      const stream = await client.execStream('box_abc', { cmd: ['hang'], timeout_seconds: 0.1 })

      const reader = stream.getReader()
      await expect(reader.read()).rejects.toThrow('BoxLite exec stream timed out')
    }, 10_000)
  })

  // --- Exec timeout ---

  describe('exec timeout', () => {
    it('should throw on timeout', async () => {
      const running = { id: 'exec_1', status: 'running', exit_code: null }
      // New Response each time to avoid body-already-read
      mockFetch.mockImplementation(() => Promise.resolve(mockResponse(running)))

      const client = createClient()
      await expect(
        client.exec('box_abc', { cmd: ['sleep', '999'], timeout_seconds: 0.1 }),
      ).rejects.toThrow('BoxLite exec timed out waiting for completion')
    }, 10_000)

    it('should handle undefined exit_code in exec response (treated as running)', async () => {
      const running = { id: 'exec_1', status: 'running' }
      const completed = { id: 'exec_1', status: 'exited', exit_code: 0, stdout: 'ok', stderr: '' }

      mockFetch
        .mockResolvedValueOnce(mockResponse(running))
        .mockResolvedValueOnce(mockResponse(completed))

      const client = createClient()
      const result = await client.exec('box_abc', { cmd: ['test'] })

      expect(result.stdout).toBe('ok')
    })

    it('should handle null stdout/stderr in exec response', async () => {
      const execution = { id: 'exec_1', status: 'exited', exit_code: 0, stdout: null, stderr: null }
      mockFetch.mockResolvedValueOnce(mockResponse(execution))

      const client = createClient()
      const result = await client.exec('box_abc', { cmd: ['test'] })

      expect(result.stdout).toBe('')
      expect(result.stderr).toBe('')
    })
  })

  // --- deleteBox without force ---

  describe('deleteBox without force', () => {
    it('should DELETE without force query param', async () => {
      mockFetch.mockResolvedValueOnce(mockResponse('', 200))

      const client = createClient()
      await client.deleteBox('box_abc')

      const [url, opts] = mockFetch.mock.calls[0]!
      expect(url).toBe('http://localhost:8080/v1/default/boxes/box_abc')
      expect(opts.method).toBe('DELETE')
    })
  })

  // --- No-prefix URL construction ---

  describe('no prefix', () => {
    it('should construct URLs without prefix segment', async () => {
      const client = createBoxLiteRestClient({
        apiToken: 'test-token',
        apiUrl: 'http://localhost:8080',
        prefix: '',
      })
      mockFetch.mockResolvedValueOnce(mockResponse([]))

      await client.listBoxes()

      const [url] = mockFetch.mock.calls[0]!
      expect(url).toBe('http://localhost:8080/v1/boxes')
    })

    it('should construct upload/download URLs without prefix', async () => {
      const client = createBoxLiteRestClient({
        apiToken: 'test-token',
        apiUrl: 'http://localhost:8080',
        prefix: '',
      })
      mockFetch.mockResolvedValueOnce(mockResponse('', 200))

      const tarData = new Uint8Array([1, 2, 3])
      await client.uploadFiles('box_abc', '/app', tarData)

      const [url] = mockFetch.mock.calls[0]!
      expect(url).toBe('http://localhost:8080/v1/boxes/box_abc/files?path=%2Fapp')
    })
  })

  // --- Upload/Download error paths ---

  describe('uploadFiles error', () => {
    it('should throw on non-OK upload response', async () => {
      mockFetch.mockResolvedValueOnce(mockResponse('Upload failed', 500))

      const client = createClient()
      await expect(
        client.uploadFiles('box_abc', '/app', new Uint8Array([1])),
      ).rejects.toThrow('BoxLite API error 500')
    })
  })

  describe('downloadFiles error', () => {
    it('should throw on non-OK download response', async () => {
      mockFetch.mockResolvedValueOnce(mockResponse('Not found', 404))

      const client = createClient()
      await expect(
        client.downloadFiles('box_abc', '/app'),
      ).rejects.toThrow('BoxLite API error 404')
    })

    it('should throw when response has no body', async () => {
      // Create a response with null body
      const response = new Response(null, { status: 200 })
      // Override body to be null
      Object.defineProperty(response, 'body', { value: null })
      mockFetch.mockResolvedValueOnce(response)

      const client = createClient()
      await expect(
        client.downloadFiles('box_abc', '/app'),
      ).rejects.toThrow('BoxLite download: no response body')
    })
  })

  // --- OAuth2 error ---

  describe('OAuth2 error', () => {
    it('should throw on failed token acquisition', async () => {
      const oauthClient = createBoxLiteRestClient({
        apiUrl: 'http://localhost:8080',
        clientId: 'test-client',
        clientSecret: 'test-secret',
      })

      mockFetch.mockResolvedValueOnce(mockResponse('Unauthorized', 401))

      await expect(oauthClient.listBoxes()).rejects.toThrow('BoxLite OAuth2 error 401')
    })
  })

  // --- No-auth request ---

  describe('no auth request', () => {
    it('should not include Authorization header when no auth configured', async () => {
      const client = createBoxLiteRestClient({
        apiUrl: 'http://localhost:8080',
      })
      mockFetch.mockResolvedValueOnce(mockResponse([]))

      await client.listBoxes()

      const [, opts] = mockFetch.mock.calls[0]!
      expect(opts.headers['Authorization']).toBeUndefined()
    })
  })

  // --- Trailing slash in apiUrl ---

  describe('apiUrl normalization', () => {
    it('should strip trailing slash from apiUrl', async () => {
      const client = createBoxLiteRestClient({
        apiToken: 'test-token',
        apiUrl: 'http://localhost:8080/',
        prefix: 'default',
      })
      mockFetch.mockResolvedValueOnce(mockResponse([]))

      await client.listBoxes()

      const [url] = mockFetch.mock.calls[0]!
      expect(url).toBe('http://localhost:8080/v1/default/boxes')
    })
  })

  // --- Error handling ---

  describe('error handling', () => {
    it('should throw on non-OK response', async () => {
      mockFetch.mockResolvedValueOnce(mockResponse('Internal Server Error', 500))

      const client = createClient()
      await expect(client.getBox('box_abc')).rejects.toThrow('BoxLite API error 500')
    })

    it('should handle empty response body for DELETE', async () => {
      mockFetch.mockResolvedValueOnce(mockResponse('', 200))

      const client = createClient()
      await expect(client.deleteBox('box_abc')).resolves.toBeUndefined()
    })
  })
})
