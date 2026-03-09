/**
 * db9 集成测试 — 需要 DB9_TOKEN 环境变量。
 *
 * 运行方式：
 *   DB9_TOKEN=xxx pnpm --filter @sandbank.dev/db9 test:e2e
 */
import { describe, it, expect, afterAll } from 'vitest'
import { Db9ServiceAdapter } from '../src/adapter.js'
import { initBrainSchema } from '../src/brain.js'

const token = process.env['DB9_TOKEN']

describe.skipIf(!token)('db9 integration', () => {
  const adapter = new Db9ServiceAdapter({ token: token! })
  const cleanupIds: string[] = []

  afterAll(async () => {
    for (const id of cleanupIds) {
      await adapter.destroyService(id).catch(() => {})
    }
  })

  it('full lifecycle: create → get → sql → branch → destroy', async () => {
    // 创建数据库
    const svc = await adapter.createService({
      type: 'postgres',
      name: `sandbank-test-${Date.now()}`,
    })
    cleanupIds.push(svc.id)
    expect(svc.type).toBe('postgres')
    expect(svc.credentials.url).toBeTruthy()
    expect(svc.credentials.env.DATABASE_URL).toBeTruthy()

    // 获取详情
    const info = await adapter.getService(svc.id)
    expect(info.id).toBe(svc.id)

    // 执行 SQL
    const result = await adapter.client.executeSQL(svc.id, 'SELECT 1 AS num')
    expect(result.row_count).toBe(1)

    // 列出服务
    const list = await adapter.listServices()
    expect(list.some(s => s.id === svc.id)).toBe(true)

    // 创建分支
    const branch = await adapter.branchService(svc.id, 'test-branch')
    cleanupIds.push(branch.id)
    expect(branch.name).toBeTruthy()

    // 删除分支
    await adapter.deleteBranch(branch.id)
    cleanupIds.pop() // 已删除

    // 删除数据库
    await adapter.destroyService(svc.id)
    cleanupIds.pop() // 已删除
  }, 60_000)

  it('brain schema initialization', async () => {
    const svc = await adapter.createService({
      type: 'postgres',
      name: `sandbank-brain-${Date.now()}`,
    })
    cleanupIds.push(svc.id)

    await initBrainSchema(adapter.client, svc.id)

    // 验证表存在
    const result = await adapter.client.executeSQL(
      svc.id,
      "SELECT table_name FROM information_schema.tables WHERE table_schema = 'public' ORDER BY table_name",
    )
    const tables = result.rows.map(r => r[0])
    expect(tables).toContain('memory')
    expect(tables).toContain('tasks')
    expect(tables).toContain('artifacts')

    await adapter.destroyService(svc.id)
    cleanupIds.pop()
  }, 60_000)

  it('skill fetch', async () => {
    const skill = await adapter.getSkill()
    expect(skill.name).toBe('db9-postgres')
    expect(skill.content.length).toBeGreaterThan(100)
  })
})
