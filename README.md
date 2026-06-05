# Sandbank

> AI Agent 统一 Workspace Agent Harness — 一个 Workspace，多种后端沙盒。

Sandbank 是面向 AI Agent 的统一 workspace harness。它把 Agent 身份、memory、artifact、audit log、文件和 checkpoint 固化在 `Workspace` 协议里，再把具体执行任务调度到 Dynamic Worker、E2B、BoxLite、Fly.io、Daytona、Cloudflare Workers 等后端沙盒。底层 provider SDK 仍然可单独使用，但 Sandbank 的顶层抽象已经从“统一沙箱接口”升级为“跨后端同步 Workspace 的 Agent Harness”。

**[官网](https://sandbank.dev)** | **[English](./README.en.md)** | **[日本語](./README.ja.md)**

<img src="./docs/assets/sandbank-robots-vacation-pixel.png" alt="像素画风格的一群小机器人 Agent 在海中沙滩上度假，每个机器人都有不同的开发者角色" width="100%" />

## 为什么选择 Sandbank?

AI Agent 需要的不只是一个隔离沙箱。它需要一个可恢复、可审计、可跨运行时迁移的长期 Workspace，同时还要能按任务选择合适的计算后端：短 JS code mode 可以跑在 Cloudflare Dynamic Worker，Python 可以派发到 E2B 或 BoxLite，长任务可以落到 VM/container，最终输出再同步回同一个 Workspace。

底层沙箱 provider SDK 仍然可用，用来屏蔽 Daytona、Fly.io、Cloudflare Workers 等不同 API：

```typescript
import { createProvider } from '@sandbank.dev/core'
import { DaytonaAdapter } from '@sandbank.dev/daytona'

const provider = createProvider(new DaytonaAdapter({ apiKey: '...' }))
const sandbox = await provider.create({ image: 'node:22' })

const result = await sandbox.exec('echo "Hello from the sandbox"')
console.log(result.stdout) // Hello from the sandbox

await provider.destroy(sandbox.id)
```

把 `DaytonaAdapter` 换成 `FlyioAdapter` 或 `CloudflareAdapter`，沙箱创建/执行代码无需重写。更高一层的 harness 会把这些 provider 当作计算后端，而不是 Agent 的长期家。

## 架构

```
┌──────────────────────────────────────────────────────┐
│  你的应用 / AI Agent / 第三方调用方                    │
├──────────────────────────────────────────────────────┤
│  sandbank                   Workspace Agent Harness      │
│  AgentSupervisor            policy / memory / tool use   │
│  Provider Scheduler         多后端计算调度与同步          │
│  @sandbank.dev/workspace    持久 Workspace 与 Checkpoint  │
├──────────────────────────────────────────────────────┤
│  @sandbank.dev/core         底层 Provider SDK             │
│  @sandbank.dev/skills       Skill 注册表与注入            │
│  @sandbank.dev/agent        沙箱内 Agent 客户端           │
│  @sandbank.dev/relay        多 Agent 通信中枢             │
├──────────────────────────────────────────────────────┤
│  @sandbank.dev/daytona  @sandbank.dev/flyio  @sandbank.dev/cloudflare  │
│  @sandbank.dev/boxlite  @sandbank.dev/e2b                 │
│  Provider 适配器（计算）                               │
├──────────────────────────────────────────────────────┤
│  @sandbank.dev/db9       Service Adapter（数据）       │
├──────────────────────────────────────────────────────┤
│  Daytona    Fly.io Machines    Cloudflare Workers     │
│  BoxLite (自托管 Docker)    E2B Cloud Sandboxes        │
│  db9.ai (PostgreSQL)                                  │
└──────────────────────────────────────────────────────┘
```

## 包一览

| 包名 | 说明 |
|------|------|
| [`sandbank`](./packages/sandbank) | Workspace Agent Harness、Agent Supervisor、Tool Use、provider scheduler、CLI/Worker entrypoints |
| [`@sandbank.dev/core`](./packages/core) | 底层 Provider SDK、能力系统、错误类型 |
| [`@sandbank.dev/skills`](./packages/skills) | Skill 注册表、本地文件系统加载器 |
| [`@sandbank.dev/workspace`](./packages/workspace) | 持久 Workspace 协议、checkpoint、沙箱 materialize/sync helper |
| [`@sandbank.dev/daytona`](./packages/daytona) | Daytona 云沙箱适配器 |
| [`@sandbank.dev/flyio`](./packages/flyio) | Fly.io Machines 适配器 |
| [`@sandbank.dev/cloudflare`](./packages/cloudflare) | Cloudflare Workers 适配器 |
| [`@sandbank.dev/boxlite`](./packages/boxlite) | BoxLite 自托管 Docker 适配器 |
| [`@sandbank.dev/e2b`](./packages/e2b) | E2B 云沙箱适配器 |
| [`@sandbank.dev/db9`](./packages/db9) | db9.ai serverless PostgreSQL 适配器 (`ServiceProvider`) |
| [`@sandbank.dev/relay`](./packages/relay) | WebSocket 中继，用于多 Agent 通信 |
| [`@sandbank.dev/agent`](./packages/agent) | 沙箱内 Agent 轻量客户端 |

## Provider 支持情况

### 基础操作

所有 Provider 都必须实现的最小契约：

| 操作 | Daytona | Fly.io | Cloudflare | BoxLite | E2B |
|------|:-------:|:------:|:----------:|:-------:|:---:|
| 创建 / 销毁 | ✅ | ✅ | ✅ | ✅ | ✅ |
| 列出沙箱 | ✅ | ✅ | ✅ | ✅ | ✅ |
| 执行命令 | ✅ | ✅ | ✅ | ✅ | ✅ |
| 读写文件 | ✅ | ✅ | ✅ | ✅ | ✅ |
| Skill 注入 | ✅ | ✅ | ✅ | ✅ | ✅ |

### 扩展能力

能力是可选的。通过 `withVolumes(provider)`、`withPortExpose(sandbox)` 等函数在运行时安全检测并访问。

| 能力 | Daytona | Fly.io | Cloudflare | BoxLite | E2B | db9 | 说明 |
|------|:-------:|:------:|:----------:|:-------:|:---:|:---:|------|
| `volumes` | ✅ | ✅ | ⚠️* | ❌ | ⚠️*** | — | 持久卷管理 |
| `port.expose` | ✅ | ✅ | ⚠️** | ✅ | ✅ | — | 将沙箱端口暴露到公网 |
| `exec.stream` | ❌ | ❌ | ✅ | ✅ | ❌ | — | 实时流式输出 stdout/stderr |
| `snapshot` | ❌ | ❌ | ✅ | ✅ | ❌ | — | 沙箱状态快照与恢复 |
| `terminal` | ✅ | ✅ | ✅ | ✅ | ✅ | — | 交互式 Web 终端 (ttyd) |
| `sleep` | ❌ | ❌ | ❌ | ✅ | ✅ | — | 休眠与唤醒 |
| `skills` | ✅ | ✅ | ✅ | ✅ | ✅ | — | 加载并注入 Skill 定义到沙箱 |
| `services` | ❌ | ❌ | ❌ | ❌ | ❌ | ✅ | 将数据服务 (PostgreSQL) 绑定到沙箱 |

\* Cloudflare 的 `volumes` 需要在适配器配置中启用 `storage` 选项。

\*\* Cloudflare 保留了 3000 端口用于沙箱控制面板，可用范围为 1024–65535（不含 3000）。

\*\*\* E2B volumes 目前需要 E2B volume beta 权限。Sandbank 会用卷 `id` 连接 E2B `Volume` 后挂载。

### Provider 特性对比

| | Daytona | Fly.io | Cloudflare | BoxLite | E2B |
|---|---------|--------|------------|---------|-----|
| **运行时** | 完整 VM | Firecracker 微虚拟机 | V8 隔离 + 容器 | Docker 容器 | E2B 云沙箱 |
| **冷启动** | ~10s | ~3-5s | ~1s | ~2-5s | Provider 管理 |
| **文件 I/O** | 原生 SDK | 通过 exec (base64) | 原生 SDK | 通过 exec (base64) | 原生 SDK |
| **区域** | 多区域 | 多区域 | 全球边缘 | 自托管 | E2B 管理 |
| **外部依赖** | `@daytonaio/sdk` | 无 (纯 fetch) | `@cloudflare/sandbox` | BoxLite API | `e2b` |

## 多 Agent 会话

Sandbank 内置编排层，支持多 Agent 实时协作。**Relay** 负责沙箱间的消息传递和共享上下文。

```typescript
import { createSession } from '@sandbank.dev/core'

const session = await createSession({
  provider,
  relay: { type: 'memory' },
})

// 在隔离沙箱中启动 Agent
const architect = await session.spawn('architect', {
  image: 'node:22',
  env: { ROLE: 'architect' },
})

const developer = await session.spawn('developer', {
  image: 'node:22',
  env: { ROLE: 'developer' },
})

// 共享上下文 — 所有 Agent 均可读写
await session.context.set('spec', { endpoints: ['/users', '/posts'] })

// 等待所有 Agent 完成
await session.waitForAll()
await session.close()
```

在沙箱内部，Agent 使用 `@sandbank.dev/agent`：

```typescript
import { connect } from '@sandbank.dev/agent'

const session = await connect() // 自动读取 SANDBANK_* 环境变量

session.on('message', async (msg) => {
  if (msg.type === 'task') {
    // 执行任务...
    await session.send(msg.from, 'done', result)
  }
})

await session.complete({ status: 'success', summary: '完成了 5 个 API 端点' })
```

## Workspace Agent Harness

Sandbank 的 harness 以 `WorkspaceAdapter` 为 Agent 的权威状态边界。一次 agent run 可以先让模型规划，再用 Dynamic Worker 执行受限 JS code mode，把生成的 Python 写入 Workspace，随后由 provider scheduler 选择 E2B、BoxLite、Daytona、Fly.io 或其他声明 `runtime.python` 的后端执行，最后把产物、日志和 memory 写回 Workspace。

这种结构让调用方可以替换计算后端，而不用把 Agent 的长期状态绑在某个 VM、container、volume 或 Workers storage binding 上。权限边界也在 harness 层统一处理：Tool Use 请求先经过 Agent policy/resource grants/approval rules，再调用宿主注册的工具或调度 sandbox provider。

## Provider-Neutral Workspaces（跨 Provider Workspace）

Provider 原生 volume 都是 provider-specific 资源。Fly.io volume、E2B volume、Daytona volume、Cloudflare storage binding 并不是同一块持久磁盘。要在不同 sandbox provider 之间切换并保持状态连续，需要把权威状态放在 `WorkspaceAdapter` 里：运行前 materialize 到沙箱，运行后把变更 sync 回 Workspace，并在后端支持时创建 checkpoint。

```typescript
import {
  MemoryWorkspaceAdapter,
  materializeWorkspaceToSandbox,
  syncWorkspaceFromSandbox,
} from '@sandbank.dev/workspace'

const workspace = new MemoryWorkspaceAdapter()
await workspace.write('/workspace/task.md', 'ship it')

const sandbox = await provider.create({ image: 'node:22' })
await materializeWorkspaceToSandbox(workspace, sandbox, {
  workspacePath: '/workspace',
  sandboxPath: '/workspace',
})

await sandbox.exec('echo done > /workspace/result.txt')

await syncWorkspaceFromSandbox(workspace, sandbox, {
  workspacePath: '/workspace',
  sandboxPath: '/workspace',
  deleteMissing: true,
  checkpointLabel: 'after provider run',
})
```

Provider-native volumes 适合作为本地 cache 或 provider 内部持久化；跨 provider rollback、checkpoint、连续运行和一致性合并应以 Workspace 为准。

## Provider Scheduler 与 Preflight

顶层 `sandbank` 包导出 `selectSandboxProvider`、`preflightWorkspaceSandboxTask` 和 `runWorkspaceSandboxTask`。调度器把 sandbox provider 当作计算候选，根据 `runtime.python`、`runtime.codex`、`codex.exec`、`codex.goal`、`workspace.snapshot`、`workspace.live` 等声明能力选择 provider。

```typescript
import {
  preflightWorkspaceSandboxTask,
  runWorkspaceSandboxTask,
} from 'sandbank'

const taskConfig = {
  workspace,
  providers: [
    { provider: e2bProvider, capabilities: ['runtime.python'], priority: 10 },
    { provider: boxliteProvider, capabilities: ['runtime.python'] },
  ],
  task: { kind: 'python' as const, path: '/workspace/generated/task.py', image: 'python-agent' },
  imageCatalog: {
    'python-agent': {
      default: 'python:3.12',
      e2b: 'e2b-python-template',
      boxlite: 'python:3.12-slim',
    },
  },
  preflight: { runtime: true },
}

const preflight = await preflightWorkspaceSandboxTask(taskConfig)
if (!preflight.ok) throw new Error(preflight.errors.join('; '))

await runWorkspaceSandboxTask({
  ...taskConfig,
  consistency: { mode: 'branch-merge', conflictResolution: 'keep-both' },
  preflight: false,
})
```

Static preflight 会在执行前检查 Workspace 和 provider 能力；runtime preflight 会创建临时 sandbox 探测镜像工具，例如 `python`、`codex`、`git`、`tmux`、`tar`、`gzip`。`codex.goal` 会启动 vas 风格的 `tmux` 会话并保留沙箱，方便终端 attach 和后续 Workspace sync。更多细节见 [Provider Scheduler And Workspace Consistency](./docs/provider-scheduler-workspace.md) 和 [Sandbank Agent Configuration](./docs/sandbank-agent-configuration.zh-CN.md)。

## Agent Tool Use

Sandbank Tool Use 是比单一模型 adapter 更底层的协议。模型循环、Dynamic Worker capsule 或托管 Agent 都提交结构化的 `tool.use` 请求；Agent Supervisor 会先检查该 Agent 的 tool/resource policy，然后才调用 handler 或 sandbox provider。

```typescript
import {
  AgentSupervisor,
  ToolUseRegistry,
  createCloudflareResourceTool,
  createSearchCodeRunTool,
  createSandboxPythonTool,
} from 'sandbank'

const registry = new ToolUseRegistry()
  .register(createCloudflareResourceTool('read', async input => {
    // 这里可以连接 Cloudflare D1/KV/R2 等 bindings 或 API。
    return { ok: true, resource: input.resource }
  }))
  .register(createSearchCodeRunTool({
    search: {
      provider: 'perplexity',
      search: async query => searchProvider.search(query),
      fetchJson: async url => searchProvider.fetchJson(url),
    },
  }))
  .register(createSandboxPythonTool())

const supervisor = new AgentSupervisor({
  agentId: 'agent-a',
  workspace,
  modelId: 'deepseek-v4-pro',
  toolUse: {
    registry,
    dynamicWorker,
    sandboxProviders: [
      { provider: e2bProvider, capabilities: ['runtime.python'] },
      { provider: boxliteProvider, capabilities: ['runtime.python'] },
    ],
    policy: {
      allowedTools: ['cloudflare.resource.read', 'search.code.run', 'sandbox.python'],
      resources: [
        { kind: 'cloudflare.d1', id: 'analytics', actions: ['read'] },
        { kind: 'dynamic_worker.execution', actions: ['execute'] },
        { kind: 'runtime.javascript', actions: ['execute'] },
        { kind: 'external.search', id: 'perplexity', actions: ['query'] },
        { kind: 'http.egress', id: 'api.example.com', actions: ['fetch'] },
        { kind: 'workspace.path', scope: '/runs', actions: ['write'] },
        { kind: 'sandbox.provider', id: 'e2b', actions: ['execute'] },
        { kind: 'runtime.python', actions: ['execute'] },
      ],
      requireApproval: [
        { kind: 'cloudflare.d1', action: 'write' },
      ],
    },
  },
})
```

Tool 注册目前由第三方宿主代码完成：调用方在初始化 harness/supervisor 时创建 `ToolUseRegistry`，通过 `.register(...)` 注入工具定义，再用每个 agent/run 的 policy 启用白名单。当前没有开放“远程任意用户注册 tool”的管理端点。

`resources` 是 Agent 启用时的计算和数据资源白名单。即使 prompt 要求 Agent 修改用户数据库，请求也必须匹配允许的 resource/action，并满足对应的 approval rule。`search.code.run` 是 code mode：模型可以生成 JavaScript 函数体，由 Dynamic Worker 执行，并只能通过 `ctx.search`、`ctx.workspace`、`ctx.runtime` 这些受控 binding 访问能力；裸网络访问仍要匹配 `http.egress` grant。`sandbox.python` 会走 provider scheduler，因此 Dynamic Worker 生成的 Python 可以派发到 E2B、BoxLite、Sandbank Cloud 或任何声明 `runtime.python` 的 provider。Dynamic Worker capsule 通过 `SANDBANK_TOOLS.list()` 和 `SANDBANK_TOOLS.use(request)` 走同一条 supervisor policy，不会绕过权限控制。

## 快速开始

```bash
# 安装
pnpm add @sandbank.dev/core @sandbank.dev/daytona  # 或 @sandbank.dev/flyio、@sandbank.dev/cloudflare、@sandbank.dev/e2b

# 配置 Provider
export DAYTONA_API_KEY=your-key
```

```typescript
import { createProvider } from '@sandbank.dev/core'
import { DaytonaAdapter } from '@sandbank.dev/daytona'

const provider = createProvider(
  new DaytonaAdapter({ apiKey: process.env.DAYTONA_API_KEY! })
)

// 创建沙箱
const sandbox = await provider.create({
  image: 'node:22',
  resources: { cpu: 2, memory: 2048 },
  autoDestroyMinutes: 30,
})

// 执行命令
const { stdout } = await sandbox.exec('node --version')

// 文件操作
await sandbox.writeFile('/app/index.js', 'console.log("hi")')
await sandbox.exec('node /app/index.js')

// 清理
await provider.destroy(sandbox.id)
```

## 开发

```bash
git clone https://github.com/chekusu/sandbank.git
cd sandbank
pnpm install

# 运行全部单元测试
pnpm test

# 运行跨 Provider 一致性测试
pnpm test:conformance

# 类型检查
pnpm typecheck
```

### DB-native Harness API

`sandbank` CLI 和 Worker entrypoint 暴露了公开的 Sandbank harness API，底层由 Agent Supervisor、db9 Workspace storage 和 DeepSeek V4 Pro 驱动：

```bash
DB9_DATABASE_ID=... DB9_TOKEN=... DEEPSEEK_API_KEY=... \
  vas dev sandbank-harness pnpm --filter ./packages/sandbank exec tsx src/cli/index.ts harness-api --host 0.0.0.0 --port 8789
```

Routes:

- `GET /health`
- `GET /api/db-native-agent-harness/capabilities`
- `POST /api/sandbank-agent-harness/stream`
- `POST /api/db-native-agent-harness/stream`

stream 会发送通用 Sandbank SSE events，把 run input/output 持久化到 `/runs/...`，把 supervisor state/audit data 写入 `/agents/...`，并在 Workspace 后端支持时创建 checkpoint。默认模型是 `deepseek-v4-pro`。它还会把 Agent memory 存在 `/agents/{agentId}/memory/memories.jsonl`，将 active `pinned` / `insight` / `session` 记忆注入模型 prompt，并把显式的 `remember` / `记住` 请求写成 pinned memory。Worker-compatible entrypoint 导出为 `sandbank/harness-worker`；Node CLI 用于通过 `vas dev` 或等价部署路径托管服务，不是 localhost-only preview。模型、Workspace、provider 和镜像要求见 [Sandbank Agent Configuration](./docs/sandbank-agent-configuration.zh-CN.md)。

用一个 prompt 对线上 harness 做 benchmark：

```bash
pnpm --filter ./packages/sandbank exec tsx src/cli/index.ts harness-benchmark \
  --base-url https://your-sandbank-worker.example \
  --question "@agent run a Sandbank harness health check" \
  --json
```

运行默认 benchmark suite：

```bash
SANDBANK_HARNESS_BASE_URL=https://your-sandbank-worker.example pnpm bench:harness -- --json
```

benchmark 会把每个 case POST 到 `/api/db-native-agent-harness/stream`，记录 SSE timeline，并按 HTTP/SSE transport、harness lifecycle、Workspace persistence、Dynamic Worker capsule execution、model streaming、case expectations 和 latency 计分，满分 100。

### 运行集成测试

集成测试会调用真实 API，通过环境变量控制开关：

```bash
# Daytona
DAYTONA_API_KEY=... pnpm test

# Fly.io
FLY_API_TOKEN=... FLY_APP_NAME=... pnpm test

# Cloudflare
E2E_WORKER_URL=... pnpm test

# db9
DB9_TOKEN=... pnpm --filter @sandbank.dev/db9 test:e2e
```

## 测试覆盖率

| Package | Stmts | Branch | Funcs | Lines | Unit | Integration |
|---------|:-----:|:------:|:-----:|:-----:|:----:|:-----------:|
| `@sandbank.dev/core` | 84% | 77% | 74% | 88% | 98 | — |
| `@sandbank.dev/db9` | 100% | 97% | 93% | 100% | 35 | 3 |

本地运行 coverage：

```bash
pnpm --filter @sandbank.dev/db9 test -- --coverage
```

## 设计原则

1. **最小接口，最大互操作** — 只做真正的最大公约数 (exec + files + lifecycle)
2. **显式优于隐式** — 不自动 fallback、不缓存、不隐式重试
3. **能力检测，而非假实现** — 不支持就报错，不返回假数据
4. **幂等操作** — 销毁已销毁的沙箱不报错
5. **完全解耦** — Provider 层和 Session 层独立，自由组合

## 许可证

MIT
