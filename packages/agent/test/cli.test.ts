import { describe, it, expect, vi, beforeEach } from 'vitest'

// --- Mock http-client module ---
const mockSendMessage = vi.fn().mockResolvedValue(undefined)
const mockRecvMessages = vi.fn().mockResolvedValue([])
const mockContextGet = vi.fn().mockResolvedValue(null)
const mockContextSet = vi.fn().mockResolvedValue(undefined)
const mockContextDelete = vi.fn().mockResolvedValue(undefined)
const mockContextKeys = vi.fn().mockResolvedValue([])
const mockComplete = vi.fn().mockResolvedValue(undefined)

vi.mock('../src/http-client.js', () => ({
  sendMessage: (...args: unknown[]) => mockSendMessage(...args),
  recvMessages: (...args: unknown[]) => mockRecvMessages(...args),
  contextGet: (...args: unknown[]) => mockContextGet(...args),
  contextSet: (...args: unknown[]) => mockContextSet(...args),
  contextDelete: (...args: unknown[]) => mockContextDelete(...args),
  contextKeys: (...args: unknown[]) => mockContextKeys(...args),
  complete: (...args: unknown[]) => mockComplete(...args),
}))

/**
 * CLI runs main() on import with side effects (process.argv, process.exit, console).
 * We test by intercepting these globals, then dynamically importing the module.
 */
async function runCli(
  args: string[],
): Promise<{ stdout: string[]; stderr: string[]; exitCode: number | null }> {
  const stdout: string[] = []
  const stderr: string[] = []
  let exitCode: number | null = null

  const origArgv = process.argv
  const origLog = console.log
  const origError = console.error

  process.argv = ['node', 'cli.ts', ...args]
  // process.exit throws to abort main()
  const origExit = process.exit
  process.exit = ((code?: number) => {
    exitCode = code ?? 0
    throw new Error(`__EXIT_${code}__`)
  }) as never
  console.log = (...a: unknown[]) => stdout.push(a.map(String).join(' '))
  console.error = (...a: unknown[]) => stderr.push(a.map(String).join(' '))

  try {
    // Force re-execution by busting the module cache
    const timestamp = Date.now() + Math.random()
    await import(`../src/cli.js?t=${timestamp}`)
  } catch (err) {
    // Expected: either process.exit throw or main() rejection
    const msg = (err as Error)?.message ?? ''
    if (!msg.startsWith('__EXIT_')) {
      // Real error — re-capture
      stderr.push(msg)
    }
  } finally {
    process.argv = origArgv
    process.exit = origExit
    console.log = origLog
    console.error = origError
  }

  return { stdout, stderr, exitCode }
}

describe('CLI', () => {
  beforeEach(() => {
    vi.clearAllMocks()
  })

  // --- send command ---
  it('send should call sendMessage with correct args', async () => {
    const { stdout } = await runCli(['send', 'backend', 'task', '{"data":1}'])
    expect(mockSendMessage).toHaveBeenCalledWith('backend', 'task', { data: 1 }, 'normal')
    expect(stdout).toContain('OK')
  })

  it('send with --steer should set priority to steer', async () => {
    await runCli(['send', 'peer', 'ping', 'hello', '--steer'])
    expect(mockSendMessage).toHaveBeenCalledWith('peer', 'ping', 'hello', 'steer')
  })

  it('send without payload should pass null', async () => {
    await runCli(['send', 'peer', 'ping'])
    expect(mockSendMessage).toHaveBeenCalledWith('peer', 'ping', null, 'normal')
  })

  it('send without to/type should exit with error', async () => {
    const { exitCode } = await runCli(['send'])
    expect(exitCode).toBe(1)
  })

  // --- recv command ---
  it('recv should call recvMessages with defaults', async () => {
    mockRecvMessages.mockResolvedValueOnce([{ from: 'a', type: 'task' }])
    const { stdout } = await runCli(['recv'])
    expect(mockRecvMessages).toHaveBeenCalledWith(100, 0)
    expect(stdout.join('')).toContain('"from"')
  })

  it('recv should parse --wait and --limit flags', async () => {
    mockRecvMessages.mockResolvedValueOnce([])
    await runCli(['recv', '--wait', '5', '--limit', '10'])
    expect(mockRecvMessages).toHaveBeenCalledWith(10, 5000)
  })

  // --- context commands ---
  it('context get should call contextGet', async () => {
    mockContextGet.mockResolvedValueOnce({ answer: 42 })
    const { stdout } = await runCli(['context', 'get', 'mykey'])
    expect(mockContextGet).toHaveBeenCalledWith('mykey')
    expect(stdout.join('')).toContain('42')
  })

  it('context get without key should exit with error', async () => {
    const { exitCode } = await runCli(['context', 'get'])
    expect(exitCode).toBe(1)
  })

  it('context set should call contextSet', async () => {
    const { stdout } = await runCli(['context', 'set', 'k1', '{"v":1}'])
    expect(mockContextSet).toHaveBeenCalledWith('k1', { v: 1 })
    expect(stdout).toContain('OK')
  })

  it('context set should keep non-JSON string as string', async () => {
    await runCli(['context', 'set', 'k1', 'plain-text'])
    expect(mockContextSet).toHaveBeenCalledWith('k1', 'plain-text')
  })

  it('context set without key or value should exit with error', async () => {
    const { exitCode } = await runCli(['context', 'set', 'k1'])
    expect(exitCode).toBe(1)
  })

  it('context delete should call contextDelete', async () => {
    const { stdout } = await runCli(['context', 'delete', 'k1'])
    expect(mockContextDelete).toHaveBeenCalledWith('k1')
    expect(stdout).toContain('OK')
  })

  it('context delete without key should exit with error', async () => {
    const { exitCode } = await runCli(['context', 'delete'])
    expect(exitCode).toBe(1)
  })

  it('context keys should call contextKeys', async () => {
    mockContextKeys.mockResolvedValueOnce(['k1', 'k2'])
    const { stdout } = await runCli(['context', 'keys'])
    expect(mockContextKeys).toHaveBeenCalled()
    expect(stdout.join('')).toContain('k1')
  })

  it('context without subcommand should exit with error', async () => {
    const { exitCode } = await runCli(['context'])
    expect(exitCode).toBe(1)
  })

  // --- complete command ---
  it('complete should call complete with parsed flags', async () => {
    const { stdout } = await runCli(['complete', '--status', 'success', '--summary', 'All done'])
    expect(mockComplete).toHaveBeenCalledWith('success', 'All done')
    expect(stdout).toContain('OK')
  })

  it('complete without flags should use defaults', async () => {
    await runCli(['complete'])
    expect(mockComplete).toHaveBeenCalledWith('success', '')
  })

  // --- help ---
  it('help should print usage', async () => {
    const { stdout } = await runCli(['help'])
    expect(stdout.join('')).toContain('sandbank-agent')
  })

  it('--help should print usage', async () => {
    const { stdout } = await runCli(['--help'])
    expect(stdout.join('')).toContain('sandbank-agent')
  })

  // --- no command ---
  it('no command should print usage and exit 1', async () => {
    const { exitCode } = await runCli([])
    expect(exitCode).toBe(1)
  })

  // --- unknown command ---
  it('unknown command should exit 1', async () => {
    const { exitCode, stderr } = await runCli(['bogus'])
    expect(exitCode).toBe(1)
    expect(stderr.join('')).toContain('Unknown command: bogus')
  })
})
