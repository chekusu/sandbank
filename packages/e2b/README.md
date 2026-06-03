# @sandbank.dev/e2b

> E2B cloud sandbox adapter for [Sandbank](../../README.md).

This adapter uses the current `e2b` JavaScript SDK. Sandbank's `image` field maps to an E2B template name or template ID.

## Install

```bash
pnpm add @sandbank.dev/core @sandbank.dev/e2b
```

## Usage

```typescript
import { createProvider, withSleep, withVolumes } from '@sandbank.dev/core'
import { E2BAdapter } from '@sandbank.dev/e2b'

const provider = createProvider(
  new E2BAdapter({
    apiKey: process.env.E2B_API_KEY,
    defaultTimeoutMs: 60 * 60 * 1000,
  })
)

const volumes = withVolumes(provider)
const volume = await volumes?.createVolume({ name: 'agent-data' })

const sandbox = await provider.create({
  image: 'base',
  env: { NODE_ENV: 'development' },
  volumes: volume ? [{ id: volume.id, mountPath: '/mnt/data' }] : undefined,
})

await sandbox.exec('echo "persisted" > /mnt/data/state.txt')

const sleep = withSleep(sandbox)
await sleep?.sleep()
await sleep?.wake()

const state = await sandbox.readFile('/mnt/data/state.txt')
console.log(new TextDecoder().decode(state))
```

## Capabilities

| Capability | Supported | Notes |
|------------|:---------:|-------|
| `terminal` | ✅ | Starts `ttyd` in the sandbox |
| `volumes` | ⚠️ | Requires E2B volume beta access |
| `sleep` | ✅ | Uses E2B pause/connect |
| `port.expose` | ✅ | Uses E2B sandbox hostnames |
| `snapshot` | ❌ | E2B can create snapshots, but Sandbank's current snapshot interface expects same-sandbox restore |
| `exec.stream` | ❌ | Not exposed by this adapter yet |

## Persistence Semantics

- If `autoDestroyMinutes` is set, the adapter configures E2B to kill the sandbox at that timeout.
- If `autoDestroyMinutes` is omitted or `0`, the adapter configures E2B to pause on timeout with auto-resume enabled.
- Files on E2B volumes persist beyond sandbox lifecycles. Files only in the sandbox filesystem follow E2B sandbox lifecycle rules.

## License

MIT
