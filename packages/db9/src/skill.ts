import type { SkillDefinition } from '@sandbank.dev/core'

const SKILL_URL = 'https://db9.ai/skill.md'
const CACHE_TTL = 24 * 60 * 60 * 1000 // 24 hours

let cachedSkill: { content: string; fetchedAt: number } | null = null
let inflightRequest: Promise<string> | null = null

/** 获取 db9 官方 skill，带 24h 内存缓存和并发去重 */
export async function fetchDb9Skill(): Promise<string> {
  if (cachedSkill && Date.now() - cachedSkill.fetchedAt < CACHE_TTL) {
    return cachedSkill.content
  }
  if (!inflightRequest) {
    inflightRequest = (async () => {
      const resp = await fetch(SKILL_URL)
      if (!resp.ok) {
        throw new Error(`Failed to fetch db9 skill: ${resp.status} ${resp.statusText}`)
      }
      const content = await resp.text()
      cachedSkill = { content, fetchedAt: Date.now() }
      return content
    })().finally(() => {
      inflightRequest = null
    })
  }
  return inflightRequest
}

/** 构建注入用的 SkillDefinition */
export function db9SkillDefinition(content: string): SkillDefinition {
  return { name: 'db9-postgres', content }
}

/** 清除 skill 缓存（测试用）。不清空 inflightRequest，让飞行中的请求自然完成。 */
export function clearSkillCache(): void {
  cachedSkill = null
}
