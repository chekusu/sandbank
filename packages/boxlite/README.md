# @sandbank.dev/boxlite

> BoxLite bare-metal micro-VM sandbox adapter for [Sandbank](../../README.md).

BoxLite provides lightweight micro-VMs using libkrun (Hypervisor.framework on macOS, KVM on Linux). This adapter supports two modes of operation:

- **Remote mode** — Connect to a [BoxRun](https://github.com/nicholasgasior/boxlite) REST API server
- **Local mode** — Run VMs directly on the local machine via the boxlite Python SDK

## Install

```bash
pnpm add @sandbank.dev/core @sandbank.dev/boxlite
```

For local mode, you also need the boxlite Python package:

```bash
pip install boxlite
```

## Usage

### Remote mode (BoxRun REST API)

```typescript
import { createProvider } from '@sandbank.dev/core'
import { BoxLiteAdapter } from '@sandbank.dev/boxlite'

const provider = createProvider(
  new BoxLiteAdapter({
    apiUrl: 'http://localhost:9090',
    apiToken: process.env.BOXLITE_API_TOKEN,
    prefix: 'default', // multi-tenant prefix (optional)
  })
)

const sandbox = await provider.create({
  image: 'ubuntu:24.04',
  resources: { cpu: 2, memory: 1024 },
})

const { stdout } = await sandbox.exec('uname -a')
await provider.destroy(sandbox.id)
```

### Local mode (Python SDK)

```typescript
import { createProvider } from '@sandbank.dev/core'
import { BoxLiteAdapter } from '@sandbank.dev/boxlite'

const provider = createProvider(
  new BoxLiteAdapter({
    mode: 'local',
    pythonPath: '/usr/bin/python3', // optional, defaults to 'python3'
    boxliteHome: '~/.boxlite',     // optional
  })
)

const sandbox = await provider.create({ image: 'ubuntu:24.04' })
const { stdout } = await sandbox.exec('echo hello')
await provider.destroy(sandbox.id)
```

### OAuth2 authentication (remote mode)

```typescript
new BoxLiteAdapter({
  apiUrl: 'http://boxrun.example.com:9090',
  clientId: process.env.BOXLITE_CLIENT_ID,
  clientSecret: process.env.BOXLITE_CLIENT_SECRET,
})
```

## Capabilities

| Capability | Remote | Local |
|------------|:------:|:-----:|
| `exec.stream` | ✅ | ✅ |
| `terminal` | ✅ | ✅ |
| `sleep` | ✅ | ✅ |
| `port.expose` | ✅ | ✅ |
| `snapshot` | ✅ | — |

## Characteristics

- **Runtime:** Micro-VM (libkrun)
- **Cold start:** ~3-5s
- **File I/O:** tar archive upload/download
- **Hypervisor:** Hypervisor.framework (macOS) / KVM (Linux)
- **Local dependency:** `boxlite` Python package (local mode only)

## Architecture

```
┌─────────────────────────────────────┐
│         BoxLiteAdapter              │
│  mode: 'remote' | 'local'          │
├──────────────┬──────────────────────┤
│ REST Client  │  Local Client        │
│ (fetch)      │  (Python subprocess) │
├──────────────┼──────────────────────┤
│ BoxRun API   │  boxlite Python SDK  │
│ (HTTP/JSON)  │  (JSON-line bridge)  │
└──────────────┴──────────────────────┘
```

## License

MIT
