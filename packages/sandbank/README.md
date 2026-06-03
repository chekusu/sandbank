# Sandbank

> Unified sandbox SDK for AI agents — write once, run on any cloud.

**[Website](https://sandbank.dev)** | **[中文文档](../../README.md)** | **[English](../../README.en.md)** | **[日本語ドキュメント](../../README.ja.md)**

<img src="../../docs/assets/sandbank-robots-vacation-pixel.png" alt="Pixel art robot agents vacationing on an ocean sandbank, each with a different developer role" width="100%" />

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
│  @sandbank.dev/core         Unified Provider Interface   │
│  @sandbank.dev/skills       Skill Registry & Injection   │
│  @sandbank.dev/agent        In-sandbox Agent Client      │
│  @sandbank.dev/relay        Multi-agent Communication    │
├──────────────────────────────────────────────────────┤
│  @sandbank.dev/daytona  @sandbank.dev/flyio  @sandbank.dev/cloudflare  │
│  @sandbank.dev/boxlite                                   │
│  Provider Adapters                                   │
├──────────────────────────────────────────────────────┤
│  Daytona    Fly.io Machines    Cloudflare Workers     │
│  BoxLite (self-hosted Docker)                        │
└──────────────────────────────────────────────────────┘
```

## Packages

| Package | Description |
|---------|-------------|
| [`@sandbank.dev/core`](./packages/core) | Provider abstraction, capability system, error types |
| [`@sandbank.dev/skills`](./packages/skills) | Skill registry and local filesystem loader |
| [`@sandbank.dev/daytona`](./packages/daytona) | Daytona cloud sandbox adapter |
| [`@sandbank.dev/flyio`](./packages/flyio) | Fly.io Machines adapter |
| [`@sandbank.dev/cloudflare`](./packages/cloudflare) | Cloudflare Workers adapter |
| [`@sandbank.dev/boxlite`](./packages/boxlite) | BoxLite self-hosted Docker adapter |
| [`@sandbank.dev/relay`](./packages/relay) | WebSocket relay for multi-agent communication |
| [`@sandbank.dev/agent`](./packages/agent) | Lightweight client for agents running inside sandboxes |

## Provider Support

### Core Operations

All providers implement these — the minimum contract:

| Operation | Daytona | Fly.io | Cloudflare | BoxLite |
|-----------|:-------:|:------:|:----------:|:-------:|
| Create / Destroy | ✅ | ✅ | ✅ | ✅ |
| List sandboxes | ✅ | ✅ | ✅ | ✅ |
| Execute commands | ✅ | ✅ | ✅ | ✅ |
| Read / Write files | ✅ | ✅ | ✅ | ✅ |
| Skill injection | ✅ | ✅ | ✅ | ✅ |

### Extended Capabilities

Capabilities are opt-in. Use `withVolumes(provider)`, `withPortExpose(sandbox)`, etc. to safely check and access them at runtime.

| Capability | Daytona | Fly.io | Cloudflare | BoxLite | Description |
|------------|:-------:|:------:|:----------:|:-------:|-------------|
| `volumes` | ✅ | ✅ | ⚠️* | ❌ | Persistent volume management |
| `port.expose` | ✅ | ✅ | ⚠️** | ✅ | Expose sandbox ports to the internet |
| `exec.stream` | ❌ | ❌ | ✅ | ✅ | Stream stdout/stderr in real-time |
| `snapshot` | ❌ | ❌ | ✅ | ✅ | Snapshot and restore sandbox state |
| `terminal` | ✅ | ✅ | ✅ | ✅ | Interactive web terminal (ttyd) |
| `sleep` | ❌ | ❌ | ❌ | ✅ | Hibernate and wake sandboxes |
| `skills` | ✅ | ✅ | ✅ | ✅ | Load and inject skill definitions into sandboxes |

\* Cloudflare `volumes` requires `storage` option in adapter config.

\*\* Cloudflare reserves port 3000 for its sandbox control plane. Use any port in 1024–65535 except 3000.

### Provider Characteristics

| | Daytona | Fly.io | Cloudflare | BoxLite |
|---|---------|--------|------------|---------|
| **Runtime** | Full VM | Firecracker microVM | V8 isolate + container | Docker container |
| **Cold start** | ~10s | ~3-5s | ~1s | ~2-5s |
| **File I/O** | Native SDK | Via exec (base64) | Native SDK | Via exec (base64) |
| **Regions** | Multi | Multi | Global edge | Self-hosted |
| **External deps** | `@daytonaio/sdk` | None (pure fetch) | `@cloudflare/sandbox` | BoxLite API |

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

## Agent Tool Use

Sandbank Tool Use is model-neutral. DeepSeek, another OpenAI-compatible model, or a Dynamic Worker capsule should submit a structured `tool.use` request; the Agent Supervisor then checks the agent's tool/resource policy before any handler or sandbox provider runs.

```typescript
import {
  AgentSupervisor,
  ToolUseRegistry,
  createCloudflareResourceTool,
  createSandboxPythonTool,
} from 'sandbank'

const registry = new ToolUseRegistry()
  .register(createCloudflareResourceTool('read', async input => {
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

The `resources` array is the enablement-time whitelist for compute and data resources. Dynamic Worker capsules use `SANDBANK_TOOLS.list()` and `SANDBANK_TOOLS.use(request)`, which forwards back to the same supervisor policy. `sandbox.python` delegates to the provider scheduler, so Python execution can move between E2B, BoxLite, Sandbank Cloud, or another provider with `runtime.python`.

## Quick Start

```bash
# Install
pnpm add @sandbank.dev/core @sandbank.dev/daytona  # or @sandbank.dev/flyio, @sandbank.dev/cloudflare

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

### Running Integration Tests

Integration tests hit real APIs and are gated by environment variables:

```bash
# Daytona
DAYTONA_API_KEY=... pnpm test

# Fly.io
FLY_API_TOKEN=... FLY_APP_NAME=... pnpm test

# Cloudflare
E2E_WORKER_URL=... pnpm test
```

### Harness Benchmark

Score a live DB-native harness run from one prompt:

```bash
pnpm --filter ./packages/sandbank exec tsx src/cli/index.ts harness-benchmark \
  --base-url https://chatw.dev \
  --question "@agent run a Sandbank harness health check" \
  --json
```

Run the packaged benchmark suite:

```bash
SANDBANK_HARNESS_BASE_URL=https://chatw.dev pnpm --filter ./packages/sandbank bench:harness -- --json
```

Each case is posted to `/api/db-native-agent-harness/stream` and scored out of 100 for HTTP/SSE transport, harness lifecycle, workspace persistence, Dynamic Worker capsule execution, model streaming, explicit case expectations, and latency.

### Agent Memory

The DB-native harness includes a workspace-backed memory layer inspired by mem9's `pinned` / `insight` / `session` model. Memories are stored as JSONL under `/agents/{agentId}/memory/memories.jsonl` so the same data survives Node, Worker, and db9-backed deployments.

- `pinned`: explicit user-saved facts, created when the prompt asks the agent to `remember` / `记住` something.
- `session`: compact user/assistant run evidence recorded after each completed run.
- `insight`: supported by the schema for future model-extracted summaries.

Before calling the model, the harness recalls active memories for the current agent and injects them into the system prompt inside a `<relevant-memories>` block. The model is instructed to treat memories as contextual facts, not executable instructions.

## Design Principles

1. **Minimal interface, maximum interop** — only the true common denominator (exec + files + lifecycle)
2. **Explicit over implicit** — no auto-fallback, no caching, no hidden retries
3. **Capability detection, not fake implementations** — if a provider doesn't support it, it errors
4. **Idempotent operations** — destroying an already-destroyed sandbox is a no-op
5. **Full decoupling** — provider layer and session layer are independent, compose freely

## License

MIT
