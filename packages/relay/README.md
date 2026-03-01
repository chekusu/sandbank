# @sandbank/relay

> WebSocket relay server for multi-agent communication in [Sandbank](../../README.md).

Provides HTTP (long-polling) and WebSocket transport with JSON-RPC 2.0 protocol for real-time messaging and shared context between sandboxes.

## Install

```bash
pnpm add @sandbank/relay
```

## Usage

Usually used internally by `createSession()` from `@sandbank/core`, but can be started standalone:

```typescript
import { startRelay } from '@sandbank/relay'

const relay = await startRelay({ port: 4000 })
console.log(relay.wsUrl) // ws://127.0.0.1:4000

// Later...
await relay.close()
```

## Protocol

- **Transport:** HTTP `POST /rpc` + WebSocket, dual-channel
- **Format:** JSON-RPC 2.0
- **Auth:** `X-Session-Id` + `X-Auth-Token` headers

### RPC Methods

| Method | Description |
|--------|-------------|
| `session.auth` | WebSocket authentication |
| `message.send` | Point-to-point messaging |
| `message.broadcast` | Broadcast to all agents |
| `message.recv` | Pull messages (supports long-polling) |
| `context.get/set/delete/keys` | Shared context CRUD |
| `sandbox.complete` | Mark agent as completed |

## License

MIT
