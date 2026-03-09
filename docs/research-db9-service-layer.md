# db9.ai 集成调研：Service Layer 设计

> 日期：2026-03-09
> 状态：调研完成，待评审

## 1. 背景

Sandbank 当前的抽象层次是 **Compute（Sandbox）+ Storage（Volume）**。AI Agent 在真实场景中几乎总是需要 Compute + Data，但现有架构缺少对数据服务的一等公民支持。

本文调研 db9.ai 作为第一个 Service Provider 接入 Sandbank 的可行性，并设计 Service Layer 的通用接口。

## 2. db9.ai 概要

db9.ai 是面向 AI Agent 的 Serverless PostgreSQL 平台。

### 核心能力

| 能力 | 详情 |
|------|------|
| PostgreSQL 17.4 | 标准 Postgres，支持 pgwire 直连 |
| pgvector | 向量搜索，HNSW 索引，L2/余弦/内积 |
| fs9 | 云文件系统（TiKV 后端），支持文件即表查询 |
| pg_cron | SQL 内定时任务调度 |
| http 扩展 | SQL 内发 HTTP 请求 |
| 全文搜索 | 支持中文 jieba 分词、ngram |
| 数据库分支 | 秒级 copy-on-write 分支 |
| 类型生成 | 自动生成 TypeScript/Python 类型定义 |

### 接入方式

| 方式 | 延迟 | 场景 |
|------|------|------|
| pgwire 直连 | 最低 | 生产环境，高频操作 |
| REST API | ~0.8s/请求 | 管理操作，控制面 |
| CLI (db9) | — | Agent 在 sandbox 内使用 |
| FUSE 挂载 | 取决于网络 | 文件系统访问（需特殊权限） |

### REST API

Base URL: `https://db9.ai/api/customer`，Bearer Token 认证。

关键端点：
- `POST /databases` — 创建数据库
- `GET /databases` — 列出数据库
- `POST /databases/{id}/sql` — 执行 SQL
- `POST /databases/{id}/branch` — 创建分支
- `DELETE /databases/{id}` — 删除数据库
- `POST /databases/{id}/migrations` — 应用迁移

### 官方 Skill

db9 提供官方 skill 文件：`https://db9.ai/skill.md`，内容涵盖完整的 CLI 参考、SQL 扩展用法、API 示例。可直接注入到 sandbox 中指导 Agent 使用数据库。

### 限制

| 项目 | 限制 |
|------|------|
| 匿名账户 | 最多 5 个数据库 |
| fs9 单文件 | 10 MB |
| fs9 glob 总计 | 100 MB |
| fs9 文件遍历 | 10,000 个文件 |
| HTTP 扩展响应 | 1 MB |
| 产品成熟度 | 较新，定价未公开 |

## 3. 为什么是 Service 而不是 Volume

Volume 的语义是"一块磁盘挂到容器路径"。db9 提供的是完整的数据服务——SQL 查询、事务、向量搜索、定时任务、数据库分支。把这些能力压缩成 `mountPath` 是不合适的。

正确的抽象是在 Sandbank 中引入 **Service 层**：

```
Compute（Sandbox）+ Storage（Volume）+ Services（Database/Cache/...）
```

## 4. Agent 如何使用 Service

### 4.1 环境变量注入

Sandbox 创建时绑定 service，凭证自动注入为环境变量：

```typescript
const db = await svc.createService({ type: 'postgres', name: 'my-db' })
const sandbox = await provider.create({
  image: 'node:22-slim',
  services: [{ id: db.id }],  // DATABASE_URL 自动注入
})
```

### 4.2 Skill 注入

通过 Sandbank 已有的 skill 机制，将 db9 官方 skill 注入到 sandbox，Agent 自动获知数据库的使用方法：

```typescript
const sandbox = await provider.create({
  image: 'node:22-slim',
  services: [{ id: db.id }],
  skills: [
    { name: 'db9-postgres', content: await fetchDb9Skill() },
  ],
})
```

### 4.3 Agent 视角

Agent 不需要知道 db9 的存在。它只知道：
- `$DATABASE_URL` 可用（标准 Postgres 连接串）
- Skill 文件描述了可用的扩展能力（pgvector、fs9 等）
- 可以用任何 Postgres 客户端操作

### 4.4 效率提升：SQL 替代临时脚本

Agent 处理数据时，传统方式是写临时 Python/Node 脚本。有了 Postgres，很多操作可以用 SQL 完成：

| 脚本模式 | SQL 模式 |
|---------|---------|
| 写完整脚本（import, 循环, 异常处理） | 一条 SQL |
| 需要安装依赖 | 无依赖 |
| 中间结果丢失 | 数据留在数据库，可复用 |
| 每次追问重写脚本 | 改 WHERE/GROUP BY |

SQL 适合：聚合、分组、JOIN、窗口函数、向量搜索、文本处理。
仍需脚本：复杂字符串解析、外部 API 调用、可视化、ML 推理。

### 4.5 多 Agent 共享记忆层

多个 sandbox 绑定同一个数据库，天然形成共享记忆层：

```sql
-- 共享记忆表
CREATE TABLE memory (
  id serial PRIMARY KEY,
  agent text NOT NULL,
  scope text NOT NULL,
  kind text NOT NULL,       -- 'fact' | 'decision' | 'question' | 'blocker'
  content text NOT NULL,
  embedding vector(1536),
  created_at timestamptz DEFAULT now(),
  superseded_by int REFERENCES memory(id)
);

-- 任务协调（原子认领，零竞态）
CREATE TABLE tasks (
  id serial PRIMARY KEY,
  title text NOT NULL,
  status text DEFAULT 'pending',
  claimed_by text,
  depends_on int[],
  result jsonb,
  created_at timestamptz DEFAULT now()
);
```

Postgres 的优势：
- **ACID 事务** — 不会脏读
- **LISTEN/NOTIFY** — 实时事件通知，不需要轮询
- **SELECT FOR UPDATE SKIP LOCKED** — 原子任务认领，不需要 Redis
- **pgvector** — 语义搜索记忆，不需要额外向量库

与 Sandbank Relay 互补：Relay 负责调度（控制流），Postgres 负责记忆（数据流）。

## 5. 结论

db9.ai 适合作为 Sandbank Service Layer 的第一个实现：
1. **零配置**：API 创建即用，不需要运维
2. **标准协议**：pgwire 直连，Agent 已有的 Postgres 知识可复用
3. **官方 Skill**：可直接注入，Agent 无学习成本
4. **独特能力**：数据库分支、fs9、pgvector 对 AI Agent 特别有价值
5. **多 Agent 天然支持**：Postgres 的事务和通知机制是最好的协调层
