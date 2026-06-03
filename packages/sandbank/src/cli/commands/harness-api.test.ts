import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

const mocks = vi.hoisted(() => ({
  startDbNativeAgentHarnessServer: vi.fn(),
}))

vi.mock('../../harness-node.js', () => ({
  startDbNativeAgentHarnessServer: mocks.startDbNativeAgentHarnessServer,
}))

const { harnessApiCommand } = await import('./harness-api.js')

describe('harnessApiCommand', () => {
  const originalEnv = { ...process.env }

  beforeEach(() => {
    vi.restoreAllMocks()
    mocks.startDbNativeAgentHarnessServer.mockReset()
    process.env = { ...originalEnv }
  })

  afterEach(() => {
    process.env = { ...originalEnv }
  })

  it('prints usage for help without starting a server', async () => {
    const log = vi.spyOn(console, 'log').mockImplementation(() => {})

    await harnessApiCommand(['--help'], {})

    expect(log).toHaveBeenCalledWith(expect.stringContaining('Usage: sandbank harness-api'))
    expect(mocks.startDbNativeAgentHarnessServer).not.toHaveBeenCalled()
  })

  it('exits for invalid ports', async () => {
    vi.spyOn(console, 'error').mockImplementation(() => {})
    const exit = vi.spyOn(process, 'exit').mockImplementation((code?: string | number | null) => {
      throw new Error(`exit:${code}`)
    })

    await expect(harnessApiCommand(['--port', '70000'], {})).rejects.toThrow('exit:1')
    expect(exit).toHaveBeenCalledWith(1)
    expect(mocks.startDbNativeAgentHarnessServer).not.toHaveBeenCalled()
  })

  it('starts the server with CLI host and port flags', async () => {
    const log = vi.spyOn(console, 'log').mockImplementation(() => {})
    mocks.startDbNativeAgentHarnessServer.mockResolvedValue({
      url: 'http://127.0.0.1:45123',
      close: vi.fn(),
    })

    void harnessApiCommand(['--host', '127.0.0.1', '--port', '45123'], {})
    await vi.waitFor(() => expect(mocks.startDbNativeAgentHarnessServer).toHaveBeenCalled())

    expect(mocks.startDbNativeAgentHarnessServer).toHaveBeenCalledWith(process.env, {
      host: '127.0.0.1',
      port: 45123,
    })
    expect(log).toHaveBeenCalledWith('sandbank db-native harness API listening on http://127.0.0.1:45123')
  })

  it('uses harness host and port environment fallbacks', async () => {
    const log = vi.spyOn(console, 'log').mockImplementation(() => {})
    process.env.SANDBANK_HARNESS_HOST = '127.0.0.1'
    process.env.SANDBANK_HARNESS_PORT = '45234'
    mocks.startDbNativeAgentHarnessServer.mockResolvedValue({
      url: 'http://127.0.0.1:45234',
      close: vi.fn(),
    })

    void harnessApiCommand([], {})
    await vi.waitFor(() => expect(mocks.startDbNativeAgentHarnessServer).toHaveBeenCalled())

    expect(mocks.startDbNativeAgentHarnessServer).toHaveBeenCalledWith(process.env, {
      host: '127.0.0.1',
      port: 45234,
    })
    expect(log).toHaveBeenCalledWith('GET  http://127.0.0.1:45234/health')
  })
})
