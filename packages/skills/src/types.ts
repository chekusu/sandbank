import type { SkillDefinition } from '@sandbank.dev/core'

export interface SkillSource {
  readonly name: string
  load(name: string): Promise<SkillDefinition | undefined>
  list(): Promise<string[]>
}

export interface SkillRegistry {
  addSource(source: SkillSource): void
  load(name: string): Promise<SkillDefinition | undefined>
  loadMany(names: string[]): Promise<SkillDefinition[]>
  list(): Promise<string[]>
}
