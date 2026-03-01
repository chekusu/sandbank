# @sandbank/flyio

> Fly.io Machines sandbox adapter for [Sandbank](../../README.md).

Zero external SDK dependencies — uses the Fly.io Machines REST API directly via `fetch`.

## Install

```bash
pnpm add @sandbank/core @sandbank/flyio
```

## Usage

```typescript
import { createProvider } from '@sandbank/core'
import { FlyioAdapter } from '@sandbank/flyio'

const provider = createProvider(
  new FlyioAdapter({
    apiToken: process.env.FLY_API_TOKEN!,
    appName: 'my-sandbox-pool',
    region: 'nrt', // optional
  })
)

const sandbox = await provider.create({
  image: 'node:22-slim',
  resources: { cpu: 1, memory: 512 },
})

const { stdout } = await sandbox.exec('node --version')
await provider.destroy(sandbox.id)
```

## Capabilities

| Capability | Supported |
|------------|:---------:|
| `terminal` | ✅ |
| `volumes` | ✅ |
| `port.expose` | ✅ |

## Characteristics

- **Runtime:** Firecracker microVM
- **Cold start:** ~3-5s
- **File I/O:** Via exec (base64)
- **Region:** Multi
- **External deps:** None (pure fetch)

## License

MIT
