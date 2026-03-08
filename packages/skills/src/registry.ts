import type { SkillDefinition } from '@sandbank/core'
import type { SkillSource, SkillRegistry } from './types.js'

export function createSkillRegistry(): SkillRegistry {
  const sources: SkillSource[] = []

  const registry: SkillRegistry = {
    addSource(source: SkillSource): void {
      sources.push(source)
    },

    async load(name: string): Promise<SkillDefinition | undefined> {
      for (const source of sources) {
        const skill = await source.load(name)
        if (skill) return skill
      }
      return undefined
    },

    async loadMany(names: string[]): Promise<SkillDefinition[]> {
      const results: SkillDefinition[] = []
      for (const name of names) {
        const skill = await registry.load(name)
        if (skill) results.push(skill)
      }
      return results
    },

    async list(): Promise<string[]> {
      const all = new Set<string>()
      for (const source of sources) {
        const names = await source.list()
        for (const n of names) all.add(n)
      }
      return [...all]
    },
  }

  return registry
}
