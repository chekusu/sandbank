import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest'

// Mock the API client
const mockX402Fetch = vi.fn()
const mockX402FetchRaw = vi.fn()
vi.mock('../api.js', () => ({
  createApiClient: () => ({
    x402Fetch: mockX402Fetch,
    x402FetchRaw: mockX402FetchRaw,
    baseUrl: 'https://cloud.sandbank.dev',
  }),
  printJson: (v: unknown) => console.log(JSON.stringify(v, null, 2)),
}))

// Mock config for login/config commands
vi.mock('../config.js', () => {
  let store: Record<string, string> = {}
  return {
    loadCredentials: vi.fn(() => ({ ...store })),
    saveCredentials: vi.fn((c: Record<string, string>) => { store = { ...c } }),
    maskSecret: (v: string) => v.length > 8 ? v.slice(0, 4) + '...' + v.slice(-4) : '****',
  }
})

import { createCommand } from './create.js'
import { listCommand } from './list.js'
import { getCommand } from './get.js'
import { destroyCommand } from './destroy.js'
import { execCommand } from './exec.js'
import { cloneCommand } from './clone.js'
import { keepCommand } from './keep.js'
import { addonsCommand } from './addons.js'
import { snapshotCommand } from './snapshot.js'
import { loginCommand } from './login.js'
import { configCommand } from './config.js'
import { helpCommand } from './help.js'
import { saveCredentials, loadCredentials } from '../config.js'

// Capture console output
let stdout: string[] = []
let stderr: string[] = []
const origLog = console.log
const origErr = console.error
const origWrite = process.stdout.write
const origErrWrite = process.stderr.write

beforeEach(() => {
  stdout = []
  stderr = []
  console.log = (...args: unknown[]) => { stdout.push(args.map(String).join(' ')) }
  console.error = (...args: unknown[]) => { stderr.push(args.map(String).join(' ')) }
  process.stdout.write = ((s: string) => { stdout.push(s); return true }) as typeof process.stdout.write
  process.stderr.write = ((s: string) => { stderr.push(s); return true }) as typeof process.stderr.write
  mockX402Fetch.mockReset()
  vi.mocked(saveCredentials).mockClear()
})

afterEach(() => {
  console.log = origLog
  console.error = origErr
  process.stdout.write = origWrite
  process.stderr.write = origErrWrite
})

// Prevent process.exit from actually exiting
const mockExit = vi.spyOn(process, 'exit').mockImplementation((code) => {
  throw new Error(`process.exit(${code})`)
})

describe('helpCommand', () => {
  it('prints help text', () => {
    helpCommand()
    expect(stdout.join('\n')).toContain('sandbank')
    expect(stdout.join('\n')).toContain('create')
    expect(stdout.join('\n')).toContain('exec')
  })
})

describe('loginCommand', () => {
  it('saves API key', () => {
    loginCommand([], { apiKey: 'test-key-12345678' })
    expect(vi.mocked(saveCredentials)).toHaveBeenCalled()
    expect(stdout.join('\n')).toContain('Credentials saved')
  })

  it('saves wallet key', () => {
    loginCommand([], { walletKey: '0xabcdef1234567890' })
    expect(vi.mocked(saveCredentials)).toHaveBeenCalled()
  })

  it('saves URL', () => {
    loginCommand([], { url: 'https://custom.dev' })
    expect(vi.mocked(saveCredentials)).toHaveBeenCalled()
    expect(stdout.join('\n')).toContain('https://custom.dev')
  })

  it('exits with error when no flags provided', () => {
    expect(() => loginCommand([], {})).toThrow('process.exit(1)')
    expect(stderr.join('\n')).toContain('Usage')
  })
})

describe('configCommand', () => {
  it('shows empty config', () => {
    vi.mocked(loadCredentials).mockReturnValue({})
    configCommand([], {})
    expect(stdout.join('\n')).toContain('No configuration')
  })

  it('shows config as JSON', () => {
    vi.mocked(loadCredentials).mockReturnValue({ apiKey: 'long-key-12345678', url: 'https://x.dev' })
    configCommand([], { json: true })
    const output = stdout.join('\n')
    expect(output).toContain('long...')
    expect(output).toContain('https://x.dev')
  })

  it('shows non-empty config in text mode', () => {
    vi.mocked(loadCredentials).mockReturnValue({ url: 'https://x.dev' })
    configCommand([], {})
    expect(stdout.join('\n')).toContain('url: https://x.dev')
  })

  it('sets a config value', () => {
    configCommand(['set', 'url', 'https://custom.dev'], {})
    expect(vi.mocked(saveCredentials)).toHaveBeenCalled()
    expect(stdout.join('\n')).toContain('url = https://custom.dev')
  })

  it('gets a config value', () => {
    vi.mocked(loadCredentials).mockReturnValue({ url: 'https://test.dev' })
    configCommand(['get', 'url'], {})
    expect(stdout.join('\n')).toContain('https://test.dev')
  })

  it('shows config path', () => {
    configCommand(['path'], {})
    expect(stdout.join('\n')).toContain('credentials.json')
  })

  it('exits on missing set args', () => {
    expect(() => configCommand(['set'], {})).toThrow('process.exit(1)')
  })

  it('exits on missing get key', () => {
    expect(() => configCommand(['get'], {})).toThrow('process.exit(1)')
  })
})

describe('createCommand', () => {
  it('creates a box and prints result', async () => {
    mockX402Fetch.mockResolvedValue({ id: 'abc', status: 'running', image: 'codebox' })
    await createCommand([], {})
    expect(mockX402Fetch).toHaveBeenCalledWith('/boxes', expect.objectContaining({ method: 'POST' }))
    expect(stdout.join('\n')).toContain('abc')
  })

  it('creates a box with custom options', async () => {
    mockX402Fetch.mockResolvedValue({ id: 'xyz', status: 'running', image: 'custom' })
    await createCommand(['--image', 'custom', '--cpu', '4', '--memory', '2048'], {})
    const body = JSON.parse(mockX402Fetch.mock.calls[0]![1].body)
    expect(body.image).toBe('custom')
    expect(body.cpu).toBe(4)
    expect(body.memory_mb).toBe(2048)
  })

  it('passes timeout option', async () => {
    mockX402Fetch.mockResolvedValue({ id: 'abc', status: 'running', image: 'codebox' })
    await createCommand(['--timeout', '60'], {})
    const body = JSON.parse(mockX402Fetch.mock.calls[0]![1].body)
    expect(body.timeout_minutes).toBe(60)
  })

  it('outputs JSON when flag set', async () => {
    mockX402Fetch.mockResolvedValue({ id: 'abc', status: 'running' })
    await createCommand([], { json: true })
    expect(stdout.join('\n')).toContain('"id"')
  })
})

describe('listCommand', () => {
  it('lists boxes', async () => {
    mockX402Fetch.mockResolvedValue([
      { id: 'a', status: 'running', image: 'codebox', created_at: '2026-01-01' },
    ])
    await listCommand([], {})
    expect(stdout.join('\n')).toContain('a')
    expect(stdout.join('\n')).toContain('running')
  })

  it('shows empty message', async () => {
    mockX402Fetch.mockResolvedValue([])
    await listCommand([], {})
    expect(stdout.join('\n')).toContain('No sandboxes')
  })

  it('outputs JSON', async () => {
    mockX402Fetch.mockResolvedValue([{ id: 'b' }])
    await listCommand([], { json: true })
    expect(stdout.join('\n')).toContain('"id"')
  })
})

describe('getCommand', () => {
  it('gets box details', async () => {
    mockX402Fetch.mockResolvedValue({
      id: 'abc', status: 'running', image: 'codebox',
      cpu: 2, memory_mb: 1024, created_at: '2026-01-01',
    })
    await getCommand(['abc'], {})
    expect(stdout.join('\n')).toContain('abc')
    expect(stdout.join('\n')).toContain('running')
  })

  it('outputs JSON', async () => {
    mockX402Fetch.mockResolvedValue({ id: 'abc', status: 'running' })
    await getCommand(['abc'], { json: true })
    expect(stdout.join('\n')).toContain('"id"')
  })

  it('exits without id', async () => {
    await expect(getCommand([], {})).rejects.toThrow('process.exit(1)')
  })

  it('shows ports when present', async () => {
    mockX402Fetch.mockResolvedValue({
      id: 'x', status: 'running', image: 'codebox',
      cpu: 1, memory_mb: 512, created_at: '2026-01-01',
      ports: { '8080': 10000 },
    })
    await getCommand(['x'], {})
    expect(stdout.join('\n')).toContain('8080')
  })
})

describe('destroyCommand', () => {
  it('destroys a box', async () => {
    mockX402Fetch.mockResolvedValue(undefined)
    await destroyCommand(['abc'], {})
    expect(mockX402Fetch).toHaveBeenCalledWith('/boxes/abc', { method: 'DELETE' })
    expect(stdout.join('\n')).toContain('Destroyed abc')
  })

  it('exits without id', async () => {
    await expect(destroyCommand([], {})).rejects.toThrow('process.exit(1)')
  })

  it('outputs JSON', async () => {
    mockX402Fetch.mockResolvedValue(undefined)
    await destroyCommand(['abc'], { json: true })
    expect(stdout.join('\n')).toContain('"destroyed"')
  })
})

describe('execCommand', () => {
  it('executes a command', async () => {
    mockX402Fetch.mockResolvedValue({ stdout: 'hello\n', stderr: '', exit_code: 0 })
    await execCommand(['abc', 'echo', 'hello'], {})
    expect(stdout.join('')).toContain('hello')
  })

  it('outputs JSON', async () => {
    mockX402Fetch.mockResolvedValue({ stdout: 'ok', stderr: '', exit_code: 0 })
    await execCommand(['abc', 'echo', 'ok'], { json: true })
    expect(stdout.join('\n')).toContain('"exit_code"')
  })

  it('exits without id or command', async () => {
    await expect(execCommand([], {})).rejects.toThrow('process.exit(1)')
    await expect(execCommand(['abc'], {})).rejects.toThrow('process.exit(1)')
  })

  it('writes stderr', async () => {
    mockX402Fetch.mockResolvedValue({ stdout: '', stderr: 'err\n', exit_code: 0 })
    await execCommand(['abc', 'fail'], {})
    expect(stderr.join('')).toContain('err')
  })

  it('exits with non-zero code', async () => {
    mockX402Fetch.mockResolvedValue({ stdout: '', stderr: '', exit_code: 1 })
    await expect(execCommand(['abc', 'false'], {})).rejects.toThrow('process.exit(1)')
  })
})

describe('cloneCommand', () => {
  it('clones a box', async () => {
    mockX402Fetch.mockResolvedValue({ id: 'new', status: 'running' })
    await cloneCommand(['abc'], {})
    expect(mockX402Fetch).toHaveBeenCalledWith('/boxes/abc/clone', expect.any(Object))
    expect(stdout.join('\n')).toContain('Cloned abc → new')
  })

  it('outputs JSON', async () => {
    mockX402Fetch.mockResolvedValue({ id: 'new', status: 'running' })
    await cloneCommand(['abc'], { json: true })
    expect(stdout.join('\n')).toContain('"id"')
  })

  it('uses SANDBANK_BOX_ID as default', async () => {
    const orig = process.env['SANDBANK_BOX_ID']
    process.env['SANDBANK_BOX_ID'] = 'self'
    mockX402Fetch.mockResolvedValue({ id: 'cloned', status: 'running' })
    await cloneCommand([], {})
    expect(mockX402Fetch).toHaveBeenCalledWith('/boxes/self/clone', expect.any(Object))
    process.env['SANDBANK_BOX_ID'] = orig
  })

  it('exits without id when not in sandbox', async () => {
    const orig = process.env['SANDBANK_BOX_ID']
    delete process.env['SANDBANK_BOX_ID']
    await expect(cloneCommand([], {})).rejects.toThrow('process.exit(1)')
    process.env['SANDBANK_BOX_ID'] = orig
  })
})

describe('keepCommand', () => {
  it('extends timeout', async () => {
    mockX402Fetch.mockResolvedValue({ timeout_minutes: 30 })
    await keepCommand(['abc'], {})
    expect(stdout.join('\n')).toContain('Extended abc by 30 minutes')
  })

  it('outputs JSON', async () => {
    mockX402Fetch.mockResolvedValue({ timeout_minutes: 30 })
    await keepCommand(['abc'], { json: true })
    expect(stdout.join('\n')).toContain('"timeout_minutes"')
  })

  it('uses custom minutes', async () => {
    mockX402Fetch.mockResolvedValue({ timeout_minutes: 60 })
    await keepCommand(['abc', '--minutes', '60'], {})
    const body = JSON.parse(mockX402Fetch.mock.calls[0]![1].body)
    expect(body.timeout_minutes).toBe(60)
  })

  it('exits without id', async () => {
    await expect(keepCommand([], {})).rejects.toThrow('process.exit(1)')
  })
})

describe('addonsCommand', () => {
  it('creates an addon', async () => {
    const orig = process.env['SANDBANK_BOX_ID']
    process.env['SANDBANK_BOX_ID'] = 'parent'
    mockX402Fetch.mockResolvedValue({ id: 'a1', type: 'wechatbox', status: 'running', relay_name: 'wechatbox-abc' })
    await addonsCommand(['create', 'wechatbox'], {})
    expect(stdout.join('\n')).toContain('wechatbox')
    expect(stdout.join('\n')).toContain('relay: wechatbox-abc')
    process.env['SANDBANK_BOX_ID'] = orig
  })

  it('lists addons', async () => {
    const orig = process.env['SANDBANK_BOX_ID']
    process.env['SANDBANK_BOX_ID'] = 'parent'
    mockX402Fetch.mockResolvedValue([
      { id: 'a1', type: 'logbox', status: 'running', created_at: '2026-01-01' },
    ])
    await addonsCommand(['list'], {})
    expect(stdout.join('\n')).toContain('logbox')
    process.env['SANDBANK_BOX_ID'] = orig
  })

  it('shows empty addons', async () => {
    const orig = process.env['SANDBANK_BOX_ID']
    process.env['SANDBANK_BOX_ID'] = 'parent'
    mockX402Fetch.mockResolvedValue([])
    await addonsCommand(['list'], {})
    expect(stdout.join('\n')).toContain('No addons')
    process.env['SANDBANK_BOX_ID'] = orig
  })

  it('exits on missing type', async () => {
    const orig = process.env['SANDBANK_BOX_ID']
    process.env['SANDBANK_BOX_ID'] = 'parent'
    await expect(addonsCommand(['create'], {})).rejects.toThrow('process.exit(1)')
    process.env['SANDBANK_BOX_ID'] = orig
  })

  it('exits on missing box id for create', async () => {
    const orig = process.env['SANDBANK_BOX_ID']
    delete process.env['SANDBANK_BOX_ID']
    await expect(addonsCommand(['create', 'logbox'], {})).rejects.toThrow('process.exit(1)')
    process.env['SANDBANK_BOX_ID'] = orig
  })

  it('exits on missing box id for list', async () => {
    const orig = process.env['SANDBANK_BOX_ID']
    delete process.env['SANDBANK_BOX_ID']
    await expect(addonsCommand(['list'], {})).rejects.toThrow('process.exit(1)')
    process.env['SANDBANK_BOX_ID'] = orig
  })

  it('uses --box flag', async () => {
    mockX402Fetch.mockResolvedValue({ id: 'a1', type: 'logbox', status: 'running', relay_name: null })
    await addonsCommand(['create', 'logbox', '--box', 'mybox'], {})
    expect(mockX402Fetch).toHaveBeenCalledWith('/boxes/mybox/addons', expect.any(Object))
  })

  it('creates addon without relay_name', async () => {
    const orig = process.env['SANDBANK_BOX_ID']
    process.env['SANDBANK_BOX_ID'] = 'parent'
    mockX402Fetch.mockResolvedValue({ id: 'a1', type: 'logbox', status: 'running', relay_name: null })
    await addonsCommand(['create', 'logbox'], {})
    expect(stdout.join('\n')).toContain('logbox')
    expect(stdout.join('\n')).not.toContain('relay:')
    process.env['SANDBANK_BOX_ID'] = orig
  })

  it('creates addon with --intent flag', async () => {
    const orig = process.env['SANDBANK_BOX_ID']
    process.env['SANDBANK_BOX_ID'] = 'parent'
    mockX402Fetch.mockResolvedValue({ id: 'a1', type: 'logbox', status: 'running', relay_name: null })
    await addonsCommand(['create', 'logbox', '--intent', 'monitor errors'], {})
    const body = JSON.parse(mockX402Fetch.mock.calls[0]![1].body)
    expect(body.intent).toBe('monitor errors')
    process.env['SANDBANK_BOX_ID'] = orig
  })

  it('outputs JSON for create', async () => {
    const orig = process.env['SANDBANK_BOX_ID']
    process.env['SANDBANK_BOX_ID'] = 'parent'
    mockX402Fetch.mockResolvedValue({ id: 'a1', type: 'logbox', status: 'running', relay_name: null })
    await addonsCommand(['create', 'logbox'], { json: true })
    expect(stdout.join('\n')).toContain('"id"')
    process.env['SANDBANK_BOX_ID'] = orig
  })

  it('outputs JSON for list', async () => {
    const orig = process.env['SANDBANK_BOX_ID']
    process.env['SANDBANK_BOX_ID'] = 'parent'
    mockX402Fetch.mockResolvedValue([{ id: 'a1' }])
    await addonsCommand(['list'], { json: true })
    expect(stdout.join('\n')).toContain('"id"')
    process.env['SANDBANK_BOX_ID'] = orig
  })

  it('exits on unknown subcommand', async () => {
    await expect(addonsCommand(['unknown'], {})).rejects.toThrow('process.exit(1)')
  })
})

describe('snapshotCommand', () => {
  it('creates a snapshot', async () => {
    mockX402Fetch.mockResolvedValue(undefined)
    await snapshotCommand(['create', 'abc', 'snap1'], {})
    expect(stdout.join('\n')).toContain('Snapshot "snap1" created')
  })

  it('lists snapshots', async () => {
    mockX402Fetch.mockResolvedValue([{ name: 'snap1' }, { name: 'snap2', created_at: '2026-01-01' }])
    await snapshotCommand(['list', 'abc'], {})
    expect(stdout.join('\n')).toContain('snap1')
    expect(stdout.join('\n')).toContain('snap2')
  })

  it('shows empty snapshots', async () => {
    mockX402Fetch.mockResolvedValue([])
    await snapshotCommand(['list', 'abc'], {})
    expect(stdout.join('\n')).toContain('No snapshots')
  })

  it('restores a snapshot', async () => {
    mockX402Fetch.mockResolvedValue(undefined)
    await snapshotCommand(['restore', 'abc', 'snap1'], {})
    expect(stdout.join('\n')).toContain('Restored "snap1"')
  })

  it('deletes a snapshot', async () => {
    mockX402Fetch.mockResolvedValue(undefined)
    await snapshotCommand(['delete', 'abc', 'snap1'], {})
    expect(stdout.join('\n')).toContain('Deleted "snap1"')
  })

  it('exits on missing args for create', async () => {
    await expect(snapshotCommand(['create', 'abc'], {})).rejects.toThrow('process.exit(1)')
  })

  it('exits on missing args for list', async () => {
    await expect(snapshotCommand(['list'], {})).rejects.toThrow('process.exit(1)')
  })

  it('exits on missing args for restore', async () => {
    await expect(snapshotCommand(['restore', 'abc'], {})).rejects.toThrow('process.exit(1)')
  })

  it('exits on missing args for delete', async () => {
    await expect(snapshotCommand(['delete', 'abc'], {})).rejects.toThrow('process.exit(1)')
  })

  it('exits on unknown subcommand', async () => {
    await expect(snapshotCommand(['unknown'], {})).rejects.toThrow('process.exit(1)')
  })

  it('outputs JSON for create', async () => {
    mockX402Fetch.mockResolvedValue(undefined)
    await snapshotCommand(['create', 'abc', 's1'], { json: true })
    expect(stdout.join('\n')).toContain('"created"')
  })

  it('outputs JSON for restore', async () => {
    mockX402Fetch.mockResolvedValue(undefined)
    await snapshotCommand(['restore', 'abc', 's1'], { json: true })
    expect(stdout.join('\n')).toContain('"restored"')
  })

  it('outputs JSON for delete', async () => {
    mockX402Fetch.mockResolvedValue(undefined)
    await snapshotCommand(['delete', 'abc', 's1'], { json: true })
    expect(stdout.join('\n')).toContain('"deleted"')
  })
})
