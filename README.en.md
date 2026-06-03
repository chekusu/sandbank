# Sandbank

> Unified sandbox SDK for AI agents — write once, run on any cloud.

**[Website](https://sandbank.dev)** | **[中文文档](./README.md)** | **[日本語ドキュメント](./README.ja.md)**

<img src="./docs/assets/sandbank-robots-vacation-pixel.png" alt="Pixel art robot agents vacationing on an ocean sandbank, each with a different developer role" width="100%" />

Sandbank provides a single TypeScript interface for creating, managing, and orchestrating cloud sandboxes. Switch between providers without changing your application code.

## Why Sandbank?

AI agents need isolated execution environments. But every cloud provider has a different API — Daytona, Fly.io, Cloudflare Workers all speak different languages. Sandbank unifies them behind one interface:

```typescript
import { createProvider } from '@sandbank.dev/core'
import { DaytonaAdapter } from '@sandbank.dev/daytona'

const provider = createProvider(new DaytonaAdapter({ apiKey: '...' }))
const sandbox = await provider.create({ image: 'node:22' })

const result = await sandbox.exec('echo "Hello from the sandbox"')
console.log(result.stdout) // Hello from the sandbox

await provider.destroy(sandbox.id)
```

Swap `DaytonaAdapter` for `FlyioAdapter` or `CloudflareAdapter` — zero code changes.

## Architecture

```
┌──────────────────────────────────────────────────────┐
│  Your Application / AI Agent                         │
├──────────────────────────────────────────────────────┤
│  sandbank                   Agent Supervisor / Scheduler │
│  @sandbank.dev/core         Unified Provider Interface   │
│  @sandbank.dev/workspace    Durable Workspace & Checkpoints │
│  @sandbank.dev/skills       Skill Registry & Injection   │
│  @sandbank.dev/agent        In-sandbox Agent Client      │
│  @sandbank.dev/relay        Multi-agent Communication    │
├──────────────────────────────────────────────────────┤
│  @sandbank.dev/daytona  @sandbank.dev/flyio  @sandbank.dev/cloudflare  │
│  @sandbank.dev/boxlite  @sandbank.dev/e2b                 │
│  Provider Adapters (Compute)                         │
├──────────────────────────────────────────────────────┤
│  @sandbank.dev/db9       Service Adapter (Data)      │
├──────────────────────────────────────────────────────┤
│  Daytona    Fly.io Machines    Cloudflare Workers     │
│  BoxLite (self-hosted Docker)    E2B Cloud Sandboxes   │
│  db9.ai (PostgreSQL)                                  │
└──────────────────────────────────────────────────────┘
```

## Packages

| Package | Description |
|---------|-------------|
| [`@sandbank.dev/core`](./packages/core) | Provider abstraction, capability system, error types |
| [`@sandbank.dev/skills`](./packages/skills) | Skill registry and local filesystem loader |
| [`@sandbank.dev/workspace`](./packages/workspace) | Durable workspace protocol, checkpoints, and sandbox materialization helpers |
| [`@sandbank.dev/daytona`](./packages/daytona) | Daytona cloud sandbox adapter |
| [`@sandbank.dev/flyio`](./packages/flyio) | Fly.io Machines adapter |
| [`@sandbank.dev/cloudflare`](./packages/cloudflare) | Cloudflare Workers adapter |
| [`@sandbank.dev/boxlite`](./packages/boxlite) | BoxLite self-hosted Docker adapter |
| [`@sandbank.dev/e2b`](./packages/e2b) | E2B cloud sandbox adapter |
| [`@sandbank.dev/db9`](./packages/db9) | db9.ai serverless PostgreSQL adapter (ServiceProvider) |
| [`@sandbank.dev/relay`](./packages/relay) | WebSocket relay for multi-agent communication |
| [`@sandbank.dev/agent`](./packages/agent) | Lightweight client for agents running inside sandboxes |

## Provider Support

### Core Operations

All providers implement these — the minimum contract:

| Operation | Daytona | Fly.io | Cloudflare | BoxLite | E2B |
|-----------|:-------:|:------:|:----------:|:-------:|:---:|
| Create / Destroy | ✅ | ✅ | ✅ | ✅ | ✅ |
| List sandboxes | ✅ | ✅ | ✅ | ✅ | ✅ |
| Execute commands | ✅ | ✅ | ✅ | ✅ | ✅ |
| Read / Write files | ✅ | ✅ | ✅ | ✅ | ✅ |
| Skill injection | ✅ | ✅ | ✅ | ✅ | ✅ |

### Extended Capabilities

Capabilities are opt-in. Use `withVolumes(provider)`, `withPortExpose(sandbox)`, etc. to safely check and access them at runtime.

| Capability | Daytona | Fly.io | Cloudflare | BoxLite | E2B | db9 | Description |
|------------|:-------:|:------:|:----------:|:-------:|:---:|:---:|-------------|
| `volumes` | ✅ | ✅ | ⚠️* | ❌ | ⚠️*** | — | Persistent volume management |
| `port.expose` | ✅ | ✅ | ⚠️** | ✅ | ✅ | — | Expose sandbox ports to the internet |
| `exec.stream` | ❌ | ❌ | ✅ | ✅ | ❌ | — | Stream stdout/stderr in real-time |
| `snapshot` | ❌ | ❌ | ✅ | ✅ | ❌ | — | Snapshot and restore sandbox state |
| `terminal` | ✅ | ✅ | ✅ | ✅ | ✅ | — | Interactive web terminal (ttyd) |
| `sleep` | ❌ | ❌ | ❌ | ✅ | ✅ | — | Hibernate and wake sandboxes |
| `skills` | ✅ | ✅ | ✅ | ✅ | ✅ | — | Load and inject skill definitions into sandboxes |
| `services` | ❌ | ❌ | ❌ | ❌ | ❌ | ✅ | Bind data services (PostgreSQL) to sandboxes |

\* Cloudflare `volumes` requires `storage` option in adapter config.

\*\* Cloudflare reserves port 3000 for its sandbox control plane. Use any port in 1024–65535 except 3000.

\*\*\* E2B volumes require E2B volume beta access. Sandbank mounts volumes by connecting the Sandbank volume `id` to an E2B `Volume`.

### Provider Characteristics

| | Daytona | Fly.io | Cloudflare | BoxLite | E2B |
|---|---------|--------|------------|---------|-----|
| **Runtime** | Full VM | Firecracker microVM | V8 isolate + container | Docker container | E2B cloud sandbox |
| **Cold start** | ~10s | ~3-5s | ~1s | ~2-5s | Provider-managed |
| **File I/O** | Native SDK | Via exec (base64) | Native SDK | Via exec (base64) | Native SDK |
| **Regions** | Multi | Multi | Global edge | Self-hosted | E2B managed |
| **External deps** | `@daytonaio/sdk` | None (pure fetch) | `@cloudflare/sandbox` | BoxLite API | `e2b` |

## Multi-Agent Sessions

Sandbank includes a built-in orchestration layer for multi-agent workflows. The **Relay** handles real-time messaging and shared context between sandboxes.

```typescript
import { createSession } from '@sandbank.dev/core'

const session = await createSession({
  provider,
  relay: { type: 'memory' },
})

// Spawn agents in isolated sandboxes
const architect = await session.spawn('architect', {
  image: 'node:22',
  env: { ROLE: 'architect' },
})

const developer = await session.spawn('developer', {
  image: 'node:22',
  env: { ROLE: 'developer' },
})

// Shared context — all agents can read/write
await session.context.set('spec', { endpoints: ['/users', '/posts'] })

// Wait for all agents to complete
await session.waitForAll()
await session.close()
```

Inside the sandbox, agents use `@sandbank.dev/agent`:

```typescript
import { connect } from '@sandbank.dev/agent'

const session = await connect() // reads SANDBANK_* env vars

session.on('message', async (msg) => {
  if (msg.type === 'task') {
    // do work...
    await session.send(msg.from, 'done', result)
  }
})

await session.complete({ status: 'success', summary: 'Built 5 API endpoints' })
```

## Provider-Neutral Workspaces

Provider-native volumes are provider-specific resources. A Fly.io volume, E2B volume, Daytona volume, and Cloudflare storage binding are not the same durable disk. For seamless provider switching, keep durable state in a `WorkspaceAdapter`, materialize it into the sandbox before execution, then sync changed files back and checkpoint the workspace.

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

Use provider-native volumes as local cache or provider-local persistence. Use workspace checkpoints for portable rollback and cross-provider continuity.

## Provider Scheduler And Preflight

The top-level `sandbank` package exports `selectSandboxProvider`, `preflightWorkspaceSandboxTask`, and `runWorkspaceSandboxTask`. The scheduler treats sandbox providers as compute candidates and selects one by declared capabilities such as `runtime.python`, `runtime.codex`, `codex.exec`, `codex.goal`, `workspace.snapshot`, and `workspace.live`.

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

Static preflight checks workspace and provider capabilities before execution. Runtime preflight creates a temporary sandbox and probes image tools such as `python`, `codex`, `git`, `tmux`, `tar`, and `gzip`. `codex.goal` starts a vas-style `tmux` session and leaves the sandbox alive for terminal attach and later workspace sync. See [Provider Scheduler And Workspace Consistency](./docs/provider-scheduler-workspace.md) and [Sandbank Agent Configuration](./docs/sandbank-agent-configuration.md).

## Agent Tool Use

Sandbank Tool Use is a lower-level protocol than any single model adapter. A model loop, Dynamic Worker capsule, or hosted agent submits a structured `tool.use` request; the Agent Supervisor checks the agent's tool/resource policy before any handler or sandbox provider is invoked.

```typescript
import {
  AgentSupervisor,
  ToolUseRegistry,
  createCloudflareResourceTool,
  createSandboxPythonTool,
} from 'sandbank'

const registry = new ToolUseRegistry()
  .register(createCloudflareResourceTool('read', async input => {
    // Connect this handler to Cloudflare D1/KV/R2/etc. bindings or APIs.
    return { ok: true, resource: input.resource }
  }))
  .register(createSandboxPythonTool())

const supervisor = new AgentSupervisor({
  agentId: 'agent-a',
  workspace,
  modelId: 'deepseek-v4-pro',
  toolUse: {
    registry,
    sandboxProviders: [
      { provider: e2bProvider, capabilities: ['runtime.python'] },
      { provider: boxliteProvider, capabilities: ['runtime.python'] },
    ],
    policy: {
      allowedTools: ['cloudflare.resource.read', 'sandbox.python'],
      resources: [
        { kind: 'cloudflare.d1', id: 'analytics', actions: ['read'] },
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

Resource grants are the agent enablement whitelist. If a prompt asks the agent to mutate a user database, the request must still match an allowed resource/action and any matching approval rule before execution. `sandbox.python` uses the provider scheduler, so generated Python can run on E2B, BoxLite, Sandbank Cloud, or another provider that advertises the required runtime capability. Dynamic Worker capsules receive the same path through `SANDBANK_TOOLS.list()` and `SANDBANK_TOOLS.use(request)`, which forwards back to the supervisor instead of bypassing policy.

## Quick Start

```bash
# Install
pnpm add @sandbank.dev/core @sandbank.dev/daytona  # or @sandbank.dev/flyio, @sandbank.dev/cloudflare, @sandbank.dev/e2b

# Set up provider
export DAYTONA_API_KEY=your-key
```

```typescript
import { createProvider } from '@sandbank.dev/core'
import { DaytonaAdapter } from '@sandbank.dev/daytona'

const provider = createProvider(
  new DaytonaAdapter({ apiKey: process.env.DAYTONA_API_KEY! })
)

// Create a sandbox
const sandbox = await provider.create({
  image: 'node:22',
  resources: { cpu: 2, memory: 2048 },
  autoDestroyMinutes: 30,
})

// Run commands
const { stdout } = await sandbox.exec('node --version')

// File operations
await sandbox.writeFile('/app/index.js', 'console.log("hi")')
await sandbox.exec('node /app/index.js')

// Clean up
await provider.destroy(sandbox.id)
```

## Development

```bash
git clone https://github.com/chekusu/sandbank.git
cd sandbank
pnpm install

# Run all unit tests
pnpm test

# Run cross-provider conformance tests
pnpm test:conformance

# Typecheck
pnpm typecheck
```

### DB-native Harness API

The `sandbank` CLI and Worker entrypoint expose a public Sandbank harness API backed by the Agent Supervisor, db9 workspace storage, and DeepSeek V4 Pro:

```bash
DB9_DATABASE_ID=... DB9_TOKEN=... DEEPSEEK_API_KEY=... \
  vas dev sandbank-harness pnpm --filter ./packages/sandbank exec tsx src/cli/index.ts harness-api --host 0.0.0.0 --port 8789
```

Routes:

- `GET /health`
- `GET /api/db-native-agent-harness/capabilities`
- `POST /api/sandbank-agent-harness/stream`
- `POST /api/db-native-agent-harness/stream`

The stream emits generic Sandbank SSE events, persists run input/output under `/runs/...`, records supervisor state/audit data under `/agents/...`, creates a checkpoint when the workspace backend supports it, and defaults to `deepseek-v4-pro`. It also stores agent memories under `/agents/{agentId}/memory/memories.jsonl`, recalls active `pinned` / `insight` / `session` entries into the model prompt, and writes explicit `remember` / `记住` requests as pinned memories. The Worker-compatible entrypoint is exported as `sandbank/harness-worker`; the Node CLI is for service hosting through `vas dev` or an equivalent deployment path, not as a localhost-only preview. Model, Workspace, provider, and image requirements are summarized in [Sandbank Agent Configuration](./docs/sandbank-agent-configuration.md).

Benchmark a live harness with one prompt:

```bash
pnpm --filter ./packages/sandbank exec tsx src/cli/index.ts harness-benchmark \
  --base-url https://your-sandbank-worker.example \
  --question "@agent run a Sandbank harness health check" \
  --json
```

Run the default benchmark suite:

```bash
SANDBANK_HARNESS_BASE_URL=https://your-sandbank-worker.example pnpm bench:harness -- --json
```

The benchmark posts each case to `/api/db-native-agent-harness/stream`, records the SSE timeline, and scores every run out of 100 across transport, lifecycle events, workspace persistence, Dynamic Worker capsule execution, model streaming, case expectations, and latency.

### Running Integration Tests

Integration tests hit real APIs and are gated by environment variables:

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

## Test Coverage

| Package | Stmts | Branch | Funcs | Lines | Unit | Integration |
|---------|:-----:|:------:|:-----:|:-----:|:----:|:-----------:|
| `@sandbank.dev/core` | 84% | 77% | 74% | 88% | 98 | — |
| `@sandbank.dev/db9` | 100% | 97% | 93% | 100% | 35 | 3 |

Run coverage locally:

```bash
pnpm --filter @sandbank.dev/db9 test -- --coverage
```

## Design Principles

1. **Minimal interface, maximum interop** — only the true common denominator (exec + files + lifecycle)
2. **Explicit over implicit** — no auto-fallback, no caching, no hidden retries
3. **Capability detection, not fake implementations** — if a provider doesn't support it, it errors
4. **Idempotent operations** — destroying an already-destroyed sandbox is a no-op
5. **Full decoupling** — provider layer and session layer are independent, compose freely

## License

MIT
