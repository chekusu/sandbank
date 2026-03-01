# @sandbank/core

> Unified sandbox SDK for AI agents — provider abstraction, capability system, and error types.

## Install

```bash
pnpm add @sandbank/core
```

## Usage

```typescript
import { createProvider, withTerminal, connectTerminal } from '@sandbank/core'
import { DaytonaAdapter } from '@sandbank/daytona'

const provider = createProvider(
  new DaytonaAdapter({ apiKey: process.env.DAYTONA_API_KEY! })
)

// Create and use a sandbox
const sandbox = await provider.create({ image: 'node:22' })
const { stdout } = await sandbox.exec('node --version')
await sandbox.writeFile('/app/index.js', 'console.log("hi")')

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
import { createSession } from '@sandbank/core'

const session = await createSession({ provider, relay: { type: 'memory' } })
const agent = await session.spawn('worker', { image: 'node:22' })
await session.waitForAll()
await session.close()
```

## License

MIT
