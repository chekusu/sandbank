# Sandbank

> Unified sandbox SDK for AI agents — write once, run on any cloud.

**[Website](https://sandbank.dev)** | **[中文文档](https://github.com/chekusu/sandbank/blob/main/README.zh-CN.md)** | **[日本語ドキュメント](https://github.com/chekusu/sandbank/blob/main/README.ja.md)**

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

On the `db-native-agent-harness` branch, the `sandbank` CLI and Worker entrypoint expose a chatw.dev-compatible harness API backed by the Agent Supervisor, db9 workspace storage, and DeepSeek V4 Pro:

```bash
DB9_DATABASE_ID=... DB9_TOKEN=... DEEPSEEK_API_KEY=... \
  vas dev sandbank-harness pnpm --filter ./packages/sandbank exec tsx src/cli/index.ts harness-api --host 0.0.0.0 --port 8789
```

Routes:

- `GET /health`
- `GET /api/db-native-agent-harness/capabilities`
- `POST /api/db-native-agent-harness/stream`

The stream emits chatw.dev SSE events, persists run input/output under `/runs/...`, records supervisor state/audit data under `/agents/...`, creates a checkpoint when the workspace backend supports it, and defaults to `deepseek-v4-pro`. The Worker-compatible entrypoint is exported as `sandbank/harness-worker`; the Node CLI is for service hosting through `vas dev` or an equivalent deployment path, not as a localhost-only preview.

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
