# Daytona REST Mode Design

Add REST API mode to the Daytona adapter, enabling use in Cloudflare Workers and other edge environments where the `@daytonaio/sdk` cannot run.

## Problem

The current Daytona adapter depends entirely on `@daytonaio/sdk`, which requires a full Node.js environment (Buffer, Node streams, etc.). This prevents use in Cloudflare Workers, Deno, and other edge runtimes.

## Solution

Dual-mode architecture (same pattern as BoxLite v0.3.0):

- `mode: 'sdk'` (default) — existing behavior, uses `@daytonaio/sdk`
- `mode: 'rest'` — pure `fetch`, zero Node.js dependencies

## Config

```typescript
interface DaytonaSDKConfig {
  mode?: 'sdk'
  apiKey: string
  apiUrl?: string
  target?: string
}

interface DaytonaRestConfig {
  mode: 'rest'
  apiKey: string
  apiUrl?: string        // default: 'https://app.daytona.io/api'
  toolboxUrl?: string    // auto-derived from apiUrl
}

type DaytonaAdapterConfig = DaytonaSDKConfig | DaytonaRestConfig
```

## File Structure

```
src/
  index.ts          — exports (unchanged)
  adapter.ts        — refactored to use DaytonaClient interface
  types.ts          — new: DaytonaClient interface + API types
  sdk-client.ts     — new: SDK implementation wrapping @daytonaio/sdk
  rest-client.ts    — new: REST implementation using fetch
```

## REST Endpoints

| Method | Endpoint | Purpose |
|--------|----------|---------|
| POST   | /api/sandbox | Create sandbox |
| GET    | /api/sandbox/{id} | Get sandbox |
| GET    | /api/sandbox | List sandboxes |
| DELETE | /api/sandbox/{id} | Delete sandbox |
| POST   | /toolbox/{id}/execute | Execute command |
| POST   | /toolbox/{id}/files/upload | Upload file |
| GET    | /toolbox/{id}/files/download?path=... | Download file |
| Volume endpoints | /api/volume/* | Volume CRUD |

Two API layers:
- Control Plane: `https://app.daytona.io/api/...`
- Toolbox Proxy: `https://proxy.app.daytona.io/toolbox/{sandboxId}/...`

Auth: `Authorization: Bearer {apiKey}` on all requests.

## Package Changes

- `@daytonaio/sdk`: dependencies → peerDependencies (optional) + devDependencies
- REST mode users have zero extra dependencies

## Testing

- Unit tests: mock fetch for REST client, mock SDK for SDK client, mock DaytonaClient for adapter
- Integration tests: run both modes against real Daytona API (requires DAYTONA_API_KEY)
- Target: 100% line/function coverage
