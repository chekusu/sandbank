# Sandbank CLI 实现计划

**目标：** 在 `sandbank` 根包中加入 CLI，让人类用户、外部 agent、sandbox 内 agent 都能通过 `sandbank` 命令操作沙箱。

---

## 现有基础

- `sandbank` 根包：re-export `@sandbank.dev/core`，已发布到 npm
- `@sandbank.dev/cloud`：完整的 Cloud API 客户端，含 x402 支付签名
- `@sandbank.dev/agent`：sandbox 内 agent CLI（send/recv/context）

## 架构

```
sandbank (npm 包)
├── dist/index.js         ← SDK 入口（现有）
├── dist/cli.js           ← CLI 入口（新增）
└── package.json
    bin: { "sandbank": "dist/cli.js" }
    dependencies: + @sandbank.dev/cloud
```

CLI 内部使用 `SandbankCloudAdapter`，不重新实现 API 客户端。

---

## 认证优先级

```
1. --api-key 参数                    (显式)
2. SANDBANK_API_KEY env              (外部 agent / CI)
3. SANDBANK_AGENT_TOKEN env          (sandbox 内，溯源身份)
4. ~/.sandbank/credentials.json      (sandbank login 保存的)
5. --wallet-key 参数 / SANDBANK_WALLET_KEY env  (x402 支付)
```

前 3 种统一传给 `SandbankCloudConfig.apiToken`。
第 5 种传给 `SandbankCloudConfig.walletPrivateKey`。

```typescript
function resolveConfig(flags): SandbankCloudConfig {
  const apiToken = flags.apiKey
    || process.env.SANDBANK_API_KEY
    || process.env.SANDBANK_AGENT_TOKEN
    || loadCredentials()?.apiKey

  const walletPrivateKey = flags.walletKey
    || process.env.SANDBANK_WALLET_KEY
    || loadCredentials()?.walletKey

  const url = flags.url
    || process.env.SANDBANK_API_URL
    || loadCredentials()?.url
    || 'https://cloud.sandbank.dev'

  return { url, apiToken, walletPrivateKey }
}
```

---

## 命令

### 认证

```bash
sandbank login --api-key <key>        # 保存 API key
sandbank login --wallet-key <0x...>   # 保存 EVM 私钥
sandbank config                       # 查看当前配置（敏感值掩码）
sandbank config set <key> <value>     # 设置配置项
sandbank config get <key>             # 获取配置项
```

### 沙箱管理

```bash
sandbank create [--image codebox] [--cpu 2] [--memory 1024] [--json]
sandbank list [--json]
sandbank get <id> [--json]
sandbank destroy <id>
sandbank clone <id> [--json]           # sandbox 内可省略 id（默认 clone 自己）
sandbank keep <id> [--minutes 30]
```

### 执行

```bash
sandbank exec <id> <command> [--json]
sandbank exec <id> --stdin < script.sh
```

### Addon

```bash
sandbank addons create <type> [--intent "..."] [--json]
sandbank addons list [--json]
```

### 快照

```bash
sandbank snapshot create <id> <name>
sandbank snapshot list <id>
sandbank snapshot restore <id> <name>
sandbank snapshot delete <id> <name>
```

### 全局 flags

```
--api-key <key>       覆盖认证
--wallet-key <0x..>   覆盖钱包
--url <url>           覆盖 API URL
--json                结构化输出
--help / -h           帮助
--version / -v        版本
```

---

## 配置文件

`~/.sandbank/credentials.json` (权限 0o600)

```json
{
  "url": "https://cloud.sandbank.dev",
  "apiKey": "gF9mmm...",
  "walletKey": "0x..."
}
```

敏感字段显示时自动掩码（保留首尾 4 字符）。

---

## 文件结构

```
packages/sandbank/
├── src/
│   ├── index.ts              ← SDK 入口（现有，不动）
│   └── cli/
│       ├── index.ts          ← CLI 入口
│       ├── config.ts         ← 配置读写
│       ├── auth.ts           ← 认证解析
│       └── commands/
│           ├── create.ts
│           ├── list.ts
│           ├── get.ts
│           ├── destroy.ts
│           ├── clone.ts
│           ├── exec.ts
│           ├── keep.ts
│           ├── addons.ts
│           ├── snapshot.ts
│           ├── login.ts
│           ├── config.ts
│           └── help.ts
├── package.json              ← + bin, + @sandbank.dev/cloud dep
└── tsconfig.json
```

---

## package.json 变更

```diff
{
  "name": "sandbank",
+ "bin": { "sandbank": "dist/cli/index.js" },
  "exports": {
    ".": {
      "types": "./dist/index.d.ts",
      "import": "./dist/index.js"
    }
  },
+ "files": ["dist", "README.md"],
  "scripts": {
    "build": "tsc",
+   "build:compile": "bun build src/cli/index.ts --compile --outfile sandbank"
  },
  "dependencies": {
    "@sandbank.dev/core": "workspace:*",
+   "@sandbank.dev/cloud": "workspace:*"
  }
}
```

---

## 构建和发布

### npm 包
`tsc` 编译 → `dist/cli/index.js` → `npx sandbank` 或 `npm i -g sandbank`

### 独立二进制
`bun build --compile` → 4 平台二进制 → GitHub Releases

### Codebox 镜像预装
编译后的二进制放入 codebox OCI 镜像的 `/usr/local/bin/sandbank`

---

## 实现步骤

### Step 1: 基础骨架
- [ ] package.json 加 bin + cloud 依赖
- [ ] src/cli/index.ts 命令分发
- [ ] src/cli/config.ts 配置读写
- [ ] src/cli/auth.ts 认证解析
- [ ] sandbank login + sandbank config

### Step 2: 核心命令
- [ ] sandbank create
- [ ] sandbank list
- [ ] sandbank get
- [ ] sandbank destroy
- [ ] sandbank exec

### Step 3: 高级命令
- [ ] sandbank clone
- [ ] sandbank keep
- [ ] sandbank addons create/list
- [ ] sandbank snapshot create/list/restore/delete

### Step 4: 发布
- [ ] tsc 构建验证
- [ ] bun build --compile 验证
- [ ] GitHub Actions release 工作流
- [ ] npm publish
- [ ] codebox 镜像预装

---

## Sandbox 内的行为

sandbox 内 `SANDBANK_AGENT_TOKEN` 自动注入，CLI 自动识别：

```bash
# sandbox 内，无需配置
sandbank create                    # 溯源到创建者身份，创建平级 box
sandbank clone                     # 默认 clone 自己（SANDBANK_BOX_ID）
sandbank exec sibling123 "..."     # 操作兄弟 box
sandbank addons create wechatbox   # 创建 addon
```

agent 不需要知道 token，CLI 从环境变量自动读取。
