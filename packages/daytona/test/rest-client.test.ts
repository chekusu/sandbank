import { describe, it, expect, vi, beforeEach } from 'vitest'
import { createDaytonaRestClient } from '../src/rest-client.js'
import type { DaytonaClient } from '../src/types.js'

// --- Mock fetch ---
const mockFetch = vi.fn()
vi.stubGlobal('fetch', mockFetch)

function jsonResponse(data: unknown, status = 200): Response {
  return new Response(JSON.stringify(data), {
    status,
    headers: { 'Content-Type': 'application/json' },
  })
}

function emptyResponse(status = 204): Response {
  return new Response(null, { status })
}

function errorResponse(status: number, body = ''): Response {
  return new Response(body, { status, statusText: 'Error' })
}

const API_URL = 'https://api.test.com'
const TOOLBOX_URL = 'https://proxy.test.com'

describe('createDaytonaRestClient', () => {
  let client: DaytonaClient

  beforeEach(() => {
    vi.clearAllMocks()
    client = createDaytonaRestClient('test-api-key', API_URL)
  })

  // Helper: mock toolbox URL resolution + toolbox call
  function mockToolbox(toolboxResponse: Response) {
    mockFetch
      .mockResolvedValueOnce(jsonResponse({ url: TOOLBOX_URL })) // toolbox-proxy-url
      .mockResolvedValueOnce(toolboxResponse)
  }

  // --- Auth header ---
  describe('authentication', () => {
    it('should include Authorization header on all requests', async () => {
      mockFetch.mockResolvedValueOnce(jsonResponse({ id: 'sb-1', state: 'started', createdAt: '', image: '' }))
      await client.getSandbox('sb-1')

      expect(mockFetch).toHaveBeenCalledTimes(1)
      const [, init] = mockFetch.mock.calls[0]
      expect(init.headers.Authorization).toBe('Bearer test-api-key')
    })
  })

  // --- Default API URL ---
  describe('default API URL', () => {
    it('should use default API URL when none provided', async () => {
      const defaultClient = createDaytonaRestClient('key')
      mockFetch.mockResolvedValueOnce(jsonResponse([]))
      await defaultClient.listSandboxes()

      const [url] = mockFetch.mock.calls[0]
      expect(url).toBe('https://app.daytona.io/api/sandbox')
    })
  })

  // --- createSandbox ---
  describe('createSandbox', () => {
    it('should POST to /sandbox with config', async () => {
      const sandbox = { id: 'sb-new', state: 'creating', createdAt: '2026-01-01', image: 'node:22' }
      mockFetch.mockResolvedValueOnce(jsonResponse(sandbox))

      const result = await client.createSandbox({
        image: 'node:22',
        envVars: { NODE_ENV: 'production' },
        resources: { cpu: 2, memory: 1024 },
      })

      expect(result.id).toBe('sb-new')
      const [url, init] = mockFetch.mock.calls[0]
      expect(url).toBe(`${API_URL}/sandbox`)
      expect(init.method).toBe('POST')
      const body = JSON.parse(init.body)
      expect(body.image).toBe('node:22')
      expect(body.envVars).toEqual({ NODE_ENV: 'production' })
    })

    it('should throw on API error', async () => {
      mockFetch.mockResolvedValueOnce(errorResponse(500, 'Internal Server Error'))
      await expect(client.createSandbox({ image: 'node:22' })).rejects.toThrow('Daytona API 500')
    })
  })

  // --- getSandbox ---
  describe('getSandbox', () => {
    it('should GET /sandbox/{id}', async () => {
      const sandbox = { id: 'sb-1', state: 'started', createdAt: '2026-01-01', image: 'node:22' }
      mockFetch.mockResolvedValueOnce(jsonResponse(sandbox))

      const result = await client.getSandbox('sb-1')
      expect(result.id).toBe('sb-1')
      expect(mockFetch.mock.calls[0][0]).toBe(`${API_URL}/sandbox/sb-1`)
    })

    it('should throw on 404', async () => {
      mockFetch.mockResolvedValueOnce(errorResponse(404, 'Not Found'))
      await expect(client.getSandbox('missing')).rejects.toThrow('Daytona API 404')
    })
  })

  // --- listSandboxes ---
  describe('listSandboxes', () => {
    it('should GET /sandbox', async () => {
      mockFetch.mockResolvedValueOnce(jsonResponse([
        { id: 'sb-1', state: 'started', createdAt: '', image: '' },
      ]))

      const result = await client.listSandboxes()
      expect(result).toHaveLength(1)
      expect(mockFetch.mock.calls[0][0]).toBe(`${API_URL}/sandbox`)
    })

    it('should pass limit as query param', async () => {
      mockFetch.mockResolvedValueOnce(jsonResponse([]))
      await client.listSandboxes(10)
      expect(mockFetch.mock.calls[0][0]).toBe(`${API_URL}/sandbox?limit=10`)
    })

    it('should not add query param when limit is undefined', async () => {
      mockFetch.mockResolvedValueOnce(jsonResponse([]))
      await client.listSandboxes()
      expect(mockFetch.mock.calls[0][0]).toBe(`${API_URL}/sandbox`)
    })
  })

  // --- deleteSandbox ---
  describe('deleteSandbox', () => {
    it('should DELETE /sandbox/{id}', async () => {
      mockFetch.mockResolvedValueOnce(emptyResponse())
      await client.deleteSandbox('sb-1')

      const [url, init] = mockFetch.mock.calls[0]
      expect(url).toBe(`${API_URL}/sandbox/sb-1`)
      expect(init.method).toBe('DELETE')
    })

    it('should throw on error', async () => {
      mockFetch.mockResolvedValueOnce(errorResponse(500))
      await expect(client.deleteSandbox('sb-1')).rejects.toThrow('Daytona API 500')
    })
  })

  // --- exec ---
  describe('exec', () => {
    it('should resolve toolbox URL then POST execute', async () => {
      mockToolbox(jsonResponse({ exitCode: 0, result: 'hello' }))

      const result = await client.exec('sb-1', 'echo hello', '/app', 5000)
      expect(result.exitCode).toBe(0)
      expect(result.stdout).toBe('hello')

      // Check toolbox URL resolution
      expect(mockFetch.mock.calls[0][0]).toBe(`${API_URL}/sandbox/sb-1/toolbox-proxy-url`)

      // Check execute call
      const [url, init] = mockFetch.mock.calls[1]
      expect(url).toBe(`${TOOLBOX_URL}/sb-1/process/execute`)
      expect(init.method).toBe('POST')
      const body = JSON.parse(init.body)
      expect(body.command).toContain('base64')
      expect(body.cwd).toBe('/app')
      expect(body.timeout).toBe(5000)
    })

    it('should return empty stdout when result is missing', async () => {
      mockToolbox(jsonResponse({ exitCode: 0 }))

      const result = await client.exec('sb-1', 'true')
      expect(result.stdout).toBe('')
    })

    it('should throw on toolbox error', async () => {
      mockFetch
        .mockResolvedValueOnce(jsonResponse({ url: TOOLBOX_URL }))
        .mockResolvedValueOnce(errorResponse(500, 'exec failed'))

      await expect(client.exec('sb-1', 'bad')).rejects.toThrow('Daytona Toolbox 500')
    })
  })

  // --- writeFile ---
  describe('writeFile', () => {
    it('should upload string content as multipart form data', async () => {
      mockToolbox(emptyResponse(200))

      await client.writeFile('sb-1', '/app/file.txt', 'hello world')

      const [url, init] = mockFetch.mock.calls[1]
      expect(url).toBe(`${TOOLBOX_URL}/sb-1/files/upload`)
      expect(init.method).toBe('POST')
      expect(init.body).toBeInstanceOf(FormData)
    })

    it('should upload Uint8Array content', async () => {
      mockToolbox(emptyResponse(200))

      const bytes = new TextEncoder().encode('binary data')
      await client.writeFile('sb-1', '/app/bin', bytes)

      const [, init] = mockFetch.mock.calls[1]
      expect(init.body).toBeInstanceOf(FormData)
    })

    it('should throw on upload error', async () => {
      mockFetch
        .mockResolvedValueOnce(jsonResponse({ url: TOOLBOX_URL }))
        .mockResolvedValueOnce(errorResponse(413, 'Too Large'))

      await expect(client.writeFile('sb-1', '/f', 'x')).rejects.toThrow('Daytona Toolbox 413')
    })
  })

  // --- readFile ---
  describe('readFile', () => {
    it('should download file as Uint8Array', async () => {
      const content = new TextEncoder().encode('file content')
      const response = new Response(content, { status: 200 })
      mockToolbox(response)

      const result = await client.readFile('sb-1', '/app/file.txt')
      expect(result).toBeInstanceOf(Uint8Array)
      expect(new TextDecoder().decode(result)).toBe('file content')

      const [url] = mockFetch.mock.calls[1]
      expect(url).toBe(`${TOOLBOX_URL}/sb-1/files/download?path=%2Fapp%2Ffile.txt`)
    })

    it('should throw on download error', async () => {
      mockFetch
        .mockResolvedValueOnce(jsonResponse({ url: TOOLBOX_URL }))
        .mockResolvedValueOnce(errorResponse(404, 'Not Found'))

      await expect(client.readFile('sb-1', '/missing')).rejects.toThrow('Daytona Toolbox 404')
    })
  })

  // --- getPreviewUrl ---
  describe('getPreviewUrl', () => {
    it('should GET preview URL for port', async () => {
      mockFetch.mockResolvedValueOnce(jsonResponse({ url: 'https://preview.example.com:3000' }))

      const url = await client.getPreviewUrl('sb-1', 3000)
      expect(url).toBe('https://preview.example.com:3000')
      expect(mockFetch.mock.calls[0][0]).toBe(`${API_URL}/sandbox/sb-1/ports/3000/preview-url`)
    })
  })

  // --- Volume operations ---
  describe('createVolume', () => {
    it('should POST to /volume', async () => {
      mockFetch.mockResolvedValueOnce(jsonResponse({ id: 'vol-1', name: 'data' }))

      const vol = await client.createVolume('data')
      expect(vol.id).toBe('vol-1')
      expect(vol.name).toBe('data')

      const [url, init] = mockFetch.mock.calls[0]
      expect(url).toBe(`${API_URL}/volume`)
      expect(init.method).toBe('POST')
      expect(JSON.parse(init.body).name).toBe('data')
    })
  })

  describe('deleteVolume', () => {
    it('should DELETE /volume/{id}', async () => {
      mockFetch.mockResolvedValueOnce(emptyResponse())
      await client.deleteVolume('vol-1')

      const [url, init] = mockFetch.mock.calls[0]
      expect(url).toBe(`${API_URL}/volume/vol-1`)
      expect(init.method).toBe('DELETE')
    })
  })

  describe('listVolumes', () => {
    it('should GET /volume', async () => {
      mockFetch.mockResolvedValueOnce(jsonResponse([
        { id: 'vol-1', name: 'data', state: 'ready' },
        { id: 'vol-2', name: 'logs' },
      ]))

      const vols = await client.listVolumes()
      expect(vols).toHaveLength(2)
      expect(vols[0].id).toBe('vol-1')
      expect(vols[1].name).toBe('logs')
    })
  })

  // --- Error handling edge cases ---
  describe('error handling', () => {
    it('should handle empty error body gracefully', async () => {
      mockFetch.mockResolvedValueOnce(new Response(null, { status: 502, statusText: 'Bad Gateway' }))
      await expect(client.getSandbox('x')).rejects.toThrow('Daytona API 502')
    })

    it('should handle fetch rejection', async () => {
      mockFetch.mockRejectedValueOnce(new Error('network down'))
      await expect(client.getSandbox('x')).rejects.toThrow('network down')
    })

    it('should strip trailing slash from API URL', async () => {
      const c = createDaytonaRestClient('key', 'https://api.test.com/')
      mockFetch.mockResolvedValueOnce(jsonResponse([]))
      await c.listSandboxes()
      expect(mockFetch.mock.calls[0][0]).toBe('https://api.test.com/sandbox')
    })

    it('should strip trailing slash from toolbox URL', async () => {
      mockFetch
        .mockResolvedValueOnce(jsonResponse({ url: 'https://proxy.test.com/' }))
        .mockResolvedValueOnce(jsonResponse({ exitCode: 0, result: '' }))

      await client.exec('sb-1', 'ls')
      expect(mockFetch.mock.calls[1][0]).toBe('https://proxy.test.com/sb-1/process/execute')
    })
  })
})
