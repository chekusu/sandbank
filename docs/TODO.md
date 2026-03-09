# Sandbank TODO

> 项目待办事项追踪。按优先级排列。

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

## P3 — Service Layer

- [x] Core ServiceProvider 接口（ServiceConfig / ServiceInfo / ServiceBinding）
- [x] `withServices()` 能力检测
- [x] `create()` 自动注入 service 凭证到环境变量
- [x] `@sandbank.dev/db9` — db9.ai 适配器（REST API 客户端 + skill 注入）
- [x] Brain schema（memory / tasks / artifacts）+ brain skill
- [x] `createDb9Service` / `createDb9Brain` 便捷函数
- [ ] 集成测试 — 需 DB9_TOKEN 验证真实 API

---

## P4 — 未来 Provider

- [x] BoxLite — 裸金属 KVM/HVF 微型 VM（exec.stream + snapshot + sleep + terminal + port.expose）
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
- [x] SDK 层 `connectTerminal` + `TerminalSession` 双向 PTY 封装
- [x] uploadArchive / downloadArchive exec fallback（所有 provider 自动获得）
- [x] BoxLite 适配器（exec.stream + snapshot + sleep + terminal + port.expose）
- [x] Service Layer 接口 + db9 适配器 + Brain 多 Agent 记忆层
