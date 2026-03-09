# 计划：db9.ai 集成 + Service Layer

> 日期：2026-03-09
> 调研文档：[../research-db9-service-layer.md](../research-db9-service-layer.md)
> 状态：已完成

## 概述

在 Sandbank 中引入 Service Layer 抽象，并以 db9.ai 作为第一个 ServiceProvider 实现。分三个阶段推进。

---

## Phase 1：Core 接口扩展

> 目标：在 `@sandbank.dev/core` 中定义 Service 相关的类型、能力检测、和 Provider 工厂扩展。

### 1.1 类型定义

**文件**：`packages/core/src/types.ts`

新增以下类型：

```typescript
// --- Service 类型 ---

export type ServiceType = 'postgres'  // 未来可扩展 'redis' | 'queue' 等

export interface ServiceConfig {
  /** 服务类型 */
  type: ServiceType
  /** 服务名称 */
  name: string
  /** 区域偏好（provider 可忽略） */
  region?: string
}

export interface ServiceCredentials {
  /** 主连接 URL（如 postgres://...） */
  url: string
  /** 注入到 sandbox 的环境变量映射 */
  env: Record<string, string>
}

export interface ServiceInfo {
  id: string
  type: ServiceType
  name: string
  state: 'creating' | 'ready' | 'error' | 'terminated'
  credentials: ServiceCredentials
}

export interface ServiceProvider extends SandboxProvider {
  createService(config: ServiceConfig): Promise<ServiceInfo>
  getService(id: string): Promise<ServiceInfo>
  listServices(): Promise<ServiceInfo[]>
  destroyService(id: string): Promise<void>
}

// --- Service 绑定 ---

export interface ServiceBinding {
  /** Service ID */
  id: string
  /** 环境变量前缀。默认无前缀（直接用 DATABASE_URL 等）。
   *  设为 'BRAIN' 则注入 BRAIN_DATABASE_URL 等 */
  envPrefix?: string
}
```

**修改 `CreateConfig`**：

```typescript
export interface CreateConfig {
  // ... 现有字段不变 ...

  /** 绑定的服务。凭证自动注入为环境变量 */
  services?: ServiceBinding[]
}
```

**修改 `Capability`**：

```typescript
export type Capability =
  | 'exec.stream'
  | 'terminal'
  | 'sleep'
  | 'volumes'
  | 'snapshot'
  | 'port.expose'
  | 'services'          // 新增
```

**修改 `SandboxAdapter`**：

```typescript
export interface SandboxAdapter {
  // ... 现有字段不变 ...

  // Service 操作（可选）
  createService?(config: ServiceConfig): Promise<ServiceInfo>
  getService?(id: string): Promise<ServiceInfo>
  listServices?(): Promise<ServiceInfo[]>
  destroyService?(id: string): Promise<void>
}
```

### 1.2 能力检测

**文件**：`packages/core/src/capabilities.ts`

新增：

```typescript
/** 向下转型为支持服务管理的 Provider，不支持则返回 null */
export function withServices(provider: SandboxProvider): ServiceProvider | null {
  if ('createService' in provider && typeof provider.createService === 'function') {
    return provider as ServiceProvider
  }
  return null
}
```

### 1.3 Provider 工厂扩展

**文件**：`packages/core/src/provider.ts`

在 `createProvider` 中增加 service 相关逻辑：

1. **能力检测**：在 `detectCapabilities` 中处理 `'services'` 能力（类似 volumes 的模式）
2. **Service 方法转发**：如果 adapter 实现了 service 方法，扩展 provider 为 ServiceProvider
3. **环境变量注入**：在 `create()` 方法中，如果 `config.services` 非空，解析 service 凭证并合并到 `config.env`

环境变量注入逻辑：

```typescript
async create(config: CreateConfig): Promise<Sandbox> {
  // 如果绑定了 services，解析凭证注入 env
  if (config.services?.length && adapter.getService) {
    const mergedEnv = { ...config.env }
    for (const binding of config.services) {
      const svc = await adapter.getService(binding.id)
      if (svc.state !== 'ready') {
        throw new ProviderError(`Service ${binding.id} is not ready (state: ${svc.state})`)
      }
      for (const [key, value] of Object.entries(svc.credentials.env)) {
        const envKey = binding.envPrefix ? `${binding.envPrefix}_${key}` : key
        mergedEnv[envKey] = value
      }
    }
    config = { ...config, env: mergedEnv }
  }

  const raw = await adapter.createSandbox(config)
  // ... 后续逻辑不变 ...
}
```

### 1.4 导出

**文件**：`packages/core/src/index.ts`

新增导出：

```typescript
export type {
  ServiceType,
  ServiceConfig,
  ServiceCredentials,
  ServiceInfo,
  ServiceProvider,
  ServiceBinding,
} from './types.js'

export { withServices } from './capabilities.js'
```

### 1.5 Checklist

- [ ] `types.ts` — 添加 ServiceType, ServiceConfig, ServiceCredentials, ServiceInfo, ServiceProvider, ServiceBinding
- [ ] `types.ts` — 修改 CreateConfig 增加 services 字段
- [ ] `types.ts` — 修改 Capability 增加 'services'
- [ ] `types.ts` — 修改 SandboxAdapter 增加可选 service 方法
- [ ] `capabilities.ts` — 添加 withServices()
- [ ] `provider.ts` — detectCapabilities 处理 'services'
- [ ] `provider.ts` — createProvider 转发 service 方法
- [ ] `provider.ts` — create() 中实现 service 环境变量注入
- [ ] `index.ts` — 导出新类型和 withServices
- [ ] 单元测试 — service 环境变量注入逻辑
- [ ] 单元测试 — withServices 能力检测
- [ ] typecheck 通过

---

## Phase 2：@sandbank.dev/db9 包

> 目标：实现 db9.ai 的 ServiceProvider 适配器，包括 skill 注入支持。

### 2.1 包结构

```
packages/db9/
├── package.json
├── tsconfig.json
├── src/
│   ├── index.ts           # 导出
│   ├── adapter.ts         # Db9ServiceAdapter 实现
│   ├── client.ts          # db9 REST API 客户端
│   ├── skill.ts           # db9 skill 获取与缓存
│   └── types.ts           # db9 特有类型（内部）
└── test/
    ├── client.test.ts     # API 客户端单元测试
    ├── adapter.test.ts    # Adapter 单元测试
    └── integration.test.ts # 集成测试（需 db9 token）
```

### 2.2 REST API 客户端

**文件**：`packages/db9/src/client.ts`

封装 db9 REST API，只实现需要的端点：

```typescript
export interface Db9ClientConfig {
  /** db9 API Token */
  token: string
  /** API Base URL，默认 https://db9.ai/api */
  baseUrl?: string
}

export class Db9Client {
  constructor(private config: Db9ClientConfig) {}

  /** 创建数据库 */
  async createDatabase(name: string): Promise<Db9Database>

  /** 获取数据库详情 */
  async getDatabase(id: string): Promise<Db9Database>

  /** 列出所有数据库 */
  async listDatabases(): Promise<Db9Database[]>

  /** 删除数据库 */
  async deleteDatabase(id: string): Promise<void>

  /** 执行 SQL */
  async executeSQL(dbId: string, query: string): Promise<Db9SqlResult>

  /** 创建分支 */
  async createBranch(dbId: string, name: string): Promise<Db9Database>

  /** 列出分支 */
  async listBranches(dbId: string): Promise<Db9Database[]>

  /** 删除分支 */
  async deleteBranch(branchDbId: string): Promise<void>
}
```

使用原生 `fetch`，不引入额外 HTTP 库。

### 2.3 Adapter 实现

**文件**：`packages/db9/src/adapter.ts`

```typescript
export interface Db9AdapterConfig {
  /** db9 API Token */
  token: string
  /** API Base URL */
  baseUrl?: string
  /** 是否自动注入 db9 官方 skill。默认 true */
  injectSkill?: boolean
  /** 自定义 skill 内容（覆盖默认获取） */
  skillContent?: string
}

export class Db9ServiceAdapter {
  readonly name = 'db9'

  constructor(private config: Db9AdapterConfig) {}

  async createService(config: ServiceConfig): Promise<ServiceInfo> {
    // 1. 调用 db9 API 创建数据库
    // 2. 获取连接串
    // 3. 构建 ServiceInfo，包括 credentials.env:
    //    - DATABASE_URL: pgwire 连接串
    //    - DB9_DATABASE_ID: 数据库 ID
    //    - DB9_DATABASE_NAME: 数据库名称
    //    - PGHOST, PGPORT, PGUSER, PGPASSWORD, PGDATABASE（分解的连接参数）
  }

  async getService(id: string): Promise<ServiceInfo>
  async listServices(): Promise<ServiceInfo[]>
  async destroyService(id: string): Promise<void>

  // --- db9 特有能力（不属于 ServiceProvider 接口）---

  /** 创建数据库分支 */
  async branchService(serviceId: string, name: string): Promise<ServiceInfo>

  /** 列出分支 */
  async listBranches(serviceId: string): Promise<ServiceInfo[]>

  /** 删除分支 */
  async deleteBranch(branchId: string): Promise<void>

  /** 获取 db9 官方 skill 内容（带 24h 缓存） */
  async getSkill(): Promise<SkillDefinition>
}
```

### 2.4 Skill 获取与缓存

**文件**：`packages/db9/src/skill.ts`

```typescript
const SKILL_URL = 'https://db9.ai/skill.md'
const CACHE_TTL = 24 * 60 * 60 * 1000 // 24 hours

let cachedSkill: { content: string; fetchedAt: number } | null = null

/** 获取 db9 官方 skill，带内存缓存 */
export async function fetchDb9Skill(): Promise<string> {
  if (cachedSkill && Date.now() - cachedSkill.fetchedAt < CACHE_TTL) {
    return cachedSkill.content
  }
  const resp = await fetch(SKILL_URL)
  if (!resp.ok) throw new Error(`Failed to fetch db9 skill: ${resp.status}`)
  const content = await resp.text()
  cachedSkill = { content, fetchedAt: Date.now() }
  return content
}

/** 构建注入用的 SkillDefinition */
export function db9SkillDefinition(content: string): SkillDefinition {
  return { name: 'db9-postgres', content }
}
```

### 2.5 与 SandboxProvider 的组合使用

db9 adapter 不是 SandboxProvider，它是独立的 ServiceProvider。用户需要组合使用：

```typescript
import { createProvider } from '@sandbank.dev/core'
import { DaytonaAdapter } from '@sandbank.dev/daytona'
import { Db9ServiceAdapter } from '@sandbank.dev/db9'

// 计算层
const sandboxProvider = createProvider(new DaytonaAdapter({ ... }))

// 数据层
const db9 = new Db9ServiceAdapter({ token: process.env.DB9_TOKEN! })

// 创建数据库
const db = await db9.createService({ type: 'postgres', name: 'my-app' })

// 获取 skill
const skill = await db9.getSkill()

// 创建 sandbox 并绑定
const sandbox = await sandboxProvider.create({
  image: 'node:22-slim',
  env: { ...db.credentials.env },  // 手动注入凭证
  skills: [skill],                  // 注入 db9 skill
})
```

**或者**，如果使用了 Phase 1 的 service 绑定机制（需要 composite provider）：

```typescript
// 未来：CompositeProvider 自动处理
const provider = createCompositeProvider({
  compute: new DaytonaAdapter({ ... }),
  services: { db9: new Db9ServiceAdapter({ token: '...' }) },
})

const db = await withServices(provider)!.createService({ type: 'postgres', name: 'my-app' })
const sandbox = await provider.create({
  image: 'node:22-slim',
  services: [{ id: db.id }],  // 自动注入环境变量
  skills: [await provider.services.db9.getSkill()],
})
```

### 2.6 package.json

```json
{
  "name": "@sandbank.dev/db9",
  "version": "0.1.0",
  "description": "db9.ai service adapter for Sandbank — serverless PostgreSQL for AI agents",
  "license": "MIT",
  "type": "module",
  "homepage": "https://sandbank.dev",
  "repository": {
    "type": "git",
    "url": "https://github.com/chekusu/sandbank.git",
    "directory": "packages/db9"
  },
  "keywords": ["sandbox", "ai-agent", "db9", "postgres", "database", "service"],
  "exports": {
    ".": {
      "types": "./dist/index.d.ts",
      "import": "./dist/index.js"
    }
  },
  "files": ["dist"],
  "scripts": {
    "build": "tsc",
    "typecheck": "tsc --noEmit",
    "clean": "rm -rf dist",
    "test": "vitest run",
    "test:e2e": "vitest run --config vitest.e2e.config.ts"
  },
  "dependencies": {
    "@sandbank.dev/core": "workspace:*"
  },
  "devDependencies": {
    "typescript": "^5.7.3",
    "vitest": "^3.0.0"
  }
}
```

### 2.7 Checklist

- [ ] 创建 `packages/db9/` 目录结构
- [ ] `package.json` + `tsconfig.json`
- [ ] `client.ts` — db9 REST API 客户端（fetch 实现）
- [ ] `client.test.ts` — 客户端单元测试（mock fetch）
- [ ] `adapter.ts` — Db9ServiceAdapter
- [ ] `adapter.test.ts` — Adapter 单元测试
- [ ] `skill.ts` — skill 获取与缓存
- [ ] `types.ts` — db9 内部类型（API 响应等）
- [ ] `index.ts` — 导出
- [ ] typecheck 通过
- [ ] 集成测试（需 DB9_TOKEN 环境变量）
  - [ ] 创建数据库
  - [ ] 获取数据库详情
  - [ ] 执行 SQL
  - [ ] 创建/列出/删除分支
  - [ ] 删除数据库
  - [ ] Skill 获取

---

## Phase 3：增值能力

> 目标：在基础集成之上，提供更高层次的多 Agent 协作和数据操作能力。

### 3.1 Brain Schema 初始化

提供预定义的多 Agent 共享记忆 schema，一键初始化：

**文件**：`packages/db9/src/brain.ts`

```typescript
export const BRAIN_SCHEMA = `
-- 共享记忆
CREATE TABLE IF NOT EXISTS memory (
  id serial PRIMARY KEY,
  agent text NOT NULL,
  scope text NOT NULL DEFAULT 'global',
  kind text NOT NULL CHECK (kind IN ('fact','decision','question','blocker')),
  content text NOT NULL,
  embedding vector(1536),
  created_at timestamptz DEFAULT now(),
  superseded_by int REFERENCES memory(id)
);
CREATE INDEX IF NOT EXISTS idx_memory_scope ON memory (scope, kind);
CREATE INDEX IF NOT EXISTS idx_memory_embedding ON memory USING hnsw (embedding vector_cosine_ops);

-- 任务协调
CREATE TABLE IF NOT EXISTS tasks (
  id serial PRIMARY KEY,
  title text NOT NULL,
  status text DEFAULT 'pending' CHECK (status IN ('pending','claimed','done','failed')),
  claimed_by text,
  claimed_at timestamptz,
  depends_on int[] DEFAULT '{}',
  result jsonb,
  created_at timestamptz DEFAULT now()
);
CREATE INDEX IF NOT EXISTS idx_tasks_status ON tasks (status);

-- 产出物注册
CREATE TABLE IF NOT EXISTS artifacts (
  id serial PRIMARY KEY,
  task_id int REFERENCES tasks(id),
  agent text NOT NULL,
  kind text NOT NULL,
  path text,
  content text,
  metadata jsonb,
  created_at timestamptz DEFAULT now()
);
`;

/** 初始化 brain schema */
export async function initBrainSchema(client: Db9Client, dbId: string): Promise<void> {
  await client.executeSQL(dbId, 'CREATE EXTENSION IF NOT EXISTS vector')
  await client.executeSQL(dbId, BRAIN_SCHEMA)
}
```

### 3.2 Brain Skill

为多 Agent 场景提供专用的 brain skill，教 Agent 如何读写共享记忆：

**文件**：`packages/db9/src/brain-skill.ts`

```typescript
export const BRAIN_SKILL = `# brain — 共享记忆系统

你正在一个多 Agent 协作环境中工作。你有一个共享数据库用于记忆和任务协调。

## 环境变量
- \$DATABASE_URL — PostgreSQL 连接串

## 写入记忆
在发现重要信息时，写入 memory 表：
\`\`\`sql
INSERT INTO memory (agent, scope, kind, content)
VALUES ('你的角色', 'task:当前任务ID', 'fact|decision|question|blocker', '内容');
\`\`\`

## 查询记忆
开始工作前，先查看其他 Agent 的发现：
\`\`\`sql
SELECT agent, kind, content FROM memory
WHERE scope = 'task:当前任务ID' AND superseded_by IS NULL
ORDER BY created_at;
\`\`\`

## 认领任务
\`\`\`sql
UPDATE tasks SET status = 'claimed', claimed_by = '你的角色', claimed_at = now()
WHERE id = (
  SELECT id FROM tasks
  WHERE status = 'pending'
    AND NOT EXISTS (
      SELECT 1 FROM unnest(depends_on) dep JOIN tasks t ON t.id = dep WHERE t.status != 'done'
    )
  ORDER BY created_at FOR UPDATE SKIP LOCKED LIMIT 1
) RETURNING *;
\`\`\`

## 完成任务
\`\`\`sql
UPDATE tasks SET status = 'done', result = '{"summary":"..."}' WHERE id = 当前任务ID;
\`\`\`

## 注册产出物
\`\`\`sql
INSERT INTO artifacts (task_id, agent, kind, path, content)
VALUES (当前任务ID, '你的角色', 'code|analysis|config', '/path/to/file', '内容摘要');
\`\`\`
`

export function brainSkillDefinition(): SkillDefinition {
  return { name: 'brain', content: BRAIN_SKILL }
}
```

### 3.3 便捷工厂函数

**文件**：`packages/db9/src/index.ts`

```typescript
/** 一键创建数据库 + 获取 skill 的便捷函数 */
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
  await initBrainSchema(adapter.client, service.id)
  return {
    service,
    skills: [skill, brainSkillDefinition()],
    adapter,
  }
}
```

### 3.4 Checklist

- [ ] `brain.ts` — Brain schema SQL + initBrainSchema()
- [ ] `brain-skill.ts` — Brain skill 模板
- [ ] `index.ts` — createDb9Service / createDb9Brain 便捷函数
- [ ] 集成测试 — brain schema 初始化
- [ ] 集成测试 — 多 sandbox 共享数据库读写

---

## 文件变更总览

### 修改的文件

| 文件 | 变更 |
|------|------|
| `packages/core/src/types.ts` | 新增 Service 相关类型，修改 CreateConfig 和 Capability |
| `packages/core/src/capabilities.ts` | 新增 withServices() |
| `packages/core/src/provider.ts` | 支持 services 能力检测和环境变量注入 |
| `packages/core/src/index.ts` | 导出新类型 |
| `docs/TODO.md` | 添加 db9 集成项 |

### 新增的文件

| 文件 | 说明 |
|------|------|
| `packages/db9/package.json` | 包配置 |
| `packages/db9/tsconfig.json` | TypeScript 配置 |
| `packages/db9/src/index.ts` | 导出 + 便捷函数 |
| `packages/db9/src/adapter.ts` | Db9ServiceAdapter |
| `packages/db9/src/client.ts` | REST API 客户端 |
| `packages/db9/src/skill.ts` | Skill 获取与缓存 |
| `packages/db9/src/types.ts` | 内部类型定义 |
| `packages/db9/src/brain.ts` | Brain schema |
| `packages/db9/src/brain-skill.ts` | Brain skill 模板 |
| `packages/db9/test/client.test.ts` | 客户端测试 |
| `packages/db9/test/adapter.test.ts` | Adapter 测试 |
| `packages/db9/test/integration.test.ts` | 集成测试 |

---

## 实现顺序

```
Phase 1（Core 接口）→ Phase 2（db9 包）→ Phase 3（增值能力）
     ↓                    ↓                    ↓
  ~2h 工作量           ~3h 工作量           ~2h 工作量
```

Phase 1 完成后即可 typecheck。Phase 2 需要 db9 API token 进行集成测试。Phase 3 可以渐进式实现。

---

## 已决策的问题

> 2026-03-09 批准

1. **CompositeProvider 设计** → **独立组合（方案 A）**。先保持 db9 作为独立 adapter，用户手动组合 compute + service。不做 CompositeProvider，避免过早抽象。
2. **Skill 更新策略** → **内存缓存（方案 A）**。进程内 24h TTL，sandbox 通常是短生命周期，足够。
3. **连接池** → **不管（方案 A）**。每个 sandbox 内自行管理连接池，db9 是 serverless 架构，服务端负责连接管理。Sandbank 不越界。
4. **db9 定价** → **照常推进（方案 A）**。ServiceProvider 接口是通用的，db9 只是第一个实现。即使 db9 不合适，接口层的工作不浪费。
