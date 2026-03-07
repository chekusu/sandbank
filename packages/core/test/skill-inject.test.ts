import { describe, it, expect, vi } from 'vitest'
import { injectSkills } from '../src/skill-inject.js'
import type { Sandbox, SkillDefinition } from '../src/types.js'

function mockSandbox(): Sandbox {
  return {
    id: 'sb-mock',
    state: 'running',
    createdAt: '2025-01-01T00:00:00Z',
    exec: vi.fn(async () => ({ exitCode: 0, stdout: '', stderr: '' })),
    writeFile: vi.fn(async () => {}),
    readFile: vi.fn(async () => new Uint8Array()),
    uploadArchive: vi.fn(async () => {}),
    downloadArchive: vi.fn(async () => new ReadableStream()),
  }
}

describe('injectSkills', () => {
  it('writes each skill as a .md file via sandbox.writeFile', async () => {
    const sandbox = mockSandbox()
    const skills: SkillDefinition[] = [
      { name: 'skill-a', content: '# Skill A' },
      { name: 'skill-b', content: '# Skill B' },
    ]

    await injectSkills(sandbox, skills)

    expect(sandbox.writeFile).toHaveBeenCalledTimes(2)
    expect(sandbox.writeFile).toHaveBeenCalledWith('/root/.claude/skills/skill-a.md', '# Skill A')
    expect(sandbox.writeFile).toHaveBeenCalledWith('/root/.claude/skills/skill-b.md', '# Skill B')
  })

  it('uses default directory /root/.claude/skills', async () => {
    const sandbox = mockSandbox()
    const skills: SkillDefinition[] = [{ name: 'test', content: 'content' }]

    await injectSkills(sandbox, skills)

    expect(sandbox.writeFile).toHaveBeenCalledWith('/root/.claude/skills/test.md', 'content')
  })

  it('uses custom skillDir when provided', async () => {
    const sandbox = mockSandbox()
    const skills: SkillDefinition[] = [{ name: 'test', content: 'content' }]

    await injectSkills(sandbox, skills, '/home/user/.claude/skills')

    expect(sandbox.writeFile).toHaveBeenCalledWith('/home/user/.claude/skills/test.md', 'content')
  })

  it('does not call writeFile when skills array is empty', async () => {
    const sandbox = mockSandbox()

    await injectSkills(sandbox, [])

    expect(sandbox.writeFile).not.toHaveBeenCalled()
  })
})
