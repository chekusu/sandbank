import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest'
import { fetchDb9Skill, db9SkillDefinition, clearSkillCache } from '../src/skill.js'

const mockFetch = vi.fn()
vi.stubGlobal('fetch', mockFetch)

describe('fetchDb9Skill', () => {
  beforeEach(() => {
    mockFetch.mockReset()
    clearSkillCache()
  })

  afterEach(() => {
    vi.useRealTimers()
  })

  it('fetches skill from remote on first call', async () => {
    mockFetch.mockResolvedValueOnce(new Response('# db9 skill content', { status: 200 }))
    const content = await fetchDb9Skill()
    expect(content).toBe('# db9 skill content')
    expect(mockFetch).toHaveBeenCalledTimes(1)
    expect(mockFetch).toHaveBeenCalledWith('https://db9.ai/skill.md')
  })

  it('returns cached content on second call within TTL', async () => {
    mockFetch.mockResolvedValueOnce(new Response('# cached', { status: 200 }))
    const first = await fetchDb9Skill()
    const second = await fetchDb9Skill()
    expect(first).toBe('# cached')
    expect(second).toBe('# cached')
    // Only one fetch call — second was served from cache
    expect(mockFetch).toHaveBeenCalledTimes(1)
  })

  it('re-fetches after TTL expires', async () => {
    vi.useFakeTimers()

    mockFetch.mockResolvedValueOnce(new Response('# old', { status: 200 }))
    const first = await fetchDb9Skill()
    expect(first).toBe('# old')

    // Advance past 24h TTL
    vi.advanceTimersByTime(25 * 60 * 60 * 1000)

    mockFetch.mockResolvedValueOnce(new Response('# new', { status: 200 }))
    const second = await fetchDb9Skill()
    expect(second).toBe('# new')
    expect(mockFetch).toHaveBeenCalledTimes(2)
  })

  it('throws when fetch fails', async () => {
    mockFetch.mockResolvedValueOnce(new Response('Server Error', { status: 500, statusText: 'Internal Server Error' }))
    await expect(fetchDb9Skill()).rejects.toThrow('Failed to fetch db9 skill: 500')
  })

  it('deduplicates concurrent requests (only one fetch)', async () => {
    mockFetch.mockResolvedValueOnce(new Response('# deduped', { status: 200 }))
    const [a, b, c] = await Promise.all([
      fetchDb9Skill(),
      fetchDb9Skill(),
      fetchDb9Skill(),
    ])
    expect(a).toBe('# deduped')
    expect(b).toBe('# deduped')
    expect(c).toBe('# deduped')
    // Only one fetch despite three concurrent calls
    expect(mockFetch).toHaveBeenCalledTimes(1)
  })

  it('clearSkillCache forces re-fetch', async () => {
    mockFetch.mockResolvedValueOnce(new Response('# first', { status: 200 }))
    await fetchDb9Skill()

    clearSkillCache()

    mockFetch.mockResolvedValueOnce(new Response('# second', { status: 200 }))
    const result = await fetchDb9Skill()
    expect(result).toBe('# second')
    expect(mockFetch).toHaveBeenCalledTimes(2)
  })
})

describe('db9SkillDefinition', () => {
  it('returns SkillDefinition with correct name and content', () => {
    const skill = db9SkillDefinition('# test content')
    expect(skill.name).toBe('db9-postgres')
    expect(skill.content).toBe('# test content')
  })
})
