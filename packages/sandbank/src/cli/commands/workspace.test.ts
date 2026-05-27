import { mkdtemp, rm } from 'node:fs/promises'
import { join } from 'node:path'
import { tmpdir } from 'node:os'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { workspaceCommand } from './workspace.js'

let dir: string
let stdout: string[]
let stderr: string[]
let origLog: typeof console.log
let origErr: typeof console.error

beforeEach(async () => {
  dir = await mkdtemp(join(tmpdir(), 'sandbank-workspace-cli-'))
  stdout = []
  stderr = []
  origLog = console.log
  origErr = console.error
  console.log = (...args: unknown[]) => { stdout.push(args.map(String).join(' ')) }
  console.error = (...args: unknown[]) => { stderr.push(args.map(String).join(' ')) }
})

afterEach(async () => {
  console.log = origLog
  console.error = origErr
  await rm(dir, { recursive: true, force: true })
})

describe('workspaceCommand', () => {
  it('writes, reads, lists, checkpoints, inspects, and replays watch events using a local store', async () => {
    const store = join(dir, 'workspace.json')
    const storeArgs = ['--store', store]

    await workspaceCommand(['write', '/files/a.txt', 'hello', ...storeArgs], {})
    await workspaceCommand(['read', '/files/a.txt', ...storeArgs], {})
    expect(stdout.join('\n')).toContain('hello')

    await workspaceCommand(['list', '/files', ...storeArgs], {})
    expect(stdout.join('\n')).toContain('/files/a.txt')

    await workspaceCommand(['checkpoint', 'first', ...storeArgs], {})
    expect(stdout.join('\n')).toContain('checkpoint')

    await workspaceCommand(['inspect', ...storeArgs], {})
    expect(stdout.join('\n')).toContain('@sandbank.dev/workspace')

    await workspaceCommand(['watch', '/files', '--replay', ...storeArgs], {})
    expect(stdout.join('\n')).toContain('write /files/a.txt')
  })
})
