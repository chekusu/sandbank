# Sandbank

> AI エージェント統一サンドボックス SDK — 一度書けば、どのクラウドでも動く。

Sandbank はクラウドサンドボックスの作成・管理・オーケストレーションに統一された TypeScript インターフェースを提供します。プロバイダーを切り替えても、アプリケーションコードの変更は不要です。

**[ウェブサイト](https://sandbank.dev)** | **[English](./README.md)** | **[中文文档](./README.zh-CN.md)**

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
│  @sandbank.dev/core         統一プロバイダーインターフェース  │
│  @sandbank.dev/skills       スキルレジストリ・インジェクション │
│  @sandbank.dev/agent        サンドボックス内エージェント      │
│  @sandbank.dev/relay        マルチエージェント通信            │
├──────────────────────────────────────────────────────┤
│  @sandbank.dev/daytona  @sandbank.dev/flyio  @sandbank.dev/cloudflare  │
│  @sandbank.dev/boxlite                                   │
│  プロバイダーアダプター                                  │
├──────────────────────────────────────────────────────┤
│  Daytona    Fly.io Machines    Cloudflare Workers     │
│  BoxLite (セルフホスト Docker)                        │
└──────────────────────────────────────────────────────┘
```

## パッケージ一覧

| パッケージ | 説明 |
|-----------|------|
| [`@sandbank.dev/core`](./packages/core) | プロバイダー抽象化、ケイパビリティシステム、エラー型 |
| [`@sandbank.dev/skills`](./packages/skills) | スキルレジストリ、ローカルファイルシステムローダー |
| [`@sandbank.dev/daytona`](./packages/daytona) | Daytona クラウドサンドボックスアダプター |
| [`@sandbank.dev/flyio`](./packages/flyio) | Fly.io Machines アダプター |
| [`@sandbank.dev/cloudflare`](./packages/cloudflare) | Cloudflare Workers アダプター |
| [`@sandbank.dev/boxlite`](./packages/boxlite) | BoxLite セルフホスト Docker アダプター |
| [`@sandbank.dev/relay`](./packages/relay) | マルチエージェント通信用 WebSocket リレー |
| [`@sandbank.dev/agent`](./packages/agent) | サンドボックス内エージェント軽量クライアント |

## プロバイダーサポート

### 基本操作

すべてのプロバイダーが実装する最小契約：

| 操作 | Daytona | Fly.io | Cloudflare | BoxLite |
|------|:-------:|:------:|:----------:|:-------:|
| 作成 / 破棄 | ✅ | ✅ | ✅ | ✅ |
| サンドボックス一覧 | ✅ | ✅ | ✅ | ✅ |
| コマンド実行 | ✅ | ✅ | ✅ | ✅ |
| ファイル読み書き | ✅ | ✅ | ✅ | ✅ |
| スキル注入 | ✅ | ✅ | ✅ | ✅ |

### 拡張ケイパビリティ

ケイパビリティはオプトインです。`withVolumes(provider)` や `withPortExpose(sandbox)` 等で実行時に安全に検出・アクセスできます。

| ケイパビリティ | Daytona | Fly.io | Cloudflare | BoxLite | 説明 |
|--------------|:-------:|:------:|:----------:|:-------:|------|
| `volumes` | ✅ | ✅ | ⚠️* | ❌ | 永続ボリューム管理 |
| `port.expose` | ✅ | ✅ | ⚠️** | ✅ | サンドボックスポートをインターネットに公開 |
| `exec.stream` | ❌ | ❌ | ✅ | ✅ | stdout/stderr のリアルタイムストリーミング |
| `snapshot` | ❌ | ❌ | ✅ | ✅ | サンドボックス状態のスナップショットと復元 |
| `terminal` | ✅ | ✅ | ✅ | ✅ | インタラクティブ Web ターミナル (ttyd) |
| `sleep` | ❌ | ❌ | ❌ | ✅ | サンドボックスの休止と復帰 |
| `skills` | ✅ | ✅ | ✅ | ✅ | スキル定義をサンドボックスにロード・注入 |

\* Cloudflare の `volumes` はアダプター設定で `storage` オプションが必要です。

\*\* Cloudflare はポート 3000 をサンドボックスのコントロールプレーンに予約しています。1024–65535（3000 を除く）の範囲で指定してください。

### プロバイダー特性比較

| | Daytona | Fly.io | Cloudflare | BoxLite |
|---|---------|--------|------------|---------|
| **ランタイム** | フル VM | Firecracker マイクロ VM | V8 アイソレート + コンテナ | Docker コンテナ |
| **コールドスタート** | ~10 秒 | ~3-5 秒 | ~1 秒 | ~2-5 秒 |
| **ファイル I/O** | ネイティブ SDK | exec 経由 (base64) | ネイティブ SDK | exec 経由 (base64) |
| **リージョン** | マルチ | マルチ | グローバルエッジ | セルフホスト |
| **外部依存** | `@daytonaio/sdk` | なし (純粋 fetch) | `@cloudflare/sandbox` | BoxLite API |

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

## クイックスタート

```bash
# インストール
pnpm add @sandbank.dev/core @sandbank.dev/daytona  # または @sandbank.dev/flyio、@sandbank.dev/cloudflare

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

### インテグレーションテストの実行

インテグレーションテストは実際の API を呼び出します。環境変数でゲートされています：

```bash
# Daytona
DAYTONA_API_KEY=... pnpm test

# Fly.io
FLY_API_TOKEN=... FLY_APP_NAME=... pnpm test

# Cloudflare
E2E_WORKER_URL=... pnpm test
```

## 設計原則

1. **最小インターフェース、最大互換性** — 真の最大公約数のみ (exec + files + lifecycle)
2. **暗黙より明示** — 自動フォールバックなし、キャッシュなし、隠れたリトライなし
3. **ケイパビリティ検出、偽装実装は不可** — サポートしていなければエラーを返す
4. **冪等操作** — 既に破棄されたサンドボックスの破棄はノーオペレーション
5. **完全疎結合** — プロバイダー層とセッション層は独立、自由に組み合わせ可能

## ライセンス

MIT
