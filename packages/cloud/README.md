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

## Lifecycle Webhooks

Sandbank Cloud supports operator-managed lifecycle webhooks for box status changes. Tenants do not register these through the SDK today. To receive tenant notifications, send your Sandbank tenant id, webhook URL, and optional secret/token to the Sandbank Cloud operator.

Tenant ids must match the `user_id` stored on boxes. For API-key based tenants, this is the label in `AGENT_API_KEYS`, for example `AGENT_API_KEYS=wanman:key`.

Supported tenant events:

- `box.error`
- `box.terminated`
- `box.status_changed`

Tenant webhook payloads are sanitized and omit admin-only fields such as node id, source, and internal detail:

```json
{
  "event": "box.error",
  "audience": "tenant",
  "tenant_id": "wanman",
  "box_id": "box-1",
  "image": "codebox",
  "previous_status": "running",
  "status": "error",
  "reason": "probe_failure",
  "observed_at": "2026-05-01T05:41:00.000Z"
}
```

Requests include `X-Sandbank-Tenant`, `X-Sandbank-Event`, and `X-Sandbank-Delivery`. If a tenant secret is configured, Sandbank sends `X-Sandbank-Signature: sha256=<hmac-sha256>` using HMAC-SHA256 over the exact JSON body. If a token is configured, Sandbank sends `Authorization: Bearer <token>`.

Operator-side configuration examples:

```bash
ADMIN_BOX_LIFECYCLE_WEBHOOK_URL=https://ops.example.com/webhooks/sandbank
ADMIN_BOX_LIFECYCLE_WEBHOOK_TOKEN=change-me
ADMIN_BOX_LIFECYCLE_WEBHOOK_TIMEOUT_MS=2000
```

Legacy `BOX_LIFECYCLE_WEBHOOK_*` variables are still accepted as fallbacks, but `ADMIN_BOX_LIFECYCLE_WEBHOOK_*` is preferred for new deployments.

```bash
TENANT_BOX_LIFECYCLE_WEBHOOKS='{
  "wanman": {
    "url": "https://wanman.example.com/webhooks/sandbank",
    "secret": "wanman-hmac-secret",
    "token": "optional-bearer-token",
    "events": ["box.error", "box.terminated"],
    "timeout_ms": 1500
  }
}'
TENANT_BOX_LIFECYCLE_WEBHOOK_TIMEOUT_MS=2000
```

## License

MIT
