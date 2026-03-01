# Sandbank TODO

> 项目待办事项追踪。按优先级排列。

## P0 — Terminal 能力增强

核心需求：Live 平台需要沙箱内的交互式终端（PTY 双向流式 I/O）。

当前状态：三个 Provider 均已实现基础 `startTerminal()`（基于 ttyd，返回 WebSocket URL），但 **SDK 层面的 `TerminalSession` 双向 PTY 封装尚未实现**。

### 现有接口

```typescript
// core/src/types.ts
interface TerminalSandbox extends Sandbox {
  startTerminal(options?: TerminalOptions): Promise<TerminalInfo>
}

interface TerminalOptions {
  shell?: string
  hostname?: string
}

interface TerminalInfo {
  url: string   // WebSocket URL
  port: number
}
```

### 产品需求

```
前端
├── ghostty-web 终端组件（连接 sandbox 内 Claude Code）
├── 产品预览 iframe（URL 来自 sandbox.exposePort()）
├── 观众聊天 + 申请结对按钮
└── 房间状态管理

后端 - 房间服务
├── 开播 → provider.create() 创建沙箱
├── 沙箱内启动 Claude Code CLI + dev server
├── 终端 I/O 广播（PTY → WebSocket → 所有观众只读流）
├── 结对审批 → 授予某观众终端写权限
└── 下播 → provider.destroy()
```

### 设计方向

**方案 A：在 Sandbank 层扩展 terminal 能力**

在 sandbox 容器内跑一个轻量 WebSocket-PTY bridge（Go/Rust 小服务），adapter 连接它。

需要扩展接口：

```typescript
interface TerminalSession {
  write(data: string | Uint8Array): void   // 用户输入 → PTY
  onData(cb: (data: string) => void): void // PTY 输出 → 用户
  resize(cols: number, rows: number): void
  close(): void
}
```

### 待决定

- [ ] PTY bridge 用什么语言写（Go vs Rust vs Node）
- [ ] 是作为 sidecar 注入还是预装在基础镜像里
- [ ] TerminalInfo 返回 WebSocket URL 后，权限控制怎么做（token / session）
- [ ] 多观众只读流广播放在 Relay 层还是单独的 broadcast 服务

---

## P1 — 扩展能力覆盖

### exec.stream

- [ ] Daytona — 检查 `@daytonaio/sdk` 是否支持流式执行
- [ ] Fly.io — Fly Machines API 暂无流式 exec，需要走 PTY bridge 或者 NATS

### snapshot

- [ ] Daytona — 检查 SDK 是否有快照 API
- [ ] Fly.io — 不原生支持，考虑 volume snapshot 或跳过

### ~~uploadArchive / downloadArchive~~ ✅

- [x] 所有 provider — 通过 `uploadArchiveViaExec` / `downloadArchiveViaExec` exec fallback 自动获得能力

---

## P2 — 发布与基建

- [x] GitHub Actions CI — typecheck + test（PR 触发）
- [x] 集成测试 CI — 用 secrets 跑真实 API 测试（每周定时 + 手动触发）
- [x] npm 发布流水线 — 通过 git tag `v*` 触发自动发布
- [x] CHANGELOG.md — 手动维护
- [x] 各子包独立 README — 6 个包均已创建

---

## P3 — 未来 Provider

- [ ] E2B — 评估 API 兼容性
- [ ] Modal — 评估是否适合作为 sandbox provider
- [ ] Docker local — 本地开发用，不依赖云服务

---

## 已完成

- [x] Core 接口设计与实现
- [x] Daytona 适配器（volumes + port.expose + terminal）
- [x] Fly.io 适配器（volumes + port.expose + terminal + 真实 API 测试）
- [x] Cloudflare 适配器（exec.stream + snapshot + volumes + port.expose + terminal）
- [x] Relay 通信系统（WebSocket + JSON-RPC 2.0）
- [x] Agent 客户端 + CLI
- [x] 跨 Provider 一致性测试（38+ 测试）
- [x] README 三语版本（EN / ZH / JA）
- [x] package.json 发布元数据
- [x] 三个 Provider 基础 terminal 实现（ttyd 方案）
