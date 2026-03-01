# TerminalSession 双向 PTY 接口设计

> 日期：2026-03-01

## 背景

三个 Provider 均已实现基础 `startTerminal()`（基于 ttyd），返回 `TerminalInfo { url, port }`。但 SDK 层没有封装 ttyd 的 WebSocket 二进制协议，用户需要自己处理连接管理和数据解析。

## 目标

在 `@sandbank/core` 中提供 `connectTerminal()` 函数，将 ttyd WebSocket URL 封装为易用的 `TerminalSession` 对象。

## 设计决策

- **单连接封装**：不含广播/多观众/权限控制，符合 Sandbank "最小接口" 原则
- **放在 core 包**：与现有 `withTerminal()` 能力检测配套，不新增包
- **零依赖**：使用全局 WebSocket（Node.js 22+ 和浏览器均原生支持）
- **同时支持 Node.js 和浏览器**

## 接口

```typescript
interface TerminalSession {
  write(data: string): void
  onData(cb: (data: string) => void): Disposable
  resize(cols: number, rows: number): void
  close(): void
  readonly state: 'connecting' | 'open' | 'closed'
  readonly ready: Promise<void>
}

interface Disposable {
  dispose(): void
}

function connectTerminal(info: TerminalInfo): TerminalSession
```

## ttyd 协议

ttyd 使用二进制 WebSocket 帧，首字节为消息类型：

**Client → Server:**
- `0x00` + UTF-8 文本 = 用户输入
- `0x01` + JSON = resize (`{"columns":N,"rows":N}`)

**Server → Client:**
- `0x00` + UTF-8 文本 = 终端输出
- `0x01` = 认证要求（本设计中忽略）
- `0x02` + 文本 = 窗口标题

## 文件变更

1. `core/src/types.ts` — 新增 `TerminalSession`、`Disposable` 接口
2. `core/src/terminal.ts` — `connectTerminal()` 实现
3. `core/src/index.ts` — 导出
4. `core/test/terminal.test.ts` — 单元测试

## 使用示例

```typescript
const info = await terminal.startTerminal()
const session = connectTerminal(info)
await session.ready

session.onData((data) => process.stdout.write(data))
session.write('ls -la\n')
session.resize(120, 40)
session.close()
```
