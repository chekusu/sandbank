import type { ServiceConfig, ServiceInfo, SkillDefinition } from '@sandbank.dev/core'
import { Db9Client, type Db9ClientConfig } from './client.js'
import { fetchDb9Skill, db9SkillDefinition } from './skill.js'
import type { Db9Database } from './types.js'

export interface Db9AdapterConfig extends Db9ClientConfig {
  /** 是否自动注入 db9 官方 skill。默认 true */
  injectSkill?: boolean
  /** 自定义 skill 内容（覆盖默认获取） */
  skillContent?: string
}

function mapDbToServiceInfo(db: Db9Database): ServiceInfo {
  return {
    id: db.id,
    type: 'postgres',
    name: db.name,
    state: db.state === 'ready' ? 'ready'
      : db.state === 'creating' ? 'creating'
      : db.state === 'terminated' || db.state === 'deleted' ? 'terminated'
      : 'error',
    credentials: {
      url: db.connection_string,
      env: {
        DATABASE_URL: db.connection_string,
        DB9_DATABASE_ID: db.id,
        DB9_DATABASE_NAME: db.name,
        PGHOST: db.host,
        PGPORT: String(db.port),
        PGUSER: db.username,
        PGPASSWORD: db.password,
        PGDATABASE: db.database,
      },
    },
  }
}

export class Db9ServiceAdapter {
  readonly name = 'db9'
  readonly client: Db9Client
  private readonly config: Db9AdapterConfig

  constructor(config: Db9AdapterConfig) {
    this.config = config
    this.client = new Db9Client(config)
  }

  async createService(config: ServiceConfig): Promise<ServiceInfo> {
    const db = await this.client.createDatabase(config.name)
    return mapDbToServiceInfo(db)
  }

  async getService(id: string): Promise<ServiceInfo> {
    const db = await this.client.getDatabase(id)
    return mapDbToServiceInfo(db)
  }

  async listServices(): Promise<ServiceInfo[]> {
    const dbs = await this.client.listDatabases()
    return dbs.map(mapDbToServiceInfo)
  }

  async destroyService(id: string): Promise<void> {
    await this.client.deleteDatabase(id)
  }

  // --- db9 特有能力 ---

  /** 创建数据库分支 */
  async branchService(serviceId: string, name: string): Promise<ServiceInfo> {
    const db = await this.client.createBranch(serviceId, name)
    return mapDbToServiceInfo(db)
  }

  /** 删除分支 */
  async deleteBranch(branchId: string): Promise<void> {
    await this.client.deleteBranch(branchId)
  }

  /** 获取 db9 官方 skill（带 24h 内存缓存） */
  async getSkill(): Promise<SkillDefinition> {
    if (this.config.skillContent) {
      return db9SkillDefinition(this.config.skillContent)
    }
    const content = await fetchDb9Skill()
    return db9SkillDefinition(content)
  }
}
