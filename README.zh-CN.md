# Sandbank

> AI Agent 统一沙箱 SDK — 一次编写，多云运行。

Sandbank 提供统一的 TypeScript 接口来创建、管理和编排云端沙箱。切换 Provider 无需修改业务代码。

**[English](./README.md)** | **[日本語](./README.ja.md)**

## 为什么选择 Sandbank?

AI Agent 需要隔离的执行环境，但每家云厂商的 API 都不一样 — Daytona、Fly.io、Cloudflare Workers 各有一套。Sandbank 将它们统一到一个接口后面：

```typescript
import { createProvider } from '@sandbank/core'
import { DaytonaAdapter } from '@sandbank/daytona'

const provider = createProvider(new DaytonaAdapter({ apiKey: '...' }))
const sandbox = await provider.create({ image: 'node:22' })

const result = await sandbox.exec('echo "Hello from the sandbox"')
console.log(result.stdout) // Hello from the sandbox

await provider.destroy(sandbox.id)
```

把 `DaytonaAdapter` 换成 `FlyioAdapter` 或 `CloudflareAdapter` — 代码零改动。

## 架构

```
┌──────────────────────────────────────────────────────┐
│  你的应用 / AI Agent                                  │
├──────────────────────────────────────────────────────┤
│  @sandbank/core         统一 Provider 接口            │
│  @sandbank/skills       Skill 注册表与注入            │
│  @sandbank/agent        沙箱内 Agent 客户端           │
│  @sandbank/relay        多 Agent 通信中枢             │
├──────────────────────────────────────────────────────┤
│  @sandbank/daytona  @sandbank/flyio  @sandbank/cloudflare  │
│  @sandbank/boxlite                                   │
│  Provider 适配器                                      │
├──────────────────────────────────────────────────────┤
│  Daytona    Fly.io Machines    Cloudflare Workers     │
│  BoxLite (自托管 Docker)                              │
└──────────────────────────────────────────────────────┘
```

## 包一览

| 包名 | 说明 |
|------|------|
| [`@sandbank/core`](./packages/core) | Provider 抽象、能力系统、错误类型 |
| [`@sandbank/skills`](./packages/skills) | Skill 注册表、本地文件系统加载器 |
| [`@sandbank/daytona`](./packages/daytona) | Daytona 云沙箱适配器 |
| [`@sandbank/flyio`](./packages/flyio) | Fly.io Machines 适配器 |
| [`@sandbank/cloudflare`](./packages/cloudflare) | Cloudflare Workers 适配器 |
| [`@sandbank/boxlite`](./packages/boxlite) | BoxLite 自托管 Docker 适配器 |
| [`@sandbank/relay`](./packages/relay) | WebSocket 中继，用于多 Agent 通信 |
| [`@sandbank/agent`](./packages/agent) | 沙箱内 Agent 轻量客户端 |

## Provider 支持情况

### 基础操作

所有 Provider 都必须实现的最小契约：

| 操作 | Daytona | Fly.io | Cloudflare | BoxLite |
|------|:-------:|:------:|:----------:|:-------:|
| 创建 / 销毁 | ✅ | ✅ | ✅ | ✅ |
| 列出沙箱 | ✅ | ✅ | ✅ | ✅ |
| 执行命令 | ✅ | ✅ | ✅ | ✅ |
| 读写文件 | ✅ | ✅ | ✅ | ✅ |

### 扩展能力

能力是可选的。通过 `withVolumes(provider)`、`withPortExpose(sandbox)` 等函数在运行时安全检测并访问。

| 能力 | Daytona | Fly.io | Cloudflare | BoxLite | 说明 |
|------|:-------:|:------:|:----------:|:-------:|------|
| `volumes` | ✅ | ✅ | ⚠️* | ❌ | 持久卷管理 |
| `port.expose` | ✅ | ✅ | ✅ | ✅ | 将沙箱端口暴露到公网 |
| `exec.stream` | ❌ | ❌ | ✅ | ✅ | 实时流式输出 stdout/stderr |
| `snapshot` | ❌ | ❌ | ✅ | ✅ | 沙箱状态快照与恢复 |
| `terminal` | ✅ | ✅ | ✅ | ✅ | 交互式 Web 终端 (ttyd) |
| `sleep` | ❌ | ❌ | ❌ | ✅ | 休眠与唤醒 |

\* Cloudflare 的 `volumes` 需要在适配器配置中启用 `storage` 选项。

### Provider 特性对比

| | Daytona | Fly.io | Cloudflare | BoxLite |
|---|---------|--------|------------|---------|
| **运行时** | 完整 VM | Firecracker 微虚拟机 | V8 隔离 + 容器 | Docker 容器 |
| **冷启动** | ~10s | ~3-5s | ~1s | ~2-5s |
| **文件 I/O** | 原生 SDK | 通过 exec (base64) | 原生 SDK | 通过 exec (base64) |
| **区域** | 多区域 | 多区域 | 全球边缘 | 自托管 |
| **外部依赖** | `@daytonaio/sdk` | 无 (纯 fetch) | `@cloudflare/sandbox` | BoxLite API |

## 多 Agent 会话

Sandbank 内置编排层，支持多 Agent 实时协作。**Relay** 负责沙箱间的消息传递和共享上下文。

```typescript
import { createSession } from '@sandbank/core'

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

在沙箱内部，Agent 使用 `@sandbank/agent`：

```typescript
import { connect } from '@sandbank/agent'

const session = await connect() // 自动读取 SANDBANK_* 环境变量

session.on('message', async (msg) => {
  if (msg.type === 'task') {
    // 执行任务...
    await session.send(msg.from, 'done', result)
  }
})

await session.complete({ status: 'success', summary: '完成了 5 个 API 端点' })
```

## 快速开始

```bash
# 安装
pnpm add @sandbank/core @sandbank/daytona  # 或 @sandbank/flyio、@sandbank/cloudflare

# 配置 Provider
export DAYTONA_API_KEY=your-key
```

```typescript
import { createProvider } from '@sandbank/core'
import { DaytonaAdapter } from '@sandbank/daytona'

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

### 运行集成测试

集成测试会调用真实 API，通过环境变量控制开关：

```bash
# Daytona
DAYTONA_API_KEY=... pnpm test

# Fly.io
FLY_API_TOKEN=... FLY_APP_NAME=... pnpm test

# Cloudflare
E2E_WORKER_URL=... pnpm test
```

## 设计原则

1. **最小接口，最大互操作** — 只做真正的最大公约数 (exec + files + lifecycle)
2. **显式优于隐式** — 不自动 fallback、不缓存、不隐式重试
3. **能力检测，而非假实现** — 不支持就报错，不返回假数据
4. **幂等操作** — 销毁已销毁的沙箱不报错
5. **完全解耦** — Provider 层和 Session 层独立，自由组合

## 许可证

MIT
