# @sandbank.dev/agent

> Lightweight client for AI agents running inside [Sandbank](../../README.md) sandboxes.

Connects to the relay server via WebSocket, enabling messaging, shared context, and task completion signaling.

## Install

```bash
pnpm add @sandbank.dev/agent
```

## Usage

Runs inside a sandbox. Connection parameters are read from `SANDBANK_*` environment variables injected by `createSession()`:

```typescript
import { connect } from '@sandbank.dev/agent'

const session = await connect()

// Listen for messages
session.on('message', async (msg) => {
  if (msg.type === 'task') {
    const result = await doWork(msg.payload)
    await session.send(msg.from, 'done', result)
  }
})

// Shared context
const spec = await session.context.get('spec')
await session.context.set('output', { files: ['index.ts'] })

// Signal completion
await session.complete({ status: 'success', summary: 'Built 5 endpoints' })
session.close()
```

## CLI

Also available as a CLI tool for shell scripts inside sandboxes:

```bash
sandbank-agent send <to> <type> [payload]
sandbank-agent recv [--wait 5000]
sandbank-agent context get <key>
sandbank-agent context set <key> <value>
sandbank-agent complete <status> <summary>
```

## Environment Variables

| Variable | Description |
|----------|-------------|
| `SANDBANK_WS_URL` | Relay WebSocket URL |
| `SANDBANK_SESSION_ID` | Session identifier |
| `SANDBANK_SANDBOX_NAME` | This agent's sandbox name |
| `SANDBANK_AUTH_TOKEN` | Authentication token |

## License

MIT
