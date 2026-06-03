# Sandbank Agent 配置

[English](./sandbank-agent-configuration.md) | [中文](./sandbank-agent-configuration.zh-CN.md) | [日本語](./sandbank-agent-configuration.ja.md)

本文说明开发者在运行 Sandbank Agent 前需要配置什么。Sandbank 里有两层相关执行路径：

- DB-native agent harness（`sandbank harness-api`）：调用模型、把运行状态持久化到 Workspace，并可调用受限的 Dynamic Worker capsule。
- provider 调度器（`runWorkspaceSandboxTask`）：把具体计算任务，例如生成的 Python 或 Codex 任务，派发到已配置的 sandbox provider。

## 必须配置

| 区域 | 用于 | 必须配置 |
|------|------|----------|
| 模型 | DB-native harness 的模型调用 | `SANDBANK_DEEPSEEK_API_KEY` 或 `DEEPSEEK_API_KEY` |
| Workspace | 持久化 Agent 状态、运行文件、checkpoint、memory、artifact | `DB9_DATABASE_ID` 和 `DB9_TOKEN`，除非注入了 `createWorkspace` |
| Provider | Dynamic Worker 以外的 sandbox 计算任务 | 至少一个能力匹配任务的 `SandboxProviderCandidate` |
| 镜像/runtime | provider 派发任务 | 包含所需工具链的逻辑镜像映射或直接镜像 |

如果 DB-native harness 只使用模型、Workspace 和 Dynamic Worker binding，则不需要配置 sandbox provider。只有当 Agent 需要在 provider 中运行 Python、Codex 或其他命令时，provider 配置才是必须的。

## 模型配置

harness 当前使用 DeepSeek-compatible chat completions API。

| 配置 | 必须 | 默认值 | 说明 |
|------|:----:|--------|------|
| `SANDBANK_DEEPSEEK_API_KEY` | 二选一 | — | 优先使用的 Sandbank harness 模型 key |
| `DEEPSEEK_API_KEY` | 二选一 | — | fallback 模型 key |
| `OPENAI_API_KEY` | 条件必须 | — | 仅当 `SANDBANK_DEEPSEEK_USE_OPENAI_ENV=1`，或 `OPENAI_BASE_URL` 指向 DeepSeek/OpenRouter/gateway endpoint 时使用 |
| `SANDBANK_DEEPSEEK_MODEL` | 否 | `deepseek-v4-pro` | 优先模型覆盖 |
| `DEEPSEEK_MODEL` | 否 | `deepseek-v4-pro` | fallback 模型覆盖 |
| `SANDBANK_DEEPSEEK_BASE_URL` | 否 | `https://api.deepseek.com` | 优先 compatible API base URL |
| `DEEPSEEK_BASE_URL` | 否 | `https://api.deepseek.com` | fallback compatible API base URL |
| `OPENAI_BASE_URL` | 条件可选 | — | 使用条件与 `OPENAI_API_KEY` 相同 |

请求体里的 `model` 对象会作为 UI metadata 保留；harness 实际调用的后端模型由这些环境变量决定。

## Workspace 配置

Workspace 是持久状态边界。它存储 run input/output、audit log、checkpoint、artifact 和 Agent 状态。provider 本地文件和 provider volume 不是跨 provider 的权威状态。

| 配置 | 必须 | 说明 |
|------|:----:|------|
| `DB9_DATABASE_ID` | 是 | db9 workspace database id |
| `DB9_TOKEN` | 是 | db9 API token |
| `DB9_BASE_URL` | 否 | 覆盖 db9 API base URL |

测试或自定义部署可以通过 harness deps 传入 `createWorkspace`，而不是使用 db9 环境变量。

## Harness 服务配置

```bash
DB9_DATABASE_ID=...
DB9_TOKEN=...
DEEPSEEK_API_KEY=...
DEEPSEEK_MODEL=deepseek-v4-pro \
  sandbank harness-api --host 0.0.0.0 --port 8789
```

| 配置 | 必须 | 默认值 | 说明 |
|------|:----:|--------|------|
| `SANDBANK_HARNESS_HOST` | 否 | `0.0.0.0` | CLI `--host` 会覆盖 |
| `SANDBANK_HARNESS_PORT` | 否 | `8789` | CLI `--port` 会覆盖；也接受 `PORT` |
| `SANDBANK_HARNESS_API_KEY` | 否 | — | 启用 bearer-token 鉴权 |

## Dynamic Worker 配置

Dynamic Worker capsule 是可选的。它运行受限 JavaScript，并收到 scoped `SANDBANK_WORKSPACE` 和 `SANDBANK_RUNTIME` binding。它不是完整 VM、shell、Python runtime 或 Codex runtime。

| 配置 | 必须 | 默认值 | 说明 |
|------|:----:|--------|------|
| `SANDBANK_DYNAMIC_WORKER_TIMEOUT_MS` | 否 | `15000` | capsule timeout |
| `SANDBANK_DYNAMIC_WORKER_CPU_MS` | 否 | provider 默认 | 支持时的 CPU budget |
| `SANDBANK_DYNAMIC_WORKER_SUBREQUESTS` | 否 | provider 默认 | 支持时的 subrequest budget |

## Tool 注册与 Code Mode

Tool 注册由宿主应用控制，不由任意终端用户动态注册。第三方调用方创建 `ToolUseRegistry`，注册 `createCloudflareResourceTool`、`createSearchCodeRunTool`、`createSandboxPythonTool` 等定义，然后通过 `toolUse.policy` 为每次 agent run 精确启用工具和资源。

`search.code.run` 是 Dynamic Worker code mode 工具。它运行 JavaScript 函数体，并把受控能力暴露为 `ctx.search`、`ctx.workspace`、`ctx.runtime`。启用它时，agent policy 至少需要按需授予：

- `dynamic_worker.execution:execute`
- `runtime.javascript:execute`
- `external.search:{provider}:query`
- 每个允许出站 host 的 `http.egress:{host}:fetch`
- 生成 artifact 所需的 `workspace.path:{artifactRoot}:write`

该工具默认禁止裸 outbound，搜索/抓取行为应来自宿主注册的 search provider。

## Provider 调度器配置

当任务需要 sandbox provider 时使用 provider 调度。必须输入：

- `workspace`：一个 `WorkspaceAdapter`
- `providers`：一个或多个 `SandboxProviderCandidate`
- `task`：`command`、`python`、`codex.exec` 或 `codex.goal`
- `imageCatalog`：可选的逻辑镜像映射
- `consistency`：可选的 Workspace 一致性策略
- `preflight`：可选的 runtime 探针设置

```typescript
import { createProvider } from '@sandbank.dev/core'
import { E2BAdapter } from '@sandbank.dev/e2b'
import { DaytonaAdapter } from '@sandbank.dev/daytona'
import { MemoryWorkspaceAdapter } from '@sandbank.dev/workspace'
import {
  preflightWorkspaceSandboxTask,
  runWorkspaceSandboxTask,
} from 'sandbank'

const workspace = new MemoryWorkspaceAdapter()

const providers = [
  {
    provider: createProvider(new E2BAdapter({ apiKey: process.env.E2B_API_KEY })),
    capabilities: ['runtime.python'],
    priority: 20,
  },
  {
    provider: createProvider(new DaytonaAdapter({ apiKey: process.env.DAYTONA_API_KEY! })),
    capabilities: ['runtime.python', 'runtime.codex', 'codex.exec', 'codex.goal'],
    priority: 10,
  },
]

const imageCatalog = {
  'python-agent': {
    default: 'ghcr.io/acme/python-agent:2026.06',
    providers: {
      e2b: 'python-agent-e2b-template',
    },
  },
  'codex-agent': {
    default: 'ghcr.io/acme/codex-agent:2026.06',
  },
}

const task = {
  kind: 'python' as const,
  path: '/workspace/generated/task.py',
  image: 'python-agent',
}

const preflight = await preflightWorkspaceSandboxTask({
  workspace,
  providers,
  task,
  imageCatalog,
  preflight: { runtime: true },
})

if (!preflight.ok) throw new Error(preflight.errors.join('; '))

await runWorkspaceSandboxTask({
  workspace,
  providers,
  task,
  imageCatalog,
  consistency: { mode: 'branch-merge', conflictResolution: 'keep-both' },
  preflight: { runtime: true },
})
```

## Provider 凭证

| Provider | 常见必须配置 |
|----------|--------------|
| Daytona | `DAYTONA_API_KEY`；可选 `DAYTONA_API_URL` |
| Fly.io | `FLY_API_TOKEN`、`FLY_APP_NAME`；可选 `FLY_REGION` |
| Cloudflare | Worker Durable Object binding，例如 `env.SANDBOX`；volume 需要可选 storage config |
| BoxLite remote | `BOXLITE_API_URL`，以及 `BOXLITE_API_TOKEN` 或 OAuth2 client credentials |
| BoxLite local | 本机 `boxlite` Python package；可选 `pythonPath` 和 `boxliteHome` |
| E2B | `E2B_API_KEY`；逻辑镜像映射到 E2B template |

## 镜像要求

snapshot workspace sync 需要镜像里有 `tar` 和 `gzip`。不同 runtime 还需要对应工具链：

- Python 任务：`python`
- Codex exec：`codex`、`git`、`tar`、`gzip`
- Codex goal：`codex`、`tmux`、`bash`、`git`、`gh`、`tar`、`gzip`
- live workspace mount：Sandbank workspace client、daemon 或等价 filesystem bridge

`preflight: { runtime: true }` 会先创建临时 sandbox 探测这些工具，再 materialize 真正任务的 Workspace。

## 必须/可选总结

运行 DB-native harness 必须：

- 模型 API key
- Workspace backend 或注入的 Workspace adapter

运行 provider 派发任务必须：

- 至少一个带凭证的 provider adapter
- 与任务匹配的 provider capability
- 与任务匹配的镜像/runtime
- 当前一致性模式要求的 Workspace capability

可选：

- Harness bearer auth
- 自定义模型名和 base URL
- Dynamic Worker limits
- Provider image catalog
- Runtime preflight probe
- provider-native volume，作为缓存或 provider 本地持久化
