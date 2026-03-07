import { describe, it, expect, beforeEach } from 'vitest'
import { mkdtemp, writeFile, rm } from 'node:fs/promises'
import { join } from 'node:path'
import { tmpdir } from 'node:os'
import { createLocalSource } from '../../src/sources/local.js'

describe('createLocalSource', () => {
  let dir: string

  beforeEach(async () => {
    dir = await mkdtemp(join(tmpdir(), 'sandbank-skills-test-'))
    return async () => {
      await rm(dir, { recursive: true, force: true })
    }
  })

  it('loads an existing .md file', async () => {
    await writeFile(join(dir, 'greeting.md'), '# Hello\nWorld')
    const source = createLocalSource(dir)

    const skill = await source.load('greeting')
    expect(skill).toEqual({ name: 'greeting', content: '# Hello\nWorld' })
  })

  it('returns undefined for a missing file', async () => {
    const source = createLocalSource(dir)
    expect(await source.load('nonexistent')).toBeUndefined()
  })

  it('lists all .md files and ignores non-.md files', async () => {
    await writeFile(join(dir, 'alpha.md'), 'a')
    await writeFile(join(dir, 'beta.md'), 'b')
    await writeFile(join(dir, 'notes.txt'), 'ignore me')

    const source = createLocalSource(dir)
    const names = await source.list()
    expect(names.sort()).toEqual(['alpha', 'beta'])
  })

  it('returns empty list when directory does not exist', async () => {
    const source = createLocalSource('/tmp/nonexistent-dir-sandbank-test')
    expect(await source.list()).toEqual([])
  })
})
