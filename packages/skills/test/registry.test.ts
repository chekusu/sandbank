import { describe, it, expect, vi } from 'vitest'
import { createSkillRegistry } from '../src/registry.js'
import type { SkillSource } from '../src/types.js'

function createMockSource(
  name: string,
  skills: Record<string, string>,
): SkillSource {
  return {
    name,
    load: vi.fn(async (n: string) => {
      const content = skills[n]
      return content ? { name: n, content } : undefined
    }),
    list: vi.fn(async () => Object.keys(skills)),
  }
}

describe('createSkillRegistry', () => {
  it('returns undefined when no sources are registered', async () => {
    const registry = createSkillRegistry()
    expect(await registry.load('anything')).toBeUndefined()
  })

  it('returns empty list when no sources are registered', async () => {
    const registry = createSkillRegistry()
    expect(await registry.list()).toEqual([])
  })

  it('loads a skill from a registered source', async () => {
    const registry = createSkillRegistry()
    const source = createMockSource('test', { greeting: 'Hello!' })
    registry.addSource(source)

    const skill = await registry.load('greeting')
    expect(skill).toEqual({ name: 'greeting', content: 'Hello!' })
  })

  it('returns the first match when multiple sources have the same skill', async () => {
    const registry = createSkillRegistry()
    const first = createMockSource('first', { greeting: 'First' })
    const second = createMockSource('second', { greeting: 'Second' })
    registry.addSource(first)
    registry.addSource(second)

    const skill = await registry.load('greeting')
    expect(skill).toEqual({ name: 'greeting', content: 'First' })
    expect(second.load).not.toHaveBeenCalled()
  })

  it('loads many skills at once', async () => {
    const registry = createSkillRegistry()
    const source = createMockSource('test', {
      a: 'content-a',
      b: 'content-b',
    })
    registry.addSource(source)

    const skills = await registry.loadMany(['a', 'b', 'missing'])
    expect(skills).toEqual([
      { name: 'a', content: 'content-a' },
      { name: 'b', content: 'content-b' },
    ])
  })

  it('deduplicates names from multiple sources in list()', async () => {
    const registry = createSkillRegistry()
    registry.addSource(createMockSource('first', { a: '1', b: '2' }))
    registry.addSource(createMockSource('second', { b: '3', c: '4' }))

    const names = await registry.list()
    expect(names).toEqual(['a', 'b', 'c'])
  })
})
