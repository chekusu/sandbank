# Sandbank Agent 設定

[English](./sandbank-agent-configuration.md) | [中文](./sandbank-agent-configuration.zh-CN.md) | [日本語](./sandbank-agent-configuration.ja.md)

このガイドは、開発者が Sandbank Agent を実行する前に必要な設定をまとめたものです。Sandbank には関連する実行レイヤーが二つあります。

- DB-native agent harness（`sandbank harness-api`）：モデルを呼び出し、実行状態を Workspace に永続化し、制限付き Dynamic Worker capsule を呼び出せます。
- provider scheduler（`runWorkspaceSandboxTask`）：生成された Python や Codex 実行などの具体的な計算タスクを、設定済み sandbox provider に派遣します。

## 必須設定

| 領域 | 用途 | 必須設定 |
|------|------|----------|
| モデル | DB-native harness のモデル呼び出し | `SANDBANK_DEEPSEEK_API_KEY` または `DEEPSEEK_API_KEY` |
| Workspace | Agent 状態、run ファイル、checkpoint、memory、artifact の永続化 | `DB9_DATABASE_ID` と `DB9_TOKEN`。ただし `createWorkspace` を注入する場合は不要 |
| Provider | Dynamic Worker 以外の sandbox 計算タスク | タスクに合う capability を持つ `SandboxProviderCandidate` が少なくとも一つ |
| イメージ/runtime | provider に派遣するタスク | 必要なツールを含む論理イメージマッピング、または直接指定するイメージ |

Agent がモデル、Workspace、Dynamic Worker binding だけを使う基本的な DB-native harness では、sandbox provider の設定は不要です。Python、Codex、その他のコマンドを provider 内で実行する場合に provider 設定が必要になります。

## モデル設定

harness は現在 DeepSeek-compatible chat completions API を使用します。

| 設定 | 必須 | デフォルト | 説明 |
|------|:----:|------------|------|
| `SANDBANK_DEEPSEEK_API_KEY` | どちらか必須 | — | 優先される Sandbank harness モデル key |
| `DEEPSEEK_API_KEY` | どちらか必須 | — | fallback モデル key |
| `OPENAI_API_KEY` | 条件付き | — | `SANDBANK_DEEPSEEK_USE_OPENAI_ENV=1`、または `OPENAI_BASE_URL` が DeepSeek/OpenRouter/gateway endpoint を指す場合のみ使用 |
| `SANDBANK_DEEPSEEK_MODEL` | いいえ | `deepseek-v4-pro` | 優先モデル override |
| `DEEPSEEK_MODEL` | いいえ | `deepseek-v4-pro` | fallback モデル override |
| `SANDBANK_DEEPSEEK_BASE_URL` | いいえ | `https://api.deepseek.com` | 優先 compatible API base URL |
| `DEEPSEEK_BASE_URL` | いいえ | `https://api.deepseek.com` | fallback compatible API base URL |
| `OPENAI_BASE_URL` | 条件付き任意 | — | `OPENAI_API_KEY` と同じ条件で使用 |

受信した chat request の `model` オブジェクトは UI metadata として保持されます。harness が実際に呼び出すバックエンドモデルは、これらの環境変数で決まります。

## Workspace 設定

Workspace は永続状態の境界です。run input/output、audit log、checkpoint、artifact、Agent 状態を保存します。provider ローカルファイルや provider volume は、provider をまたぐ正準状態ではありません。

| 設定 | 必須 | 説明 |
|------|:----:|------|
| `DB9_DATABASE_ID` | はい | db9 workspace database id |
| `DB9_TOKEN` | はい | db9 API token |
| `DB9_BASE_URL` | いいえ | db9 API base URL を上書き |

テストやカスタムデプロイでは、db9 の環境変数ではなく harness deps に `createWorkspace` を渡せます。

## Harness サーバー設定

```bash
DB9_DATABASE_ID=...
DB9_TOKEN=...
DEEPSEEK_API_KEY=...
DEEPSEEK_MODEL=deepseek-v4-pro \
  sandbank harness-api --host 0.0.0.0 --port 8789
```

| 設定 | 必須 | デフォルト | 説明 |
|------|:----:|------------|------|
| `SANDBANK_HARNESS_HOST` | いいえ | `0.0.0.0` | CLI `--host` が優先 |
| `SANDBANK_HARNESS_PORT` | いいえ | `8789` | CLI `--port` が優先。`PORT` も使用可能 |
| `SANDBANK_HARNESS_API_KEY` | いいえ | — | bearer-token 認証を有効化 |

## Dynamic Worker 設定

Dynamic Worker capsule は任意です。制限付き JavaScript を実行し、scoped `SANDBANK_WORKSPACE` と `SANDBANK_RUNTIME` binding を受け取ります。完全な VM、shell、Python runtime、Codex runtime ではありません。

| 設定 | 必須 | デフォルト | 説明 |
|------|:----:|------------|------|
| `SANDBANK_DYNAMIC_WORKER_TIMEOUT_MS` | いいえ | `15000` | capsule timeout |
| `SANDBANK_DYNAMIC_WORKER_CPU_MS` | いいえ | provider デフォルト | 対応している場合の CPU budget |
| `SANDBANK_DYNAMIC_WORKER_SUBREQUESTS` | いいえ | provider デフォルト | 対応している場合の subrequest budget |

## Tool 登録と Code Mode

Tool 登録は host application が制御します。任意の end user が runtime に remote 登録する仕組みではありません。第三者の呼び出し側は `ToolUseRegistry` を作成し、`createCloudflareResourceTool`、`createSearchCodeRunTool`、`createSandboxPythonTool` などの定義を登録したうえで、`toolUse.policy` により各 agent run で使える tool/resource を明示的に有効化します。

`search.code.run` は Dynamic Worker code mode tool です。JavaScript function body を実行し、制御された binding を `ctx.search`、`ctx.workspace`、`ctx.runtime` として公開します。有効化する場合、agent policy には必要に応じて次の resource grant を与えてください。

- `dynamic_worker.execution:execute`
- `runtime.javascript:execute`
- `external.search:{provider}:query`
- 許可する outbound host ごとの `http.egress:{host}:fetch`
- artifact 生成先の `workspace.path:{artifactRoot}:write`

この tool は raw outbound をデフォルトで拒否し、検索/取得処理は host 側で登録した search provider から提供される想定です。

## Provider Scheduler 設定

タスクに sandbox provider が必要な場合は provider scheduler を使います。必須入力は次のとおりです。

- `workspace`：`WorkspaceAdapter`
- `providers`：一つ以上の `SandboxProviderCandidate`
- `task`：`command`、`python`、`codex.exec`、または `codex.goal`
- `imageCatalog`：任意の論理イメージマッピング
- `consistency`：任意の Workspace 一貫性ポリシー
- `preflight`：任意の runtime probe 設定

```typescript
import { createProvider } from '@sandbank.dev/core'
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

## Provider 認証情報

| Provider | 一般的な必須設定 |
|----------|------------------|
| Daytona | `DAYTONA_API_KEY`。任意で `DAYTONA_API_URL` |
| Fly.io | `FLY_API_TOKEN`、`FLY_APP_NAME`。任意で `FLY_REGION` |
| Cloudflare | `env.SANDBOX` などの Worker Durable Object binding。volume には任意の storage config |
| BoxLite remote | `BOXLITE_API_URL` と、`BOXLITE_API_TOKEN` または OAuth2 client credentials |
| BoxLite local | ローカルの `boxlite` Python package。任意で `pythonPath` と `boxliteHome` |
| E2B | `E2B_API_KEY`。論理イメージは E2B template にマップされます |

## イメージ要件

snapshot workspace sync には、イメージ内に `tar` と `gzip` が必要です。runtime タスクには対応するツールチェーンも必要です。

- Python タスク：`python`
- Codex exec：`codex`、`git`、`tar`、`gzip`
- Codex goal：`codex`、`tmux`、`bash`、`git`、`gh`、`tar`、`gzip`
- live workspace mount：Sandbank workspace client、daemon、または同等の filesystem bridge

`preflight: { runtime: true }` は、実タスクの Workspace を materialize する前に一時 sandbox を作成してこれらのツールを probe します。

## 必須/任意のまとめ

live DB-native harness に必須：

- モデル API key
- Workspace backend、または注入された Workspace adapter

provider-dispatched execution に必須：

- 認証情報付き provider adapter が少なくとも一つ
- タスクに合う provider capability
- タスクに合うイメージ/runtime
- 選択した一貫性モードに必要な Workspace capability

任意：

- Harness bearer auth
- カスタムモデル名と base URL
- Dynamic Worker limits
- Provider image catalog
- Runtime preflight probe
- provider-native volume。cache または provider-local persistence として使用
