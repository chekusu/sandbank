# Sandbank Agent Configuration

[English](./sandbank-agent-configuration.md) | [中文](./sandbank-agent-configuration.zh-CN.md) | [日本語](./sandbank-agent-configuration.ja.md)

This guide covers the configuration developers need before running a Sandbank Agent. Sandbank is a workspace-native agent harness: the durable agent state lives in a `WorkspaceAdapter`, while concrete work is dispatched to the best available execution backend for that task. The lower-level sandbox SDK remains part of the stack, but the product-level contract is the harness that keeps workspace state portable across providers.

The main execution roles are:

- The DB-native agent harness (`sandbank harness-api`) calls a model, persists run state, memory, artifacts, and audit data in a Workspace, and can invoke bounded Dynamic Worker capsules.
- Tool Use and code mode expose host-registered capabilities to the agent through policy-checked bindings.
- The provider scheduler (`runWorkspaceSandboxTask`) dispatches concrete compute tasks, such as generated Python or Codex runs, into configured sandbox providers and syncs their outputs back into the same Workspace.

## Required Configuration

| Area | Required for | Required settings |
|------|--------------|-------------------|
| Model | DB-native harness model calls | `SANDBANK_DEEPSEEK_API_KEY` or `DEEPSEEK_API_KEY` |
| Workspace | Durable agent state, run files, checkpoints, memory, artifacts | `DB9_DATABASE_ID` and `DB9_TOKEN`, unless `createWorkspace` is injected |
| Provider | Sandbox compute tasks outside Dynamic Worker | At least one configured `SandboxProviderCandidate` whose capabilities match the task |
| Image/runtime | Provider-dispatched tasks | A logical image mapping or direct image that contains the required tools |

Provider configuration is not required for the basic DB-native harness if the agent only uses the model, Workspace, Tool Use handlers, and Dynamic Worker bindings. It is required when the agent needs to execute Python, Codex, or other commands in a sandbox provider. In both cases, the Workspace remains the durable source of truth; provider-local files and volumes are temporary execution state unless synced back.

For general-purpose sandbox execution, prefer Sandbank Cloud first. Sandbank Cloud is the hosted BoxLite provider operated by Sandbank; use the other providers when you need a specific external backend, a self-hosted BoxLite deployment, or provider-specific capabilities.

## Model Configuration

The harness currently uses a DeepSeek-compatible chat completions API.

| Setting | Required | Default | Notes |
|---------|:--------:|---------|-------|
| `SANDBANK_DEEPSEEK_API_KEY` | One key required | — | Preferred Sandbank harness model key |
| `DEEPSEEK_API_KEY` | One key required | — | Fallback model key |
| `OPENAI_API_KEY` | Conditional | — | Used only when `SANDBANK_DEEPSEEK_USE_OPENAI_ENV=1` or `OPENAI_BASE_URL` points at a DeepSeek/OpenRouter/gateway endpoint |
| `SANDBANK_DEEPSEEK_MODEL` | No | `deepseek-v4-pro` | Preferred model override |
| `DEEPSEEK_MODEL` | No | `deepseek-v4-pro` | Fallback model override |
| `SANDBANK_DEEPSEEK_BASE_URL` | No | `https://api.deepseek.com` | Preferred compatible API base URL |
| `DEEPSEEK_BASE_URL` | No | `https://api.deepseek.com` | Fallback compatible API base URL |
| `OPENAI_BASE_URL` | Conditional | — | Used only under the same OpenAI-env condition as `OPENAI_API_KEY` |

The `model` object in an incoming chat request is preserved as UI metadata; the actual backend model used by the harness is selected from these environment variables.

## Workspace Configuration

The Workspace is the durable state boundary. It stores run inputs/outputs, audit logs, checkpoints, artifacts, memory, and agent state. Provider-local files and volumes are not treated as canonical cross-provider state. The harness materializes Workspace files into a sandbox when needed, then syncs or merges the result back so later tasks can continue on another backend.

| Setting | Required | Notes |
|---------|:--------:|-------|
| `DB9_DATABASE_ID` | Yes | db9 workspace database id |
| `DB9_TOKEN` | Yes | db9 API token |
| `DB9_BASE_URL` | No | Overrides the db9 API base URL |

For tests or custom deployments, pass `createWorkspace` to the harness dependencies instead of using db9 environment variables.

## Harness Server Configuration

```bash
DB9_DATABASE_ID=...
DB9_TOKEN=...
DEEPSEEK_API_KEY=...
DEEPSEEK_MODEL=deepseek-v4-pro \
  sandbank harness-api --host 0.0.0.0 --port 8789
```

| Setting | Required | Default | Notes |
|---------|:--------:|---------|-------|
| `SANDBANK_HARNESS_HOST` | No | `0.0.0.0` | CLI `--host` overrides it |
| `SANDBANK_HARNESS_PORT` | No | `8789` | CLI `--port` overrides it; `PORT` is also accepted |
| `SANDBANK_HARNESS_API_KEY` | No | — | Enables bearer-token auth |

## Dynamic Worker Configuration

Dynamic Worker capsules are optional. They run bounded JavaScript code and receive scoped `SANDBANK_WORKSPACE` and `SANDBANK_RUNTIME` bindings. They are not a full VM, shell, Python runtime, or Codex runtime.

| Setting | Required | Default | Notes |
|---------|:--------:|---------|-------|
| `SANDBANK_DYNAMIC_WORKER_TIMEOUT_MS` | No | `15000` | Capsule timeout |
| `SANDBANK_DYNAMIC_WORKER_CPU_MS` | No | Provider default | CPU budget when supported |
| `SANDBANK_DYNAMIC_WORKER_SUBREQUESTS` | No | Provider default | Subrequest budget when supported |

## Tool Registration And Code Mode

Tool registration is controlled by the host application, not by arbitrary end users. A third-party caller creates a `ToolUseRegistry`, registers definitions such as `createCloudflareResourceTool`, `createSearchCodeRunTool`, and `createSandboxPythonTool`, then enables the exact tools/resources for each agent run through `toolUse.policy`.

`search.code.run` is the Dynamic Worker code mode tool. It runs a JavaScript function body and exposes controlled bindings as `ctx.search`, `ctx.workspace`, and `ctx.runtime`. Enable it only when the agent policy grants the required resources:

- `dynamic_worker.execution:execute`
- `runtime.javascript:execute`
- `external.search:{provider}:query`
- `http.egress:{host}:fetch` for each allowed outbound host
- `workspace.path:{artifactRoot}:write` for generated artifacts

The tool denies raw outbound access by default and expects search/fetch behavior to come from the registered host-side search provider.

## Provider Scheduler Configuration

Use provider scheduling when a task needs a sandbox provider. The scheduler is the bridge between the durable Workspace and interchangeable execution backends. The required input is:

- `workspace`: a `WorkspaceAdapter`
- `providers`: one or more `SandboxProviderCandidate`
- `task`: a `command`, `python`, `codex.exec`, or `codex.goal` task
- `imageCatalog`: optional logical-image mappings
- `consistency`: optional workspace consistency policy
- `preflight`: optional runtime probe settings

```typescript
import { createProvider } from '@sandbank.dev/core'
import { SandbankCloudAdapter } from '@sandbank.dev/cloud'
import { E2BAdapter } from '@sandbank.dev/e2b'
import { DaytonaAdapter } from '@sandbank.dev/daytona'
import { MemoryWorkspaceAdapter } from '@sandbank.dev/workspace'
import {
  preflightWorkspaceSandboxTask,
  runWorkspaceSandboxTask,
} from 'sandbank'

const workspace = new MemoryWorkspaceAdapter()

const providers = [
  {
    provider: createProvider(new SandbankCloudAdapter({ apiToken: process.env.SANDBANK_API_TOKEN })),
    capabilities: ['runtime.python', 'runtime.codex', 'codex.exec', 'codex.goal'],
    priority: 30,
  },
  {
    provider: createProvider(new E2BAdapter({ apiKey: process.env.E2B_API_KEY })),
    capabilities: ['runtime.python'],
    priority: 20,
  },
  {
    provider: createProvider(new DaytonaAdapter({ apiKey: process.env.DAYTONA_API_KEY! })),
    capabilities: ['runtime.python', 'runtime.codex', 'codex.exec', 'codex.goal'],
    priority: 10,
  },
]

const imageCatalog = {
  'python-agent': {
    default: 'ghcr.io/acme/python-agent:2026.06',
    providers: {
      'sandbank-cloud': 'python:3.12-slim',
      e2b: 'python-agent-e2b-template',
    },
  },
  'codex-agent': {
    default: 'ghcr.io/acme/codex-agent:2026.06',
  },
}

const task = {
  kind: 'python' as const,
  path: '/workspace/generated/task.py',
  image: 'python-agent',
}

const preflight = await preflightWorkspaceSandboxTask({
  workspace,
  providers,
  task,
  imageCatalog,
  preflight: { runtime: true },
})

if (!preflight.ok) throw new Error(preflight.errors.join('; '))

await runWorkspaceSandboxTask({
  workspace,
  providers,
  task,
  imageCatalog,
  consistency: { mode: 'branch-merge', conflictResolution: 'keep-both' },
  preflight: { runtime: true },
})
```

## Provider Credentials

| Provider | Typical required configuration |
|----------|--------------------------------|
| Sandbank Cloud | `SANDBANK_API_TOKEN` for authenticated access, or `WALLET_PRIVATE_KEY` for x402 pay-per-use; optional `SANDBANK_CLOUD_URL` |
| Daytona | `DAYTONA_API_KEY`; optional `DAYTONA_API_URL` |
| Fly.io | `FLY_API_TOKEN`, `FLY_APP_NAME`; optional `FLY_REGION` |
| Cloudflare | Worker Durable Object binding such as `env.SANDBOX`; optional storage config for volumes |
| BoxLite remote | `BOXLITE_API_URL` plus `BOXLITE_API_TOKEN` or OAuth2 client credentials |
| BoxLite local | local `boxlite` Python package; optional `pythonPath` and `boxliteHome` |
| E2B | `E2B_API_KEY`; logical images map to E2B templates |

## Image Requirements

For snapshot workspace sync, images should have `tar` and `gzip`. Runtime tasks need the corresponding toolchain:

- Python tasks: `python`
- Codex exec: `codex`, `git`, `tar`, `gzip`
- Codex goal: `codex`, `tmux`, `bash`, `git`, `gh`, `tar`, `gzip`
- Live workspace mounts: a Sandbank workspace client, daemon, or equivalent filesystem bridge

`preflight: { runtime: true }` creates a temporary sandbox and probes these tools before the real task materializes the Workspace.

## Required vs Optional Summary

Required for a live DB-native harness:

- Model API key
- Workspace backend or injected Workspace adapter

Required for provider-dispatched execution:

- At least one provider adapter with credentials
- Task-compatible provider capabilities
- Task-compatible image/runtime
- Workspace capabilities required by the selected consistency mode

Optional:

- Harness bearer auth
- Custom model name and base URL
- Dynamic Worker limits
- Provider image catalog
- Runtime preflight probes
- Provider-native volumes as cache or provider-local persistence
