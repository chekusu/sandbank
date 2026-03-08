import { readFile, readdir } from 'node:fs/promises'
import { join, basename } from 'node:path'
import type { SkillDefinition } from '@sandbank/core'
import type { SkillSource } from '../types.js'

export function createLocalSource(dir: string): SkillSource {
  return {
    name: 'local',

    async load(name: string): Promise<SkillDefinition | undefined> {
      if (!name || name === '.' || name === '..' || name.includes('/') || name.includes('\\')) {
        return undefined
      }
      const filePath = join(dir, `${name}.md`)
      try {
        const content = await readFile(filePath, 'utf-8')
        return { name, content }
      } catch {
        return undefined
      }
    },

    async list(): Promise<string[]> {
      try {
        const files = await readdir(dir)
        return files
          .filter(f => f.endsWith('.md'))
          .map(f => basename(f, '.md'))
      } catch {
        return []
      }
    },
  }
}
