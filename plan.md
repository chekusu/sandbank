# Relay 跨仓库改进计划

**日期**：2026-03-17
**范围**：`sandbank/packages/relay` + `cloud.sandbank.dev` 的 relay 集成
**输入**：`docs/2026-03-17-relay-review.md` 审查报告 + 全面代码审查

---

## 现状总结

Relay 是一个 JSON-RPC 2.0 消息中继，设计为 trusted 单 session 内的轻量协作总线。
Cloud 把它当成 node 级长生命周期基础设施，放大了四类设计缺陷：

| # | 问题 | relay 影响 | cloud 影响 |
|---|------|-----------|-----------|
| 1 | 只有 register，没有 unregister | 内存慢泄漏 | sandbox 残留累积 |
| 2 | 消息投递语义不清（WS push 不清队列） | 可能重复投递 | browser 命令重复执行 |
| 3 | orchestrator 无 durable queue | 断连丢消息 | box→agent 控制消息丢失 |
| 4 | token 是 session 级共享密钥 | 设计如此 | 同 node 所有 box 共享凭证 |

另有两个 cloud 侧的集成问题：
- `relaySandboxName` 未持久化到 DB，destroy 时无法查找
- `registerSandbox` 是 fire-and-forget（`.catch()`），失败后 box 已创建但 relay 不知道

---

## 改动边界

### 不动的接口

- `startRelay(options)` 签名不变
- `RelayServer` 返回类型不变
- HTTP `/rpc` 端点格式不变
- WebSocket `session.auth` 握手流程不变
- `QueuedMessage` 结构不变
- `packages/core/src/session.ts` 的 `Session` 公开接口不变
- `packages/agent/src/http-client.ts` 的公开 API 不变

### 会动的接口

- `SessionStore` 增加 `unregisterSandbox()` 方法
- `protocol.ts` 增加 `session.unregister` RPC 方法
- `SessionStore.enqueueMessage()` 内部行为微调（WS push 后标记已投递）
- `RelaySession` 类型可能增加 `orchestratorQueue` 字段
- cloud `boxes` 表增加 `relay_name` 列

---

## Phase 1：生命周期闭环（unregister）

**目标**：sandbox 销毁时能从 relay session 中干净移除，防止内存泄漏和名称残留。

### 1.1 relay: 增加 `unregisterSandbox`

**文件**：`packages/relay/src/session-store.ts`

```typescript
unregisterSandbox(sessionId: string, name: string): void {
  const session = this.getSession(sessionId)
  if (!session) return // 幂等：session 不存在不报错

  // 清理 sandbox 条目
  session.sandboxes.delete(name)

  // 清理消息队列
  session.messageQueues.delete(name)

  // 清理 poll waiters（resolve 空数组）
  const waiters = session.pollWaiters.get(name)
  if (waiters) {
    for (const w of waiters) {
      clearTimeout(w.timer)
      w.resolve([])
    }
    session.pollWaiters.delete(name)
  }

  // 断开该 sandbox 的 WebSocket 客户端
  for (const client of session.clients) {
    if (client.sandboxName === name && client.ws.readyState === client.ws.OPEN) {
      client.ws.close(1000, 'sandbox unregistered')
    }
  }

  this.touch(session)
}
```

**设计决策**：
- **幂等**：重复 unregister 不报错，方便 GC 和 destroy 都安全调用
- **主动断开 WS**：如果 sandbox 的 agent 还连着，服务端主动关闭，避免僵尸连接
- **清空 poll waiters**：resolve 空数组而非 reject，让客户端正常退出

### 1.2 relay: 增加 `session.unregister` RPC

**文件**：`packages/relay/src/protocol.ts`

在 `handleRpc` switch 中新增：

```typescript
case 'session.unregister':
  return handleUnregister(store, id, client.sessionId, p)
```

handler：

```typescript
function handleUnregister(
  store: SessionStore,
  id: number | string,
  sessionId: string,
  params: Record<string, unknown>,
): JsonRpcResponse {
  const name = params['name'] as string
  if (!name) return rpcError(id, -32602, 'Missing name')

  store.unregisterSandbox(sessionId, name)
  return rpcResult(id, { ok: true })
}
```

### 1.3 relay: 增加测试

**文件**：`packages/relay/test/session-store.test.ts`

新增测试：
- [ ] `unregisterSandbox removes sandbox entry`
- [ ] `unregisterSandbox cleans message queue`
- [ ] `unregisterSandbox resolves poll waiters with empty array`
- [ ] `unregisterSandbox disconnects WS client`
- [ ] `unregisterSandbox is idempotent (no error on missing sandbox)`
- [ ] `unregisterSandbox is idempotent (no error on missing session)`

**文件**：`packages/relay/test/protocol.test.ts`

- [ ] `session.unregister removes sandbox`
- [ ] `session.unregister missing name returns error`

**文件**：`packages/relay/test/server.test.ts`

- [ ] `HTTP session.unregister round-trip`

### 1.4 core: session.close() 在 destroy 前 unregister

**文件**：`packages/core/src/session.ts`

当前 `close()` 直接 `provider.destroy()`，不通知 relay。改为：

```typescript
// close() 内，destroy 之前
await Promise.allSettled(
  [...sandboxes.entries()]
    .filter(([, sb]) => sb != null)
    .map(([name]) => rpcCall('session.unregister', { name }).catch(() => {}))
)
```

### 1.5 cloud: DB 持久化 relay_name

**文件**：`~/Codes/cloud.sandbank.dev/src/agent/db.ts`

`boxes` 表增加列：

```sql
ALTER TABLE boxes ADD COLUMN relay_name TEXT DEFAULT NULL
```

创建 box 时写入 `relaySandboxName`，destroy/GC 时可根据 `relay_name` 查找。

### 1.6 cloud: browser-relay 增加 unregisterSandbox

**文件**：`~/Codes/cloud.sandbank.dev/src/agent/browser-relay.ts`

`BrowserRelay` 接口增加：

```typescript
unregisterSandbox(name: string): Promise<void>
```

实现：

```typescript
async unregisterSandbox(name: string) {
  await client.rpc('session.unregister', { name })
}
```

### 1.7 cloud: destroy 和 GC 路径调用 unregister

**文件**：`~/Codes/cloud.sandbank.dev/src/agent/server.ts`（DELETE /boxes/:id）

```typescript
// 在 adapter.destroySandbox 之后
const record = db.get(id)
if (record?.relay_name && browserRelay) {
  browserRelay.unregisterSandbox(record.relay_name).catch((err) =>
    console.warn(`[RELAY] unregister failed: ${err}`)
  )
}
```

**文件**：`~/Codes/cloud.sandbank.dev/src/agent/gc.ts`

GC 的 expired 和 error 清理路径也加同样逻辑。需要传入 `browserRelay` 和 `db` 引用。

### 1.8 cloud: registerSandbox 改为 await

**文件**：`~/Codes/cloud.sandbank.dev/src/agent/server.ts` L604-607

当前是 fire-and-forget：

```typescript
browserRelay.registerSandbox(relaySandboxName, sandbox.id).catch(...)
```

改为 await，失败则回滚（destroy sandbox + release port）：

```typescript
if (browserRelay && relaySandboxName) {
  try {
    await browserRelay.registerSandbox(relaySandboxName, sandbox.id)
  } catch (err) {
    console.error(`[RELAY] register failed, destroying sandbox: ${err}`)
    await adapter.destroySandbox(sandbox.id).catch(() => {})
    sandboxCache.delete(sandbox.id)
    db.updateStatus(sandbox.id, 'terminated')
    throw err
  }
}
```

### Phase 1 检查清单

- [x] 1.1 relay `SessionStore.unregisterSandbox()`
- [x] 1.2 relay `session.unregister` RPC method
- [x] 1.3 relay 测试（9 个新测试）
- [x] 1.4 core `session.close()` 增加 unregister
- [x] 1.5 cloud DB 增加 `relay_name` 列 + 迁移
- [x] 1.6 cloud `BrowserRelay.unregisterSandbox()`
- [x] 1.7 cloud destroy + GC 调用 unregister
- [x] 1.8 cloud registerSandbox 改为 await + 回滚
- [x] typecheck 全部通过
- [x] relay 测试全部通过（80 tests）
- [x] core hooks 测试全部通过（30 tests）

---

## Phase 2：消息投递语义明确化

**目标**：消除 WS push + queue 的重复投递窗口，让投递语义清晰。

### 2.1 relay: WS push 成功后标记已消费

**文件**：`packages/relay/src/session-store.ts`

当前 `enqueueMessage()` 逻辑：
1. 消息入队
2. 如果有 poll waiter → drain 给 waiter（队列清空）✅ 正确
3. 否则 WS push（但消息留在队列中）❌ 重复窗口

改为：WS push 成功后从队列移除该消息。

```typescript
// enqueueMessage 中 WS push 部分
const pushed = this.pushToWebSocketClient(session, to, msg)
if (pushed) {
  // WS 推送成功，从队列移除（避免后续 poll 重复拿到）
  const idx = queue.indexOf(msg)
  if (idx >= 0) queue.splice(idx, 1)
}
```

### 2.2 relay: pushToWebSocketClient 返回投递结果

**文件**：`packages/relay/src/session-store.ts`

`pushToWebSocketClient` 改为返回 boolean（是否成功推送给至少一个客户端）：

```typescript
private pushToWebSocketClient(session: RelaySession, targetName: string, msg: QueuedMessage): boolean {
  const notification = JSON.stringify({ jsonrpc: '2.0', method: 'message', params: msg })
  let sent = false
  for (const client of session.clients) {
    if (client.sandboxName === targetName && client.ws.readyState === client.ws.OPEN) {
      client.ws.send(notification)
      sent = true
    }
  }
  return sent
}
```

### 2.3 relay: 测试

- [ ] `enqueueMessage: WS push 后消息从队列移除`
- [ ] `enqueueMessage: WS 客户端不在线时消息留在队列`
- [ ] `enqueueMessage: poll waiter 优先于 WS push（不变）`

### Phase 2 检查清单

- [x] 2.1 enqueueMessage WS push 后清队列
- [x] 2.2 pushToWebSocketClient 返回 boolean
- [x] 2.3 测试（2 个新测试）
- [x] 现有测试全部通过（回归验证）

---

## Phase 3：orchestrator durable queue

**目标**：orchestrator 断连时不丢消息，重连后可补拉。

### 3.1 relay: 为 orchestrator 增加消息队列

**文件**：`packages/relay/src/types.ts`

`RelaySession` 增加字段：

```typescript
orchestratorQueue: QueuedMessage[]
```

**文件**：`packages/relay/src/session-store.ts`

`createSession` 时初始化 `orchestratorQueue: []`。

### 3.2 relay: pushToOrchestrator 改为 queue + push

**文件**：`packages/relay/src/session-store.ts`

```typescript
private pushToOrchestrator(session: RelaySession, msg: QueuedMessage): void {
  // 先入队
  session.orchestratorQueue.push(msg)
  if (session.orchestratorQueue.length > this.maxQueueSize) {
    session.orchestratorQueue.shift()
  }

  // 尝试实时推送
  const notification = JSON.stringify({ jsonrpc: '2.0', method: 'message', params: msg })
  let sent = false
  for (const client of session.clients) {
    if (client.role === 'orchestrator' && client.ws.readyState === client.ws.OPEN) {
      client.ws.send(notification)
      sent = true
    }
  }

  // push 成功则移除
  if (sent) {
    const idx = session.orchestratorQueue.indexOf(msg)
    if (idx >= 0) session.orchestratorQueue.splice(idx, 1)
  }
}
```

### 3.3 relay: 允许 orchestrator 拉取消息

**文件**：`packages/relay/src/protocol.ts`

`handleRecv` 当前要求 `sandboxName`，增加 orchestrator 分支：

```typescript
function handleRecv(...): ... {
  const session = store.getSession(sessionId)
  if (!session) return rpcError(id, -32000, 'Session not found')

  // orchestrator pull（新增）
  if (!sandboxName && client.role === 'orchestrator') {
    const limit = (params['limit'] as number) ?? 100
    const msgs = session.orchestratorQueue.splice(0, limit)
    store.touch(session)
    return rpcResult(id, { messages: msgs })
  }

  if (!sandboxName) return rpcError(id, -32602, 'No sandbox name — cannot recv')
  // ... 原有 agent 逻辑
}
```

### 3.4 relay: 测试

- [ ] `orchestrator message queued when offline`
- [ ] `orchestrator message dequeued on push success`
- [ ] `orchestrator can pull messages via message.recv`
- [ ] `orchestratorQueue respects maxQueueSize`

### Phase 3 检查清单

- [x] 3.1 RelaySession 增加 orchestratorQueue
- [x] 3.2 pushToOrchestrator 改为 queue + push
- [x] 3.3 handleRecv 支持 orchestrator pull
- [x] 3.4 测试（5 个新测试）
- [x] 全部测试通过

---

## Phase 4：鉴权收紧（sandbox 级 token）

**目标**：每个 sandbox 拥有独立 token，不能冒充其他 sandbox 或 orchestrator。

### 4.1 relay: sandbox 级 token

**文件**：`packages/relay/src/types.ts`

`SandboxEntry` 增加 `token?: string`。

**文件**：`packages/relay/src/session-store.ts`

`registerSandbox` 支持可选 token 参数：

```typescript
registerSandbox(sessionId: string, name: string, sandboxId: string, token?: string): void {
  // ... 现有检查 ...
  const sandboxToken = token ?? randomUUID()
  session.sandboxes.set(name, { name, sandboxId, state: 'running', token: sandboxToken })
  session.messageQueues.set(name, [])
}
```

### 4.2 relay: 认证时验证 sandbox token

**文件**：`packages/relay/src/protocol.ts`（`handleAuth`）
**文件**：`packages/relay/src/server.ts`（HTTP handler）

对于带 sandboxName 的请求：
- 如果 sandbox 有专属 token → 用 sandbox token 验证
- 如果 sandbox 无专属 token（旧注册）→ fallback 到 session token

不接受客户端自报 role：
- 有 sandboxName → agent
- 没有 sandboxName + session token 有效 → orchestrator

### 4.3 relay: session.register 返回 sandbox token

**文件**：`packages/relay/src/protocol.ts`

```typescript
function handleRegister(...): JsonRpcResponse {
  // ...
  store.registerSandbox(sessionId, name, sandboxId, token)
  return rpcResult(id, { ok: true, token: entry.token })
}
```

### 4.4 core: spawn 预生成 sandbox token

**文件**：`packages/core/src/session.ts`

当前顺序：create sandbox（注入 env）→ register。sandbox token 需要在 create 前生成：

```typescript
// spawn 中
const sandboxToken = crypto.randomUUID()
const env = {
  ...sandboxConfig.env,
  SANDBANK_AUTH_TOKEN: sandboxToken, // sandbox 专属 token
  // ...
}
const sandbox = await config.provider.create({ ...sandboxConfig, env })
await rpcCall('session.register', { name, sandboxId: sandbox.id, token: sandboxToken })
```

### 4.5 cloud: 同步更新

**文件**：`~/Codes/cloud.sandbank.dev/src/agent/browser-relay.ts`

- `getEnvVars` 接受 sandbox token 参数（或内部预生成）
- `registerSandbox` 传入 token

### 4.6 向后兼容

- 如果 sandbox token 未设置（旧注册），fallback 到 session token 验证
- 已有的 agent HTTP client 不需要立即更新

### Phase 4 检查清单

- [ ] 4.1 SandboxEntry 增加 token
- [ ] 4.2 认证路径验证 sandbox token（含 fallback）
- [ ] 4.3 session.register 支持 token 参数并返回
- [ ] 4.4 core spawn 预生成 sandbox token
- [ ] 4.5 cloud browser-relay 适配
- [ ] 4.6 向后兼容 fallback
- [ ] 全部测试通过

---

## Phase 5：server 端资源上限

**目标**：relay server 自身限制每个 session 的 sandbox 数量，不依赖 client 自觉。

### 5.1 relay: maxSandboxesPerSession 配置

**文件**：`packages/relay/src/types.ts`

```typescript
interface SessionStoreOptions {
  // ... 现有字段 ...
  maxSandboxesPerSession?: number // 默认 100
}
```

### 5.2 relay: registerSandbox 检查上限

**文件**：`packages/relay/src/session-store.ts`

```typescript
registerSandbox(sessionId, name, sandboxId, token?) {
  // ... 现有检查 ...
  if (session.sandboxes.size >= this.maxSandboxesPerSession) {
    throw new Error(`Max sandboxes per session reached (${this.maxSandboxesPerSession})`)
  }
  // ...
}
```

### Phase 5 检查清单

- [x] 5.1 增加 maxSandboxesPerSession 配置
- [x] 5.2 registerSandbox 检查上限
- [x] 测试

---

## 执行顺序和依赖关系

```
Phase 1 (生命周期闭环)          ← 最高优先级
  ├── 1.1-1.3: relay 侧（独立）
  ├── 1.4: core 侧（依赖 1.2）
  └── 1.5-1.8: cloud 侧（依赖 1.1-1.2）

Phase 2 (消息语义)              ← 可与 Phase 1 并行
Phase 3 (orchestrator queue)    ← 可与 Phase 1 并行
Phase 5 (资源上限)              ← 可与 Phase 1 并行

Phase 4 (sandbox token)         ← 依赖 Phase 1（register 改动）
```

**建议执行路径**：Phase 1 → Phase 2 + Phase 3 + Phase 5 并行 → Phase 4

---

## 风险和权衡

| 决策 | 选择 | 理由 |
|------|------|------|
| unregister 幂等 vs 严格 | 幂等 | GC 和 destroy 都会调用，重复调用不应出错 |
| WS push 后清队列 vs 引入 ack | 清队列 | ack 机制复杂度高，当前场景不需要 exactly-once |
| orchestrator queue 持久化 vs 内存 | 内存 | relay 定位仍是轻量总线，不引入持久化依赖 |
| sandbox token 由 relay 生成 vs 调用方预生成 | 调用方预生成 | 避免改变 core 中 create→register 的顺序 |
| Phase 4 向后兼容 | fallback 到 session token | 渐进迁移，不一次性 breaking change |

---

## 版本计划

| 包 | 当前版本 | Phase 1 后 | Phase 4 后 |
|----|---------|-----------|-----------|
| @sandbank.dev/relay | 0.2.0 | 0.3.0 | 0.4.0 |
| @sandbank.dev/core | 0.3.4 | 0.3.5 | 0.4.0 |
| cloud.sandbank.dev | 0.5.0 | 0.6.0 | 0.7.0 |

Phase 1 是 minor bump（新增 API，不 break 现有）。
Phase 4 是 minor bump（新增 token 参数，fallback 兼容）。
