# Plan: 非 root 沙箱用户功能

## 动机

BoxLite (libkrun) 容器默认以 root 运行。Claude Code 的 `--dangerously-skip-permissions` 拒绝在 root 下执行，静默失败。当前 workaround 是 `--permission-mode acceptEdits`，但这不支持所有操作。需要一个 provider-agnostic 的方式在沙箱中创建非 root 用户，使后续命令以该用户身份运行。

## 设计

### 接口变更

#### 1. `CreateConfig` 新增 `user` 字段

```typescript
// packages/core/src/types.ts
export interface CreateConfig {
  // ... 现有字段 ...

  /**
   * 创建非 root 用户并以该用户身份执行命令。
   * - string: 用户名（等价于 { name: 'xxx' }）
   * - object: 完整配置
   * - 未设置: 保持 root（向后兼容）
   */
  user?: string | SandboxUser
}

export interface SandboxUser {
  /** 用户名。默认: 'sandbank' */
  name?: string
  /** 指定 UID。默认: 自动分配 */
  uid?: number
  /** 是否授予 sudo 权限。默认: true */
  sudo?: boolean
}
```

#### 2. `ExecOptions` 新增 `asRoot` 字段

```typescript
// packages/core/src/types.ts
export interface ExecOptions {
  timeout?: number
  cwd?: string
  /** 以 root 身份执行（仅在配置了 user 时有意义）。默认: false */
  asRoot?: boolean
}
```

#### 3. `Sandbox` 新增 `user` 只读属性

```typescript
// packages/core/src/types.ts
export interface Sandbox {
  // ... 现有字段 ...
  /** 当前沙箱的非 root 用户信息（如已配置） */
  readonly user?: { name: string; home: string }
}
```

### 实现

#### 核心位置: `packages/core/src/provider.ts` — `createProvider().create()`

在 `adapter.createSandbox()` 之后、`wrapSandbox()` 之前，执行用户创建：

```typescript
async create(config: CreateConfig): Promise<Sandbox> {
  const raw = await adapter.createSandbox(config)

  // 新增: 创建非 root 用户
  let userInfo: { name: string; home: string } | undefined
  if (config.user) {
    userInfo = await setupSandboxUser(raw, config.user)
  }

  const sandbox = wrapSandbox(raw, adapter.name, observer, taskId, userInfo)
  // ... skills 注入等 ...
  return sandbox
}
```

#### 新函数: `setupSandboxUser()`

```typescript
// packages/core/src/sandbox-user.ts

export async function setupSandboxUser(
  sandbox: AdapterSandbox,
  config: string | SandboxUser,
): Promise<{ name: string; home: string }> {
  const opts = typeof config === 'string' ? { name: config } : config
  const name = opts.name ?? 'sandbank'
  const sudo = opts.sudo ?? true

  // 1. 创建用户
  const uidFlag = opts.uid ? `-u ${opts.uid}` : ''
  const result = await sandbox.exec(
    `id ${name} >/dev/null 2>&1 || useradd -m -s /bin/bash ${uidFlag} ${name}`,
  )
  if (result.exitCode !== 0) {
    throw new Error(`Failed to create user '${name}': ${result.stderr}`)
  }

  // 2. 获取 home 目录
  const homeResult = await sandbox.exec(`eval echo ~${name}`)
  const home = homeResult.stdout.trim()

  // 3. 可选: 配置 sudo
  if (sudo) {
    await sandbox.exec(
      `command -v sudo >/dev/null 2>&1 || (apt-get update -qq && apt-get install -y -qq sudo) 2>/dev/null; `
      + `echo '${name} ALL=(ALL) NOPASSWD:ALL' > /etc/sudoers.d/${name} && chmod 440 /etc/sudoers.d/${name}`,
    )
  }

  return { name, home }
}
```

#### `wrapSandbox()` 修改

新增 `userInfo` 参数，包装 `exec()`:

```typescript
function wrapSandbox(
  raw: AdapterSandbox,
  providerName: string,
  observer?: SandboxObserver,
  taskId?: string,
  userInfo?: { name: string; home: string },  // 新增
): Sandbox {
  return {
    // ... 现有字段 ...
    user: userInfo,  // 新增

    async exec(command: string, options?: ExecOptions): Promise<ExecResult> {
      let cmd = command
      let opts = options

      // 如果有非 root 用户且不要求 asRoot
      if (userInfo && !options?.asRoot) {
        cmd = wrapAsUser(command, userInfo.name, options?.cwd)
        // cwd 已包含在 wrapped command 中，不再传给 adapter
        opts = options ? { ...options, cwd: undefined } : undefined
      }

      const start = Date.now()
      const result = await raw.exec(cmd, opts)
      emit(...)
      return result
    },

    // writeFile/readFile 不受影响（保持 root）
  }
}
```

#### 命令包装函数

```typescript
// packages/core/src/sandbox-user.ts

/**
 * 将命令包装为指定用户执行。
 * 使用 `su - <user> -c '...'` — 由 root 调用无需密码，`-` 设置完整环境（HOME, PATH 等）。
 */
export function wrapAsUser(command: string, user: string, cwd?: string): string {
  // POSIX 单引号转义: ' → '\''
  const cdPrefix = cwd ? `cd '${cwd.replace(/'/g, "'\\''")}' && ` : ''
  const escaped = command.replace(/'/g, "'\\''")
  return `su - ${user} -c '${cdPrefix}${escaped}'`
}
```

### 文件变更清单

| 文件 | 变更类型 | 说明 |
|------|----------|------|
| `packages/core/src/types.ts` | 修改 | 新增 `SandboxUser` 接口；`CreateConfig.user`；`ExecOptions.asRoot`；`Sandbox.user` |
| `packages/core/src/sandbox-user.ts` | **新建** | `setupSandboxUser()` + `wrapAsUser()` |
| `packages/core/src/provider.ts` | 修改 | `create()` 中调用 `setupSandboxUser()`；`wrapSandbox()` 增加用户包装 |
| `packages/core/src/index.ts` | 修改 | 导出 `SandboxUser` 类型 |
| `packages/core/test/sandbox-user.test.ts` | **新建** | 单元测试 |

### E2E 测试适配（不在本次 scope 内，仅记录）

```typescript
// 使用示例:
const sandbox = await provider.create({
  image: 'node:22-slim',
  user: 'sandbank',  // 或 { name: 'sandbank', sudo: true }
})

// 默认以 sandbank 用户执行
await sandbox.exec('whoami')  // → "sandbank"
await sandbox.exec('claude -p "hello" --dangerously-skip-permissions')  // 可用！

// 需要 root 时
await sandbox.exec('apt-get install -y git', { asRoot: true })
```

## 权衡与风险

1. **`su -` 的二次 shell 解析**: 命令经过一次额外的 shell 解析。单引号转义处理了 99% 的情况，极端 edge case（命令内含 `'\''`）理论上也能正确处理。
2. **cwd 处理**: 当 user 包装启用时，`cwd` 通过在命令前加 `cd` 实现，而非传给 adapter。这可能导致目录不存在时的错误信息不够清晰。
3. **文件权限**: `writeFile()` 仍以 root 执行，写入的文件 owner 是 root。如果非 root 用户需要读写这些文件，调用方需要额外 `chown` 或 `chmod`。可以考虑后续加 `writeFile` 的自动 chown，但不在首次实现范围内。
4. **sudo 安装**: 在 slim 镜像中安装 sudo 需要 `apt-get`，增加约 5-10 秒。可通过 `sudo: false` 跳过。
5. **不支持 Alpine**: `useradd` 在 Alpine 中是 `adduser`。首次实现假设 Debian/Ubuntu 基础镜像（node:22-slim 等）。后续可检测发行版。

## Checklist

- [ ] 1. `types.ts`: 新增 `SandboxUser` 接口、`CreateConfig.user`、`ExecOptions.asRoot`、`Sandbox.user`
- [ ] 2. 新建 `sandbox-user.ts`: `setupSandboxUser()` + `wrapAsUser()`
- [ ] 3. `provider.ts`: `create()` 中调用 `setupSandboxUser`；`wrapSandbox` 增加 user 参数和 exec 包装
- [ ] 4. `index.ts`: 导出新类型
- [ ] 5. 新建 `sandbox-user.test.ts`: 单元测试（`wrapAsUser` 纯函数 + `setupSandboxUser` mock 测试）
- [ ] 6. 运行 typecheck + 全部测试通过
