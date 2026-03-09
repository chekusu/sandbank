import type { ServiceInfo, SkillDefinition } from '@sandbank.dev/core'
import { Db9ServiceAdapter, type Db9AdapterConfig } from './adapter.js'
import { initBrainSchema } from './brain.js'
import { brainSkillDefinition } from './brain-skill.js'

/** 一键创建数据库 + 获取 skill */
export async function createDb9Service(
  config: Db9AdapterConfig & { name: string },
): Promise<{ service: ServiceInfo; skill: SkillDefinition; adapter: Db9ServiceAdapter }> {
  const adapter = new Db9ServiceAdapter(config)
  const [service, skill] = await Promise.all([
    adapter.createService({ type: 'postgres', name: config.name }),
    adapter.getSkill(),
  ])
  return { service, skill, adapter }
}

/** 一键创建带 brain schema 的多 Agent 数据库 */
export async function createDb9Brain(
  config: Db9AdapterConfig & { name: string },
): Promise<{
  service: ServiceInfo
  skills: SkillDefinition[]
  adapter: Db9ServiceAdapter
}> {
  const { service, skill, adapter } = await createDb9Service(config)
  if (service.state !== 'ready') {
    await adapter.destroyService(service.id).catch(() => {})
    throw new Error(`Database '${service.id}' is not ready (state: ${service.state}), cannot initialize brain schema`)
  }
  await initBrainSchema(adapter.client, service.id).catch(async (err) => {
    await adapter.destroyService(service.id).catch(() => {})
    throw err
  })
  return {
    service,
    skills: [skill, brainSkillDefinition()],
    adapter,
  }
}
