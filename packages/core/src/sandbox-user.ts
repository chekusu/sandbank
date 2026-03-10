import type { AdapterSandbox, SandboxUser, SandboxUserInfo } from './types.js'

/**
 * 在沙箱中创建非 root 用户。
 * 假设 Debian/Ubuntu 基础镜像（useradd）。
 */
export async function setupSandboxUser(
  sandbox: AdapterSandbox,
  config: string | SandboxUser,
): Promise<SandboxUserInfo> {
  const opts = typeof config === 'string' ? { name: config } : config
  const name = opts.name ?? 'sandbank'
  const sudo = opts.sudo ?? true

  // 1. 创建用户（如果不存在）
  const uidFlag = opts.uid != null ? `-u ${opts.uid}` : ''
  const result = await sandbox.exec(
    `id ${name} >/dev/null 2>&1 || useradd -m -s /bin/bash ${uidFlag} ${name}`,
  )
  if (result.exitCode !== 0) {
    throw new Error(`Failed to create user '${name}': ${result.stderr || result.stdout}`)
  }

  // 2. 获取 home 目录
  const homeResult = await sandbox.exec(`eval echo ~${name}`)
  const home = homeResult.stdout.trim()
  if (!home || home === `~${name}`) {
    throw new Error(`Failed to resolve home directory for user '${name}'`)
  }

  // 3. 配置 sudo（可选）
  if (sudo) {
    await sandbox.exec(
      `command -v sudo >/dev/null 2>&1 || (apt-get update -qq && apt-get install -y -qq sudo) 2>/dev/null; `
      + `echo '${name} ALL=(ALL) NOPASSWD:ALL' > /etc/sudoers.d/${name} && chmod 440 /etc/sudoers.d/${name}`,
    )
  }

  return { name, home }
}

/**
 * 将命令包装为指定用户执行。
 * 使用 `su - <user> -c '...'` — 由 root 调用无需密码，`-` 设置完整环境。
 *
 * 构建 inner command（su 的 bash 将执行的内容），然后整体做一次
 * 单引号转义放入外层 `'...'`。cwd 在 inner command 中用双引号包裹。
 */
export function wrapAsUser(command: string, user: string, cwd?: string): string {
  let innerCmd = command
  if (cwd) {
    // 双引号包裹 cwd，转义双引号上下文中的特殊字符
    const safeCwd = cwd.replace(/["$`\\]/g, '\\$&')
    innerCmd = `cd "${safeCwd}" && ${command}`
  }
  return `su - ${user} -c '${escapeSingleQuotes(innerCmd)}'`
}

/** POSIX 单引号转义: ' → '\'' */
function escapeSingleQuotes(s: string): string {
  return s.replace(/'/g, "'\\''")
}
