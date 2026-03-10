# Sandbox Observability Design

Add an observability layer to Sandbank so that all sandbox operations and inner-agent decision steps are recorded in real-time to a pluggable storage backend (DB9, webhook, or custom).

## Problem

Currently sandboxes are **runnable** (exec, writeFile) and **restorable** (snapshots), but not **observable**. When a long-running agent (e.g. Claude Code) runs inside a sandbox for 5–10 minutes, we have no structured record of what happened during execution. Parsing JSONL log files is fragile and lossy.

## Design

Two-layer architecture, both pluggable:

### Layer 1: Provider-level observation (automatic)

Every sandbox operation passes through the Sandbank provider/session layer. We intercept here and emit structured events to an observer.

```typescript
interface SandboxEvent {
  type: 'sandbox:exec' | 'sandbox:writeFile' | 'sandbox:readFile' | 'sandbox:exposePort'
  taskId?: string
  sandboxId: string
  timestamp: number
  data: Record<string, unknown> // command, exitCode, path, etc.
}

interface SandboxObserver {
  onEvent(event: SandboxEvent): void | Promise<void>
}
```

Provider wiring:

```typescript
const provider = createProvider(adapter, {
  observer: myObserver, // optional, pluggable
})
```

Built-in observer implementations:
- `createDB9Observer(brain)` — writes events as DB9 memories
- `createWebhookObserver(url)` — POSTs events to a webhook
- `createNoopObserver()` — default, does nothing

### Layer 2: Inner-agent hooks (configurable)

When a CLI tool (Claude Code, Aider, etc.) runs inside a sandbox, its internal tool calls are not visible at the provider level — the provider sees only one `exec()` call.

Solution: inject a hooks configuration into the sandbox before launching the inner agent. The hooks fire deterministically on tool calls, sending structured events to a configurable endpoint.

Example flow:

```typescript
// 1. Start an event receiver inside the sandbox (or expose external endpoint)
const eventEndpoint = await setupEventReceiver(sandbox)

// 2. Inject hooks config
await sandbox.writeFile('/.claude/hooks.json', JSON.stringify({
  hooks: {
    PostToolUse: [{
      command: `curl -s -X POST ${eventEndpoint}/event -d '{"tool":"$TOOL_NAME"}'`
    }],
    Stop: [{
      command: `curl -s -X POST ${eventEndpoint}/event -d '{"type":"completed"}'`
    }]
  }
}))

// 3. Launch the inner agent
await sandbox.exec('claude --task "fix bug #123"')
```

The event receiver forwards events to the configured backend (DB9, webhook, etc.).

### Why hooks, not LLM tool injection

| Approach | Deterministic? | Works with any CLI tool? |
|----------|:-:|:-:|
| Inject DB9 skill, hope LLM uses it | No | No |
| Parse JSONL log files | Yes | Fragile |
| **Hooks on tool calls** | **Yes** | **Yes** |

Hooks are shell commands triggered by the runtime on specific events. They fire regardless of LLM behavior. They work with any tool that supports a hook/plugin system.

## Architecture

```
┌──────────── Sandbox ─────────────────┐
│                                      │
│  Inner Agent (Claude Code / etc.)    │
│    ├─ tool call ──hook──→ endpoint ──│──→ Observer → DB9 / webhook / ...
│    ├─ tool call ──hook──→ endpoint ──│──→ Observer → DB9 / webhook / ...
│    └─ stop      ──hook──→ endpoint ──│──→ Observer → DB9 / webhook / ...
│                                      │
└──────────────────────────────────────┘
         │
         │ exec() / writeFile() / readFile()
         │ (Layer 1: provider auto-records)
         ▼
    Observer → DB9 / webhook / ...
```

## Event Schema

```typescript
// Layer 1 events (provider level)
{ type: 'sandbox:exec', sandboxId, taskId, command, exitCode, stdout, duration }
{ type: 'sandbox:writeFile', sandboxId, taskId, path, size }
{ type: 'sandbox:readFile', sandboxId, taskId, path }

// Layer 2 events (inner-agent level)
{ type: 'agent:tool', taskId, tool, input, output }
{ type: 'agent:thinking', taskId, summary }
{ type: 'agent:completed', taskId, result }
{ type: 'agent:error', taskId, error }
```

## Querying (with DB9)

When DB9 is the backend, all events become queryable memories:

```typescript
// Structured queries, no text parsing
await brain.recall('task-abc 的所有工具调用')
await brain.recall('sandbox sb-123 中失败的操作')
await brain.recall('auth.ts 相关的修改历史')
```

## Implementation Plan

1. Define `SandboxObserver` interface in `@sandbank.dev/core`
2. Wire observer into provider/session layer (auto-record exec/writeFile/readFile)
3. Create `createDB9Observer()` in `@sandbank.dev/db9`
4. Create `createWebhookObserver()` in `@sandbank.dev/core`
5. Add hooks injection helper for Claude Code in `@sandbank.dev/agent`
6. Tests for each component
