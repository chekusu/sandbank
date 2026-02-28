# Sandbank

> Unified sandbox SDK for AI agents — write once, run on any cloud.

Sandbank provides a single TypeScript interface for creating, managing, and orchestrating cloud sandboxes. Switch between providers without changing your application code.

**[中文文档](./README.zh-CN.md)** | **[日本語ドキュメント](./README.ja.md)**

## Why Sandbank?

AI agents need isolated execution environments. But every cloud provider has a different API — Daytona, Fly.io, Cloudflare Workers all speak different languages. Sandbank unifies them behind one interface:

```typescript
import { createProvider } from '@sandbank/core'
import { DaytonaAdapter } from '@sandbank/daytona'

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
│  @sandbank/core         Unified Provider Interface   │
│  @sandbank/agent        In-sandbox Agent Client      │
│  @sandbank/relay        Multi-agent Communication    │
├──────────────────────────────────────────────────────┤
│  @sandbank/daytona   @sandbank/flyio   @sandbank/cloudflare │
│  Provider Adapters                                   │
├──────────────────────────────────────────────────────┤
│  Daytona           Fly.io Machines    Cloudflare Workers    │
└──────────────────────────────────────────────────────┘
```

## Packages

| Package | Description |
|---------|-------------|
| [`@sandbank/core`](./packages/core) | Provider abstraction, capability system, error types |
| [`@sandbank/daytona`](./packages/daytona) | Daytona cloud sandbox adapter |
| [`@sandbank/flyio`](./packages/flyio) | Fly.io Machines adapter |
| [`@sandbank/cloudflare`](./packages/cloudflare) | Cloudflare Workers adapter |
| [`@sandbank/relay`](./packages/relay) | WebSocket relay for multi-agent communication |
| [`@sandbank/agent`](./packages/agent) | Lightweight client for agents running inside sandboxes |

## Provider Support

### Core Operations

All providers implement these — the minimum contract:

| Operation | Daytona | Fly.io | Cloudflare |
|-----------|:-------:|:------:|:----------:|
| Create / Destroy | ✅ | ✅ | ✅ |
| List sandboxes | ✅ | ✅ | ✅ |
| Execute commands | ✅ | ✅ | ✅ |
| Read / Write files | ✅ | ✅ | ✅ |

### Extended Capabilities

Capabilities are opt-in. Use `withVolumes(provider)`, `withPortExpose(sandbox)`, etc. to safely check and access them at runtime.

| Capability | Daytona | Fly.io | Cloudflare | Description |
|------------|:-------:|:------:|:----------:|-------------|
| `volumes` | ✅ | ✅ | ✅ | Persistent volume management |
| `port.expose` | ✅ | ✅ | ✅ | Expose sandbox ports to the internet |
| `exec.stream` | ❌ | ❌ | ✅ | Stream stdout/stderr in real-time |
| `snapshot` | ❌ | ❌ | ✅ | Snapshot and restore sandbox state |
| `terminal` | ❌ | ❌ | ❌ | Interactive web terminal |
| `sleep` | ❌ | ❌ | ❌ | Hibernate and wake sandboxes |

### Provider Characteristics

| | Daytona | Fly.io | Cloudflare |
|---|---------|--------|------------|
| **Runtime** | Full VM | Firecracker microVM | V8 isolate + container |
| **Cold start** | ~10s | ~3-5s | ~1s |
| **File I/O** | Native SDK | Via exec (base64) | Native SDK |
| **Regions** | Multi | Multi | Global edge |
| **External deps** | `@daytonaio/sdk` | None (pure fetch) | `@cloudflare/sandbox` |

## Multi-Agent Sessions

Sandbank includes a built-in orchestration layer for multi-agent workflows. The **Relay** handles real-time messaging and shared context between sandboxes.

```typescript
import { createSession } from '@sandbank/core'

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

Inside the sandbox, agents use `@sandbank/agent`:

```typescript
import { connect } from '@sandbank/agent'

const session = await connect() // reads SANDBANK_* env vars

session.on('message', async (msg) => {
  if (msg.type === 'task') {
    // do work...
    await session.send(msg.from, { type: 'done', payload: result })
  }
})

await session.complete({ status: 'success', summary: 'Built 5 API endpoints' })
```

## Quick Start

```bash
# Install
pnpm add @sandbank/core @sandbank/daytona  # or @sandbank/flyio, @sandbank/cloudflare

# Set up provider
export DAYTONA_API_KEY=your-key
```

```typescript
import { createProvider } from '@sandbank/core'
import { DaytonaAdapter } from '@sandbank/daytona'

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
git clone https://github.com/anthropics/sandbank.dev.git
cd sandbank.dev
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

## Design Principles

1. **Minimal interface, maximum interop** — only the true common denominator (exec + files + lifecycle)
2. **Explicit over implicit** — no auto-fallback, no caching, no hidden retries
3. **Capability detection, not fake implementations** — if a provider doesn't support it, it errors
4. **Idempotent operations** — destroying an already-destroyed sandbox is a no-op
5. **Full decoupling** — provider layer and session layer are independent, compose freely

## License

MIT
