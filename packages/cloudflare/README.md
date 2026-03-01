# @sandbank/cloudflare

> Cloudflare Workers sandbox adapter for [Sandbank](../../README.md).

## Install

```bash
pnpm add @sandbank/core @sandbank/cloudflare
```

## Usage

```typescript
import { createProvider } from '@sandbank/core'
import { CloudflareAdapter } from '@sandbank/cloudflare'

const adapter = new CloudflareAdapter({
  namespace: env.SANDBOX,       // DurableObject binding
  hostname: 'myapp.dev',
  sleepAfter: '30m',
  storage: {                    // enables volumes capability
    endpoint: 'https://xxx.r2.cloudflarestorage.com',
    provider: 'r2',
  },
})

const provider = createProvider(adapter)
const sandbox = await provider.create({ image: 'node:22' })
const { stdout } = await sandbox.exec('echo hello')
await provider.destroy(sandbox.id)
```

## Capabilities

| Capability | Supported |
|------------|:---------:|
| `exec.stream` | ✅ |
| `terminal` | ✅ |
| `port.expose` | ✅ |
| `snapshot` | ✅ |
| `volumes` | ✅ (with `storage` config) |

## Characteristics

- **Runtime:** V8 isolate + container
- **Cold start:** ~1s
- **File I/O:** Native SDK
- **Region:** Global edge
- **Dependency:** `@cloudflare/sandbox`

## License

MIT
