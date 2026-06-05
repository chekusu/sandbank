# Sandbank

> AI エージェント向け統一 Workspace Agent Harness — 1つの Workspace、複数の実行バックエンド。

Sandbank は AI Agent 向けの workspace-native harness です。Agent identity、memory、artifact、audit log、file、checkpoint を `Workspace` プロトコルに保持し、具体的な実行タスクを Sandbank Cloud、Dynamic Worker、E2B、BoxLite、Fly.io、Daytona、Cloudflare Workers などの sandbox backend に dispatch します。低レベル provider SDK は単独でも利用できますが、Sandbank の上位抽象は provider をまたいで Workspace state を同期する Agent Harness です。汎用 compute backend としては、Sandbank の hosted BoxLite cloud service である Sandbank Cloud をデフォルト推奨します。

**[ウェブサイト](https://sandbank.dev)** | **[English](./README.en.md)** | **[中文文档](./README.md)**

<img src="./docs/assets/sandbank-robots-vacation-pixel.png" alt="ピクセルアート風の海の sandbank で休暇を過ごす小さなロボット Agent たち。それぞれが異なる開発者ロールを持つ" width="100%" />

## なぜ Sandbank?

AI エージェントに必要なのは隔離された sandbox だけではありません。model turn、tool call、provider switch、retry をまたいで継続できる、復元可能で監査可能な長期 Workspace が必要です。Sandbank は sandbox を execution capsule として扱います。短い JavaScript code mode は Cloudflare Dynamic Worker で実行し、Python、Codex、shell task はデフォルトで Sandbank Cloud（hosted BoxLite）を優先し、特殊な要件がある場合だけ E2B、セルフホスト BoxLite、Fly.io、VM/container に切り替え、出力は同じ Workspace に同期します。

低レベル sandbox provider SDK は引き続き利用でき、Daytona、Fly.io、Cloudflare Workers などの API 差分を隠蔽します：

```typescript
import { createProvider } from '@sandbank.dev/core'
import { SandbankCloudAdapter } from '@sandbank.dev/cloud'

const provider = createProvider(new SandbankCloudAdapter({
  apiToken: process.env.SANDBANK_API_TOKEN,
}))
const sandbox = await provider.create({ image: 'node:22' })

const result = await sandbox.exec('echo "Hello from the sandbox"')
console.log(result.stdout) // Hello from the sandbox

await provider.destroy(sandbox.id)
```

Sandbank Cloud は推奨デフォルト provider です。`SandbankCloudAdapter` を `DaytonaAdapter`、`FlyioAdapter`、`CloudflareAdapter` に差し替えても sandbox create/exec のコードを書き換える必要はありません。harness 層では、各 provider を Agent の永続的な居場所ではなく compute backend として扱います。

## アーキテクチャ

```
┌──────────────────────────────────────────────────────┐
│  アプリケーション / AI エージェント / Third-party caller │
├──────────────────────────────────────────────────────┤
│  sandbank                   Workspace Agent Harness      │
│  AgentSupervisor            policy / memory / tool use   │
│  Provider Scheduler         backend dispatch + sync      │
│  @sandbank.dev/workspace    永続 Workspace と Checkpoint │
├──────────────────────────────────────────────────────┤
│  @sandbank.dev/core         低レベル Provider SDK         │
│  @sandbank.dev/skills       スキルレジストリ・インジェクション │
│  @sandbank.dev/agent        サンドボックス内エージェント      │
│  @sandbank.dev/relay        マルチエージェント通信            │
├──────────────────────────────────────────────────────┤
│  @sandbank.dev/cloud    @sandbank.dev/boxlite  @sandbank.dev/e2b       │
│  @sandbank.dev/daytona  @sandbank.dev/flyio    @sandbank.dev/cloudflare│
│  プロバイダーアダプター（Compute）                         │
├──────────────────────────────────────────────────────┤
│  @sandbank.dev/db9       Service Adapter（Data）      │
├──────────────────────────────────────────────────────┤
│  Sandbank Cloud (hosted BoxLite)    BoxLite (セルフホスト Docker) │
│  E2B Cloud Sandboxes    Daytona    Fly.io Machines    Cloudflare Workers │
│  db9.ai (PostgreSQL)                                  │
└──────────────────────────────────────────────────────┘
```

## パッケージ一覧

| パッケージ | 説明 |
|-----------|------|
| [`sandbank`](./packages/sandbank) | Workspace Agent Harness、Agent Supervisor、Tool Use、provider scheduler、CLI/Worker entrypoints |
| [`@sandbank.dev/core`](./packages/core) | 低レベル Provider SDK、ケイパビリティシステム、エラー型 |
| [`@sandbank.dev/skills`](./packages/skills) | スキルレジストリ、ローカルファイルシステムローダー |
| [`@sandbank.dev/workspace`](./packages/workspace) | 永続 Workspace プロトコル、checkpoint、sandbox materialize/sync helper |
| [`@sandbank.dev/cloud`](./packages/cloud) | Sandbank Cloud hosted BoxLite cloud adapter。推奨デフォルト provider。API token または x402 payment に対応 |
| [`@sandbank.dev/daytona`](./packages/daytona) | Daytona クラウドサンドボックスアダプター |
| [`@sandbank.dev/flyio`](./packages/flyio) | Fly.io Machines アダプター |
| [`@sandbank.dev/cloudflare`](./packages/cloudflare) | Cloudflare Workers アダプター |
| [`@sandbank.dev/boxlite`](./packages/boxlite) | BoxLite セルフホスト Docker アダプター |
| [`@sandbank.dev/e2b`](./packages/e2b) | E2B クラウドサンドボックスアダプター |
| [`@sandbank.dev/db9`](./packages/db9) | db9.ai serverless PostgreSQL アダプター (`ServiceProvider`) |
| [`@sandbank.dev/relay`](./packages/relay) | マルチエージェント通信用 WebSocket リレー |
| [`@sandbank.dev/agent`](./packages/agent) | サンドボックス内エージェント軽量クライアント |

## プロバイダーサポート

### 基本操作

すべてのプロバイダーが実装する最小契約：

| 操作 | Sandbank Cloud | Daytona | Fly.io | Cloudflare | BoxLite | E2B |
|------|:--------------:|:-------:|:------:|:----------:|:-------:|:---:|
| 作成 / 破棄 | ✅ | ✅ | ✅ | ✅ | ✅ | ✅ |
| サンドボックス一覧 | ✅ | ✅ | ✅ | ✅ | ✅ | ✅ |
| コマンド実行 | ✅ | ✅ | ✅ | ✅ | ✅ | ✅ |
| ファイル読み書き | ✅ | ✅ | ✅ | ✅ | ✅ | ✅ |
| スキル注入 | ✅ | ✅ | ✅ | ✅ | ✅ | ✅ |

### 拡張ケイパビリティ

ケイパビリティはオプトインです。`withVolumes(provider)` や `withPortExpose(sandbox)` 等で実行時に安全に検出・アクセスできます。

| ケイパビリティ | Sandbank Cloud | Daytona | Fly.io | Cloudflare | BoxLite | E2B | db9 | 説明 |
|--------------|:--------------:|:-------:|:------:|:----------:|:-------:|:---:|:---:|------|
| `volumes` | ❌ | ✅ | ✅ | ⚠️* | ❌ | ⚠️*** | — | 永続ボリューム管理 |
| `port.expose` | ✅ | ✅ | ✅ | ⚠️** | ✅ | ✅ | — | サンドボックスポートをインターネットに公開 |
| `exec.stream` | ✅ | ❌ | ❌ | ✅ | ✅ | ❌ | — | stdout/stderr のリアルタイムストリーミング |
| `snapshot` | ❌ | ❌ | ❌ | ✅ | ✅ | ❌ | — | サンドボックス状態のスナップショットと復元 |
| `terminal` | ❌ | ✅ | ✅ | ✅ | ✅ | ✅ | — | インタラクティブ Web ターミナル (ttyd) |
| `sleep` | ❌ | ❌ | ❌ | ❌ | ✅ | ✅ | — | サンドボックスの休止と復帰 |
| `skills` | ✅ | ✅ | ✅ | ✅ | ✅ | ✅ | — | スキル定義をサンドボックスにロード・注入 |
| `services` | ❌ | ❌ | ❌ | ❌ | ❌ | ❌ | ✅ | データサービス (PostgreSQL) をサンドボックスへバインド |

\* Cloudflare の `volumes` はアダプター設定で `storage` オプションが必要です。

\*\* Cloudflare はポート 3000 をサンドボックスのコントロールプレーンに予約しています。1024–65535（3000 を除く）の範囲で指定してください。

\*\*\* E2B volumes は現在 E2B volume beta アクセスが必要です。Sandbank はボリューム `id` で E2B `Volume` に接続してマウントします。

### プロバイダー特性比較

| | Sandbank Cloud | Daytona | Fly.io | Cloudflare | BoxLite | E2B |
|---|----------------|---------|--------|------------|---------|-----|
| **位置づけ** | 推奨デフォルト provider | Cloud sandbox | VM/microVM | Edge Worker | セルフホスト BoxLite | Cloud sandbox |
| **ランタイム** | Hosted BoxLite containers | フル VM | Firecracker マイクロ VM | V8 アイソレート + コンテナ | Docker コンテナ | E2B クラウドサンドボックス |
| **コールドスタート** | Managed-service optimized | ~10 秒 | ~3-5 秒 | ~1 秒 | ~2-5 秒 | Provider 管理 |
| **ファイル I/O** | Archive API | ネイティブ SDK | exec 経由 (base64) | ネイティブ SDK | exec 経由 (base64) | ネイティブ SDK |
| **リージョン** | Sandbank-managed | マルチ | マルチ | グローバルエッジ | セルフホスト | E2B 管理 |
| **外部依存** | `@sandbank.dev/cloud` + API token/x402 | `@daytonaio/sdk` | なし (純粋 fetch) | `@cloudflare/sandbox` | BoxLite API | `e2b` |

## マルチエージェントセッション

Sandbank にはマルチエージェントワークフロー用のオーケストレーション層が組み込まれています。**Relay** がサンドボックス間のリアルタイムメッセージングと共有コンテキストを担当します。

```typescript
import { createSession } from '@sandbank.dev/core'

const session = await createSession({
  provider,
  relay: { type: 'memory' },
})

// 隔離されたサンドボックスでエージェントを起動
const architect = await session.spawn('architect', {
  image: 'node:22',
  env: { ROLE: 'architect' },
})

const developer = await session.spawn('developer', {
  image: 'node:22',
  env: { ROLE: 'developer' },
})

// 共有コンテキスト — すべてのエージェントが読み書き可能
await session.context.set('spec', { endpoints: ['/users', '/posts'] })

// すべてのエージェントの完了を待機
await session.waitForAll()
await session.close()
```

サンドボックス内では、エージェントは `@sandbank.dev/agent` を使用します：

```typescript
import { connect } from '@sandbank.dev/agent'

const session = await connect() // SANDBANK_* 環境変数を自動読み取り

session.on('message', async (msg) => {
  if (msg.type === 'task') {
    // タスクを実行...
    await session.send(msg.from, 'done', result)
  }
})

await session.complete({ status: 'success', summary: '5つのAPIエンドポイントを構築' })
```

## Workspace Agent Harness

Sandbank の harness は `WorkspaceAdapter` を Agent の authoritative state boundary とします。1回の agent run では、まず model が計画し、Dynamic Worker で bounded JavaScript code mode を実行し、生成された Python を Workspace に書き込み、provider scheduler が Sandbank Cloud を優先して選択します。policy に応じて E2B、BoxLite、Daytona、Fly.io など `runtime.python` を宣言する backend に切り替えることもでき、最後に artifact、log、memory、checkpoint を同じ Workspace に永続化します。

この構造により、呼び出し側は compute backend を差し替えられます。Agent の長期 state を特定の VM、container、volume、Workers storage binding に固定する必要はありません。権限境界も harness 層に集約されます。Tool Use request は host-registered tool や sandbox provider を呼び出す前に、agent policy、resource grants、approval rules を通過します。

## Provider-Neutral Workspaces

Provider-native volume は provider-specific なリソースです。Fly.io volume、E2B volume、Daytona volume、Cloudflare storage binding は同じ永続ディスクではありません。プロバイダーを切り替えても状態を継続するには、正準状態を `WorkspaceAdapter` に置き、実行前に sandbox へ materialize し、実行後に変更を Workspace へ sync し、バックエンドが対応している場合は checkpoint を作成します。

```typescript
import {
  MemoryWorkspaceAdapter,
  materializeWorkspaceToSandbox,
  syncWorkspaceFromSandbox,
} from '@sandbank.dev/workspace'

const workspace = new MemoryWorkspaceAdapter()
await workspace.write('/workspace/task.md', 'ship it')

const sandbox = await provider.create({ image: 'node:22' })
await materializeWorkspaceToSandbox(workspace, sandbox, {
  workspacePath: '/workspace',
  sandboxPath: '/workspace',
})

await sandbox.exec('echo done > /workspace/result.txt')

await syncWorkspaceFromSandbox(workspace, sandbox, {
  workspacePath: '/workspace',
  sandboxPath: '/workspace',
  deleteMissing: true,
  checkpointLabel: 'after provider run',
})
```

Provider-native volumes はローカル cache や provider 内の永続化に使います。プロバイダーをまたぐ rollback、checkpoint、継続実行、一貫性 merge では Workspace を基準にします。

## Provider Scheduler と Preflight

トップレベルの `sandbank` パッケージは `selectSandboxProvider`、`preflightWorkspaceSandboxTask`、`runWorkspaceSandboxTask` をエクスポートします。scheduler は sandbox provider を compute candidate として扱い、`runtime.python`、`runtime.codex`、`codex.exec`、`codex.goal`、`workspace.snapshot`、`workspace.live` などの宣言済み capability で provider を選択します。

```typescript
import {
  preflightWorkspaceSandboxTask,
  runWorkspaceSandboxTask,
} from 'sandbank'

const taskConfig = {
  workspace,
  providers: [
    { provider: sandbankCloudProvider, capabilities: ['runtime.python', 'codex.exec'], priority: 30 },
    { provider: e2bProvider, capabilities: ['runtime.python'], priority: 10 },
    { provider: boxliteProvider, capabilities: ['runtime.python'] },
  ],
  task: { kind: 'python' as const, path: '/workspace/generated/task.py', image: 'python-agent' },
  imageCatalog: {
    'python-agent': {
      default: 'python:3.12',
      'sandbank-cloud': 'python:3.12-slim',
      e2b: 'e2b-python-template',
      boxlite: 'python:3.12-slim',
    },
  },
  preflight: { runtime: true },
}

const preflight = await preflightWorkspaceSandboxTask(taskConfig)
if (!preflight.ok) throw new Error(preflight.errors.join('; '))

await runWorkspaceSandboxTask({
  ...taskConfig,
  consistency: { mode: 'branch-merge', conflictResolution: 'keep-both' },
  preflight: false,
})
```

Static preflight は実行前に Workspace と provider の capability を確認します。Runtime preflight は一時 sandbox を作成し、`python`、`codex`、`git`、`tmux`、`tar`、`gzip` などのイメージ内ツールを probe します。`codex.goal` は vas 風の `tmux` セッションを起動し、terminal attach と後続の Workspace sync のために sandbox を残します。詳細は [Provider Scheduler And Workspace Consistency](./docs/provider-scheduler-workspace.md) と [Sandbank Agent Configuration](./docs/sandbank-agent-configuration.ja.md) を参照してください。

## Agent Tool Use

Sandbank Tool Use は単一の model adapter より低レベルなプロトコルです。モデルループ、Dynamic Worker capsule、hosted agent は構造化された `tool.use` request を送信し、Agent Supervisor は handler や sandbox provider を呼び出す前に agent の tool/resource policy を検査します。

```typescript
import {
  AgentSupervisor,
  ToolUseRegistry,
  createCloudflareResourceTool,
  createSearchCodeRunTool,
  createSandboxPythonTool,
} from 'sandbank'

const registry = new ToolUseRegistry()
  .register(createCloudflareResourceTool('read', async input => {
    // Cloudflare D1/KV/R2 などの bindings または API に接続できます。
    return { ok: true, resource: input.resource }
  }))
  .register(createSearchCodeRunTool({
    search: {
      provider: 'perplexity',
      search: async query => searchProvider.search(query),
      fetchJson: async url => searchProvider.fetchJson(url),
    },
  }))
  .register(createSandboxPythonTool())

const supervisor = new AgentSupervisor({
  agentId: 'agent-a',
  workspace,
  modelId: 'deepseek-v4-pro',
  toolUse: {
    registry,
    dynamicWorker,
    sandboxProviders: [
      { provider: sandbankCloudProvider, capabilities: ['runtime.python', 'codex.exec'] },
      { provider: e2bProvider, capabilities: ['runtime.python'] },
      { provider: boxliteProvider, capabilities: ['runtime.python'] },
    ],
    policy: {
      allowedTools: ['cloudflare.resource.read', 'search.code.run', 'sandbox.python'],
      resources: [
        { kind: 'cloudflare.d1', id: 'analytics', actions: ['read'] },
        { kind: 'dynamic_worker.execution', actions: ['execute'] },
        { kind: 'runtime.javascript', actions: ['execute'] },
        { kind: 'external.search', id: 'perplexity', actions: ['query'] },
        { kind: 'http.egress', id: 'api.example.com', actions: ['fetch'] },
        { kind: 'workspace.path', scope: '/runs', actions: ['write'] },
        { kind: 'sandbox.provider', id: 'sandbank-cloud', actions: ['execute'] },
        { kind: 'sandbox.provider', id: 'e2b', actions: ['execute'] },
        { kind: 'runtime.python', actions: ['execute'] },
      ],
      requireApproval: [
        { kind: 'cloudflare.d1', action: 'write' },
      ],
    },
  },
})
```

Tool registration は第三者の host application が制御します。呼び出し側は harness/supervisor の初期化時に `ToolUseRegistry` を作成し、`.register(...)` で tool definition を注入し、各 agent/run の policy で whitelist を有効化します。現時点では、remote arbitrary user が tool を登録する管理 endpoint は公開していません。

`resources` は agent 有効化時の compute/data resource whitelist です。prompt がユーザーデータベースの変更を求めても、request は許可された resource/action と approval rule に一致する必要があります。`search.code.run` は code mode です。model は JavaScript function body を生成でき、Dynamic Worker が実行しますが、code は `ctx.search`、`ctx.workspace`、`ctx.runtime` などの controlled binding にしかアクセスできません。raw egress も `http.egress` grant に一致する必要があります。`sandbox.python` は provider scheduler に委譲するため、Dynamic Worker が生成した Python は E2B、BoxLite、Sandbank Cloud、または `runtime.python` を宣言する provider へ派遣できます。Dynamic Worker capsule は `SANDBANK_TOOLS.list()` と `SANDBANK_TOOLS.use(request)` を通じて同じ supervisor policy を使い、権限チェックを迂回しません。

## クイックスタート

```bash
# 推奨 provider をインストール
pnpm add @sandbank.dev/core @sandbank.dev/cloud

# プロバイダーの設定
export SANDBANK_API_TOKEN=your-key
# または x402 pay-per-use
export WALLET_PRIVATE_KEY=0x...
```

```typescript
import { createProvider } from '@sandbank.dev/core'
import { SandbankCloudAdapter } from '@sandbank.dev/cloud'

const provider = createProvider(
  new SandbankCloudAdapter({ apiToken: process.env.SANDBANK_API_TOKEN })
)

// サンドボックスを作成
const sandbox = await provider.create({
  image: 'node:22',
  resources: { cpu: 2, memory: 2048 },
  autoDestroyMinutes: 30,
})

// コマンドを実行
const { stdout } = await sandbox.exec('node --version')

// ファイル操作
await sandbox.writeFile('/app/index.js', 'console.log("hi")')
await sandbox.exec('node /app/index.js')

// クリーンアップ
await provider.destroy(sandbox.id)
```

## 開発

```bash
git clone https://github.com/chekusu/sandbank.git
cd sandbank
pnpm install

# 全ユニットテストを実行
pnpm test

# クロスプロバイダー適合性テストを実行
pnpm test:conformance

# 型チェック
pnpm typecheck
```

### DB-native Harness API

`sandbank` CLI と Worker entrypoint は、Agent Supervisor、db9 Workspace storage、DeepSeek V4 Pro に支えられた公開 Sandbank harness API を提供します：

```bash
DB9_DATABASE_ID=... DB9_TOKEN=... DEEPSEEK_API_KEY=... \
  vas dev sandbank-harness pnpm --filter ./packages/sandbank exec tsx src/cli/index.ts harness-api --host 0.0.0.0 --port 8789
```

Routes:

- `GET /health`
- `GET /api/db-native-agent-harness/capabilities`
- `POST /api/sandbank-agent-harness/stream`
- `POST /api/db-native-agent-harness/stream`

stream は汎用 Sandbank SSE events を送信し、run input/output を `/runs/...` に、supervisor state/audit data を `/agents/...` に永続化し、Workspace backend が対応している場合は checkpoint を作成します。デフォルトモデルは `deepseek-v4-pro` です。さらに `/agents/{agentId}/memory/memories.jsonl` に Agent memory を保存し、active な `pinned` / `insight` / `session` memory を model prompt に注入し、明示的な `remember` / `记住` request を pinned memory として書き込みます。Worker-compatible entrypoint は `sandbank/harness-worker` としてエクスポートされます。Node CLI は `vas dev` または同等の deployment path で service hosting するためのもので、localhost-only preview ではありません。モデル、Workspace、provider、image の要件は [Sandbank Agent Configuration](./docs/sandbank-agent-configuration.ja.md) にまとめています。

1つの prompt で live harness を benchmark します：

```bash
pnpm --filter ./packages/sandbank exec tsx src/cli/index.ts harness-benchmark \
  --base-url https://your-sandbank-worker.example \
  --question "@agent run a Sandbank harness health check" \
  --json
```

デフォルト benchmark suite を実行します：

```bash
SANDBANK_HARNESS_BASE_URL=https://your-sandbank-worker.example pnpm bench:harness -- --json
```

benchmark は各 case を `/api/db-native-agent-harness/stream` に POST し、SSE timeline を記録し、HTTP/SSE transport、harness lifecycle、Workspace persistence、Dynamic Worker capsule execution、model streaming、case expectations、latency を 100 点満点で採点します。

### インテグレーションテストの実行

インテグレーションテストは実際の API を呼び出します。環境変数でゲートされています：

```bash
# Sandbank Cloud（推奨デフォルト provider）
SANDBANK_API_TOKEN=... pnpm test

# Daytona
DAYTONA_API_KEY=... pnpm test

# Fly.io
FLY_API_TOKEN=... FLY_APP_NAME=... pnpm test

# Cloudflare
E2E_WORKER_URL=... pnpm test

# db9
DB9_TOKEN=... pnpm --filter @sandbank.dev/db9 test:e2e
```

## テストカバレッジ

| Package | Stmts | Branch | Funcs | Lines | Unit | Integration |
|---------|:-----:|:------:|:-----:|:-----:|:----:|:-----------:|
| `@sandbank.dev/core` | 84% | 77% | 74% | 88% | 98 | — |
| `@sandbank.dev/db9` | 100% | 97% | 93% | 100% | 35 | 3 |

ローカルで coverage を実行します：

```bash
pnpm --filter @sandbank.dev/db9 test -- --coverage
```

## 設計原則

1. **最小インターフェース、最大互換性** — 真の最大公約数のみ (exec + files + lifecycle)
2. **暗黙より明示** — 自動フォールバックなし、キャッシュなし、隠れたリトライなし
3. **ケイパビリティ検出、偽装実装は不可** — サポートしていなければエラーを返す
4. **冪等操作** — 既に破棄されたサンドボックスの破棄はノーオペレーション
5. **完全疎結合** — プロバイダー層とセッション層は独立、自由に組み合わせ可能

## ライセンス

MIT
