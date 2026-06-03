# Sandbank

> AI エージェント統一サンドボックス SDK — 一度書けば、どのクラウドでも動く。

Sandbank はクラウドサンドボックスの作成・管理・オーケストレーションに統一された TypeScript インターフェースを提供します。プロバイダーを切り替えても、アプリケーションコードの変更は不要です。

**[ウェブサイト](https://sandbank.dev)** | **[English](./README.en.md)** | **[中文文档](./README.md)**

<img src="./docs/assets/sandbank-robots-vacation-pixel.png" alt="ピクセルアート風の海の sandbank で休暇を過ごす小さなロボット Agent たち。それぞれが異なる開発者ロールを持つ" width="100%" />

## なぜ Sandbank?

AI エージェントには隔離された実行環境が必要です。しかし、クラウドプロバイダーごとに API が異なります — Daytona、Fly.io、Cloudflare Workers、すべてバラバラです。Sandbank はこれらを一つのインターフェースに統一します：

```typescript
import { createProvider } from '@sandbank.dev/core'
import { DaytonaAdapter } from '@sandbank.dev/daytona'

const provider = createProvider(new DaytonaAdapter({ apiKey: '...' }))
const sandbox = await provider.create({ image: 'node:22' })

const result = await sandbox.exec('echo "Hello from the sandbox"')
console.log(result.stdout) // Hello from the sandbox

await provider.destroy(sandbox.id)
```

`DaytonaAdapter` を `FlyioAdapter` や `CloudflareAdapter` に差し替えるだけ — コード変更ゼロ。

## アーキテクチャ

```
┌──────────────────────────────────────────────────────┐
│  アプリケーション / AI エージェント                      │
├──────────────────────────────────────────────────────┤
│  sandbank                   Agent Supervisor / Scheduler │
│  @sandbank.dev/core         統一プロバイダーインターフェース  │
│  @sandbank.dev/workspace    永続 Workspace と Checkpoint │
│  @sandbank.dev/skills       スキルレジストリ・インジェクション │
│  @sandbank.dev/agent        サンドボックス内エージェント      │
│  @sandbank.dev/relay        マルチエージェント通信            │
├──────────────────────────────────────────────────────┤
│  @sandbank.dev/daytona  @sandbank.dev/flyio  @sandbank.dev/cloudflare  │
│  @sandbank.dev/boxlite  @sandbank.dev/e2b                 │
│  プロバイダーアダプター（Compute）                         │
├──────────────────────────────────────────────────────┤
│  @sandbank.dev/db9       Service Adapter（Data）      │
├──────────────────────────────────────────────────────┤
│  Daytona    Fly.io Machines    Cloudflare Workers     │
│  BoxLite (セルフホスト Docker)    E2B Cloud Sandboxes  │
│  db9.ai (PostgreSQL)                                  │
└──────────────────────────────────────────────────────┘
```

## パッケージ一覧

| パッケージ | 説明 |
|-----------|------|
| [`@sandbank.dev/core`](./packages/core) | プロバイダー抽象化、ケイパビリティシステム、エラー型 |
| [`@sandbank.dev/skills`](./packages/skills) | スキルレジストリ、ローカルファイルシステムローダー |
| [`@sandbank.dev/workspace`](./packages/workspace) | 永続 Workspace プロトコル、checkpoint、sandbox materialize/sync helper |
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

| 操作 | Daytona | Fly.io | Cloudflare | BoxLite | E2B |
|------|:-------:|:------:|:----------:|:-------:|:---:|
| 作成 / 破棄 | ✅ | ✅ | ✅ | ✅ | ✅ |
| サンドボックス一覧 | ✅ | ✅ | ✅ | ✅ | ✅ |
| コマンド実行 | ✅ | ✅ | ✅ | ✅ | ✅ |
| ファイル読み書き | ✅ | ✅ | ✅ | ✅ | ✅ |
| スキル注入 | ✅ | ✅ | ✅ | ✅ | ✅ |

### 拡張ケイパビリティ

ケイパビリティはオプトインです。`withVolumes(provider)` や `withPortExpose(sandbox)` 等で実行時に安全に検出・アクセスできます。

| ケイパビリティ | Daytona | Fly.io | Cloudflare | BoxLite | E2B | db9 | 説明 |
|--------------|:-------:|:------:|:----------:|:-------:|:---:|:---:|------|
| `volumes` | ✅ | ✅ | ⚠️* | ❌ | ⚠️*** | — | 永続ボリューム管理 |
| `port.expose` | ✅ | ✅ | ⚠️** | ✅ | ✅ | — | サンドボックスポートをインターネットに公開 |
| `exec.stream` | ❌ | ❌ | ✅ | ✅ | ❌ | — | stdout/stderr のリアルタイムストリーミング |
| `snapshot` | ❌ | ❌ | ✅ | ✅ | ❌ | — | サンドボックス状態のスナップショットと復元 |
| `terminal` | ✅ | ✅ | ✅ | ✅ | ✅ | — | インタラクティブ Web ターミナル (ttyd) |
| `sleep` | ❌ | ❌ | ❌ | ✅ | ✅ | — | サンドボックスの休止と復帰 |
| `skills` | ✅ | ✅ | ✅ | ✅ | ✅ | — | スキル定義をサンドボックスにロード・注入 |
| `services` | ❌ | ❌ | ❌ | ❌ | ❌ | ✅ | データサービス (PostgreSQL) をサンドボックスへバインド |

\* Cloudflare の `volumes` はアダプター設定で `storage` オプションが必要です。

\*\* Cloudflare はポート 3000 をサンドボックスのコントロールプレーンに予約しています。1024–65535（3000 を除く）の範囲で指定してください。

\*\*\* E2B volumes は現在 E2B volume beta アクセスが必要です。Sandbank はボリューム `id` で E2B `Volume` に接続してマウントします。

### プロバイダー特性比較

| | Daytona | Fly.io | Cloudflare | BoxLite | E2B |
|---|---------|--------|------------|---------|-----|
| **ランタイム** | フル VM | Firecracker マイクロ VM | V8 アイソレート + コンテナ | Docker コンテナ | E2B クラウドサンドボックス |
| **コールドスタート** | ~10 秒 | ~3-5 秒 | ~1 秒 | ~2-5 秒 | Provider 管理 |
| **ファイル I/O** | ネイティブ SDK | exec 経由 (base64) | ネイティブ SDK | exec 経由 (base64) | ネイティブ SDK |
| **リージョン** | マルチ | マルチ | グローバルエッジ | セルフホスト | E2B 管理 |
| **外部依存** | `@daytonaio/sdk` | なし (純粋 fetch) | `@cloudflare/sandbox` | BoxLite API | `e2b` |

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
    { provider: e2bProvider, capabilities: ['runtime.python'], priority: 10 },
    { provider: boxliteProvider, capabilities: ['runtime.python'] },
  ],
  task: { kind: 'python' as const, path: '/workspace/generated/task.py', image: 'python-agent' },
  imageCatalog: {
    'python-agent': {
      default: 'python:3.12',
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
  createSandboxPythonTool,
} from 'sandbank'

const registry = new ToolUseRegistry()
  .register(createCloudflareResourceTool('read', async input => {
    // Cloudflare D1/KV/R2 などの bindings または API に接続できます。
    return { ok: true, resource: input.resource }
  }))
  .register(createSandboxPythonTool())

const supervisor = new AgentSupervisor({
  agentId: 'agent-a',
  workspace,
  modelId: 'deepseek-v4-pro',
  toolUse: {
    registry,
    sandboxProviders: [
      { provider: e2bProvider, capabilities: ['runtime.python'] },
      { provider: boxliteProvider, capabilities: ['runtime.python'] },
    ],
    policy: {
      allowedTools: ['cloudflare.resource.read', 'sandbox.python'],
      resources: [
        { kind: 'cloudflare.d1', id: 'analytics', actions: ['read'] },
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

`resources` は agent 有効化時の compute/data resource whitelist です。prompt がユーザーデータベースの変更を求めても、request は許可された resource/action と approval rule に一致する必要があります。`sandbox.python` は provider scheduler に委譲するため、Dynamic Worker が生成した Python は E2B、BoxLite、Sandbank Cloud、または `runtime.python` を宣言する provider へ派遣できます。Dynamic Worker capsule は `SANDBANK_TOOLS.list()` と `SANDBANK_TOOLS.use(request)` を通じて同じ supervisor policy を使い、権限チェックを迂回しません。

## クイックスタート

```bash
# インストール
pnpm add @sandbank.dev/core @sandbank.dev/daytona  # または @sandbank.dev/flyio、@sandbank.dev/cloudflare、@sandbank.dev/e2b

# プロバイダーの設定
export DAYTONA_API_KEY=your-key
```

```typescript
import { createProvider } from '@sandbank.dev/core'
import { DaytonaAdapter } from '@sandbank.dev/daytona'

const provider = createProvider(
  new DaytonaAdapter({ apiKey: process.env.DAYTONA_API_KEY! })
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
