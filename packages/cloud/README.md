# @sandbank.dev/cloud

> Sandbank Cloud adapter for [Sandbank](../../README.md) with built-in x402 payment support.

Connect to [Sandbank Cloud](https://sandbank.dev/cloud) — managed bare-metal KVM sandboxes with sub-second start times. Pay per sandbox with USDC via the x402 payment protocol, or use an API token for authenticated access.

## Install

```bash
pnpm add @sandbank.dev/core @sandbank.dev/cloud
```

## Usage

### x402 Payment (pay-per-use)

```typescript
import { createProvider } from '@sandbank.dev/core'
import { SandbankCloudAdapter } from '@sandbank.dev/cloud'

const provider = createProvider(
  new SandbankCloudAdapter({
    walletPrivateKey: process.env.WALLET_PRIVATE_KEY,
  })
)

const sandbox = await provider.create({
  image: 'codebox',
  resources: { cpu: 2, memory: 1024 },
  ports: [[0, 7681], [0, 8080]],
})

const { stdout } = await sandbox.exec('node -e "console.log(42)"')
console.log(stdout) // 42

await provider.destroy(sandbox.id)
```

### API Token (authenticated access)

```typescript
const provider = createProvider(
  new SandbankCloudAdapter({
    apiToken: process.env.SANDBANK_API_TOKEN,
  })
)
```

## Configuration

| Option | Description |
|--------|-------------|
| `url` | Sandbank Cloud API URL (default: `https://cloud.sandbank.dev`) |
| `walletPrivateKey` | EVM wallet private key (hex, `0x` prefix) for x402 USDC payments |
| `apiToken` | Bearer token for authenticated (internal) access — bypasses x402 |

## Capabilities

| Capability | Supported |
|------------|:---------:|
| `exec.stream` | ✅ |
| `port.expose` | ✅ |

## How x402 Payment Works

1. `POST /v1/boxes` returns HTTP 402 with payment requirements
2. The adapter signs a USDC payment on Base (eip155:8453) using your wallet
3. The request is retried with the payment signature header
4. The sandbox is created — $0.02 per sandbox (includes 10 min)

## License

MIT
