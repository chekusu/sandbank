import type { Sandbox, SkillDefinition } from './types.js'

const DEFAULT_SKILL_DIR = '/root/.claude/skills'

export async function injectSkills(
  sandbox: Sandbox,
  skills: SkillDefinition[],
  skillDir?: string,
): Promise<void> {
  const dir = skillDir ?? DEFAULT_SKILL_DIR
  for (const skill of skills) {
    const path = `${dir}/${skill.name}.md`
    await sandbox.writeFile(path, skill.content)
  }
}
