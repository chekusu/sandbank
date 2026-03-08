import type { Sandbox, SkillDefinition } from './types.js'

const DEFAULT_SKILL_DIR = '/root/.claude/skills'

function shellEscape(s: string): string {
  return "'" + s.replace(/'/g, "'\\''") + "'"
}

function validateSkillName(name: string): void {
  if (name === '' || name === '.' || name === '..' || name.includes('/') || name.includes('\\')) {
    throw new Error(`Invalid skill name: "${name}" — must not contain path separators or be empty`)
  }
}

export async function injectSkills(
  sandbox: Sandbox,
  skills: SkillDefinition[],
  skillDir?: string,
): Promise<void> {
  if (skills.length === 0) return
  const dir = skillDir ?? DEFAULT_SKILL_DIR
  for (const skill of skills) {
    validateSkillName(skill.name)
  }
  // Ensure target directory exists
  await sandbox.exec(`mkdir -p ${shellEscape(dir)}`)
  for (const skill of skills) {
    const path = `${dir}/${skill.name}.md`
    await sandbox.writeFile(path, skill.content)
  }
}
