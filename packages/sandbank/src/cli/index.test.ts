import { describe, it, expect, vi, beforeEach } from 'vitest'

// Mock all command modules — vi.hoisted ensures mocks are available before imports
const mocks = vi.hoisted(() => ({
  loginCommand: vi.fn(),
  configCommand: vi.fn(),
  createCommand: vi.fn(),
  listCommand: vi.fn(),
  getCommand: vi.fn(),
  destroyCommand: vi.fn(),
  execCommand: vi.fn(),
  cloneCommand: vi.fn(),
  keepCommand: vi.fn(),
  addonsCommand: vi.fn(),
  snapshotCommand: vi.fn(),
  helpCommand: vi.fn(),
}))

vi.mock('./commands/login.js', () => ({ loginCommand: mocks.loginCommand }))
vi.mock('./commands/config.js', () => ({ configCommand: mocks.configCommand }))
vi.mock('./commands/create.js', () => ({ createCommand: mocks.createCommand }))
vi.mock('./commands/list.js', () => ({ listCommand: mocks.listCommand }))
vi.mock('./commands/get.js', () => ({ getCommand: mocks.getCommand }))
vi.mock('./commands/destroy.js', () => ({ destroyCommand: mocks.destroyCommand }))
vi.mock('./commands/exec.js', () => ({ execCommand: mocks.execCommand }))
vi.mock('./commands/clone.js', () => ({ cloneCommand: mocks.cloneCommand }))
vi.mock('./commands/keep.js', () => ({ keepCommand: mocks.keepCommand }))
vi.mock('./commands/addons.js', () => ({ addonsCommand: mocks.addonsCommand }))
vi.mock('./commands/snapshot.js', () => ({ snapshotCommand: mocks.snapshotCommand }))
vi.mock('./commands/help.js', () => ({ helpCommand: mocks.helpCommand }))

import { takeFlag, takeOption, parseGlobalFlags, dispatch, VERSION } from './index.js'

vi.spyOn(process, 'exit').mockImplementation((code) => {
  throw new Error(`process.exit(${code})`)
})

describe('takeFlag', () => {
  it('removes flag and returns true', () => {
    const args = ['--json', 'create']
    expect(takeFlag(args, '--json')).toBe(true)
    expect(args).toEqual(['create'])
  })

  it('returns false when flag not present', () => {
    const args = ['create']
    expect(takeFlag(args, '--json')).toBe(false)
    expect(args).toEqual(['create'])
  })
})

describe('takeOption', () => {
  it('removes option and value, returns value', () => {
    const args = ['--api-key', 'mykey', 'create']
    expect(takeOption(args, '--api-key')).toBe('mykey')
    expect(args).toEqual(['create'])
  })

  it('returns undefined when option not present', () => {
    const args = ['create']
    expect(takeOption(args, '--api-key')).toBeUndefined()
  })
})

describe('parseGlobalFlags', () => {
  it('extracts all global flags', () => {
    const args = ['--api-key', 'k', '--wallet-key', '0x1', '--url', 'http://x', '--json', 'create']
    const flags = parseGlobalFlags(args)
    expect(flags).toEqual({ apiKey: 'k', walletKey: '0x1', url: 'http://x', json: true })
    expect(args).toEqual(['create'])
  })

  it('returns empty flags when none present', () => {
    const args = ['create']
    const flags = parseGlobalFlags(args)
    expect(flags).toEqual({ apiKey: undefined, walletKey: undefined, url: undefined, json: false })
  })
})

describe('dispatch', () => {
  beforeEach(() => { vi.clearAllMocks() })

  it('shows version with --version', async () => {
    const spy = vi.spyOn(console, 'log').mockImplementation(() => {})
    await dispatch(['--version'])
    expect(spy).toHaveBeenCalledWith(VERSION)
    spy.mockRestore()
  })

  it('shows version with -v', async () => {
    const spy = vi.spyOn(console, 'log').mockImplementation(() => {})
    await dispatch(['-v'])
    expect(spy).toHaveBeenCalledWith(VERSION)
    spy.mockRestore()
  })

  it('shows help with --help', async () => {
    await dispatch(['--help'])
    expect(mocks.helpCommand).toHaveBeenCalled()
  })

  it('shows help with -h', async () => {
    await dispatch(['-h'])
    expect(mocks.helpCommand).toHaveBeenCalled()
  })

  it('shows help with no args', async () => {
    await dispatch([])
    expect(mocks.helpCommand).toHaveBeenCalled()
  })

  const commandMap: Array<[string, keyof typeof mocks, string[]]> = [
    ['login', 'loginCommand', ['login', '--api-key', 'x']],
    ['config', 'configCommand', ['config']],
    ['create', 'createCommand', ['create']],
    ['list', 'listCommand', ['list']],
    ['ls', 'listCommand', ['ls']],
    ['get', 'getCommand', ['get', 'abc']],
    ['destroy', 'destroyCommand', ['destroy', 'abc']],
    ['rm', 'destroyCommand', ['rm', 'abc']],
    ['exec', 'execCommand', ['exec', 'abc', 'echo']],
    ['clone', 'cloneCommand', ['clone', 'abc']],
    ['keep', 'keepCommand', ['keep', 'abc']],
    ['addons', 'addonsCommand', ['addons', 'list']],
    ['snapshot', 'snapshotCommand', ['snapshot', 'list', 'abc']],
    ['help', 'helpCommand', ['help']],
  ]

  for (const [name, fn, args] of commandMap) {
    it(`dispatches ${name}`, async () => {
      await dispatch([...args])
      expect(mocks[fn]).toHaveBeenCalled()
    })
  }

  it('exits on unknown command', async () => {
    await expect(dispatch(['unknown'])).rejects.toThrow('process.exit(1)')
  })

  it('passes global flags to commands', async () => {
    await dispatch(['create', '--api-key', 'mykey', '--json'])
    const [, flags] = mocks.createCommand.mock.calls[0]!
    expect(flags.apiKey).toBe('mykey')
    expect(flags.json).toBe(true)
  })
})
