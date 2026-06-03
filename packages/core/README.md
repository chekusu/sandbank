# @sandbank.dev/core

> Unified sandbox SDK for AI agents — provider abstraction, capability system, and error types.

## Install

```bash
pnpm add @sandbank.dev/core
```

## Usage

```typescript
import { createProvider, withTerminal, connectTerminal } from '@sandbank.dev/core'
import { DaytonaAdapter } from '@sandbank.dev/daytona'

const provider = createProvider(
  new DaytonaAdapter({ apiKey: process.env.DAYTONA_API_KEY! })
)

// Create a sandbox with a non-root user
const sandbox = await provider.create({
  image: 'node:22',
  user: 'sandbank',            // creates non-root user with sudo
})
const { stdout } = await sandbox.exec('node --version')
await sandbox.writeFile('/app/index.js', 'console.log("hi")')

// Run privileged commands with asRoot
await sandbox.exec('apt-get update', { asRoot: true })

// Capability detection
const terminal = withTerminal(sandbox)
if (terminal) {
  const info = await terminal.startTerminal()
  const session = connectTerminal(info)
  await session.ready
  session.onData((data) => process.stdout.write(data))
  session.write('ls\n')
}

await provider.destroy(sandbox.id)
```

## Capabilities

Use `hasCapability(provider, name)` to check provider support, and `withTerminal(sandbox)` / `withStreaming(sandbox)` / etc. for type-safe downcasting.

| Capability | Description |
|------------|-------------|
| `exec.stream` | Real-time stdout/stderr streaming |
| `terminal` | Interactive web terminal (ttyd) |
| `sleep` | Hibernate and wake sandboxes |
| `volumes` | Persistent volume management |
| `snapshot` | Snapshot and restore sandbox state |
| `port.expose` | Expose sandbox ports to the internet |

## Multi-Agent Sessions

```typescript
import { createSession } from '@sandbank.dev/core'

const session = await createSession({ provider, relay: { type: 'memory' } })
const agent = await session.spawn('worker', { image: 'node:22' })
await session.waitForAll()
await session.close()
```

## Provider Image Catalogs

Use `resolveProviderCreateConfig` when one logical image needs different provider-specific values, such as a Docker image for Daytona/Fly.io, an E2B template, or a BoxLite OCI image path.

```typescript
import { resolveProviderCreateConfig } from '@sandbank.dev/core'

const images = {
  'agent-node': {
    default: 'ghcr.io/acme/agent-node:2026.06',
    providers: {
      e2b: 'agent-node-e2b-template',
      boxlite: '/var/lib/boxlite/images/agent-node.oci',
    },
  },
}

const config = resolveProviderCreateConfig(
  { image: 'agent-node', env: { RUN_ID: 'run-1' } },
  provider.name,
  images,
)

const sandbox = await provider.create(config)
```

## License

MIT
