import type { Sandbox } from './types.js'

// --- Types ---

export type ClaudeHookEvent = 'PreToolUse' | 'PostToolUse' | 'PostToolUseFailure' | 'Stop'

export interface InjectHooksConfig {
  /**
   * Event destination.
   * - http: 使用 Claude Code 内置 HTTP hook 类型（sandbox 需能访问该 URL）
   * - file: 使用 command hook 将事件追加到 JSONL 文件
   */
  endpoint:
    | { type: 'http'; url: string; headers?: Record<string, string> }
    | { type: 'file'; path?: string }

  /** 要捕获的事件。默认: ['PostToolUse', 'Stop'] */
  events?: ClaudeHookEvent[]

  /** 是否异步执行 hook（不阻塞 agent）。默认: true */
  async?: boolean

  /**
   * settings.json 写入路径。默认: 自动检测 $HOME/.claude/settings.json
   * 传入目录时会追加 /.claude/settings.json
   */
  settingsDir?: string
}

export interface HookEventData {
  /** Unix timestamp (ms) */
  ts: number
  /** 原始 hook 输入数据 */
  data: Record<string, unknown>
}

export interface ClaudeLoginConfig {
  /** 每次按 Enter 的间隔秒数。默认: 2 */
  enterInterval?: number
  /** 最大按 Enter 次数。默认: 30 */
  maxRetries?: number
  /** 安装依赖的命令。默认: apt-get update -qq && apt-get install -y -qq screen */
  installCommand?: string
}

export interface ClaudeLoginResult {
  /** OAuth 授权 URL，用户需要在浏览器中打开 */
  url: string
  /**
   * 将 OAuth 回调返回的 auth code 发送到沙箱内的 claude login 进程。
   * 使用 screen -X source 注入字符到 PTY，避免 shell 转义问题。
   */
  sendCode: (code: string) => Promise<void>
  /**
   * 等待登录完成。用户在浏览器中完成授权后，此函数 resolve。
   * 超时则 reject。
   */
  waitForCredentials: (timeoutMs?: number) => Promise<void>
}

// --- Constants ---

export const DEFAULT_EVENTS_FILE = '/tmp/sandbank-hook-events.jsonl'
const HANDLER_SCRIPT_PATH = '/tmp/sandbank-hook-handler.sh'
const SCREEN_SESSION = 'claude-login'
const SCREEN_OUTPUT = '/tmp/sandbank-screen-output'

// --- Public API ---

/**
 * 将 Claude Code hooks 配置注入沙箱。
 * hooks 会在 agent 的每次工具调用后自动触发，将事件发送到指定端点。
 */
export async function injectClaudeHooks(
  sandbox: Sandbox,
  config: InjectHooksConfig,
): Promise<void> {
  const events = config.events ?? ['PostToolUse', 'Stop']
  const isAsync = config.async ?? true

  const hooksConfig: Record<string, unknown[]> = {}

  for (const event of events) {
    const hookDef = buildHookDef(event, config, isAsync)
    hooksConfig[event] = [{
      ...(event !== 'Stop' ? { matcher: '.*' } : {}),
      hooks: [hookDef],
    }]
  }

  const settings = { hooks: hooksConfig }

  // 确定 settings 目录：用户指定 > 自动检测 $HOME
  let baseDir = config.settingsDir
  if (!baseDir) {
    const homeResult = await sandbox.exec('echo $HOME')
    baseDir = homeResult.stdout.trim() || '/root'
  }
  const claudeDir = `${baseDir}/.claude`
  const settingsPath = `${claudeDir}/settings.json`

  // 确保 .claude 目录存在
  await sandbox.exec(`mkdir -p '${claudeDir}'`)

  // 写入 settings.json
  await sandbox.writeFile(settingsPath, JSON.stringify(settings, null, 2))

  // file 模式: 写入 handler 脚本并创建事件文件
  if (config.endpoint.type === 'file') {
    const eventsPath = config.endpoint.path ?? DEFAULT_EVENTS_FILE
    await writeHandlerScript(sandbox, eventsPath)
  }
}

/**
 * 从沙箱内的 JSONL 文件读取 hook 事件。
 * 用于 file 模式下拉取事件。
 */
export async function readHookEvents(
  sandbox: Sandbox,
  path?: string,
): Promise<HookEventData[]> {
  const filePath = path ?? DEFAULT_EVENTS_FILE
  const result = await sandbox.exec(`cat '${filePath}' 2>/dev/null || true`)
  const output = result.stdout.trim()
  if (!output) return []

  return output
    .split('\n')
    .filter(line => line.trim())
    .map(line => JSON.parse(line) as HookEventData)
}

/**
 * 在沙箱内自动化 `claude login`，捕获 OAuth 授权 URL。
 *
 * 使用 GNU screen 管理 PTY:
 * - screen 提供真实 PTY，满足 claude login 的 TUI 需求
 * - screen -X stuff 注入按键（导航 TUI）
 * - screen -X hardcopy 截取屏幕纯文本（无 ANSI 转义码）
 * - screen -X source 执行 stuff 命令文件（精确控制注入内容）
 *
 * 返回 URL 和 sendCode/waitForCredentials 回调。
 */
export async function startClaudeLogin(
  sandbox: Sandbox,
  config?: ClaudeLoginConfig,
): Promise<ClaudeLoginResult> {
  const enterInterval = config?.enterInterval ?? 2
  const maxRetries = config?.maxRetries ?? 30
  const installCmd = config?.installCommand
    ?? 'apt-get update -qq && apt-get install -y -qq screen'

  // 1. 确保 screen 已安装（需 root 权限安装包）
  const checkScreen = await sandbox.exec('which screen 2>/dev/null')
  if (checkScreen.exitCode !== 0) {
    const installResult = await sandbox.exec(installCmd, { timeout: 60_000, asRoot: true })
    if (installResult.exitCode !== 0) {
      throw new Error(`Failed to install screen: ${installResult.stderr || installResult.stdout}`)
    }
  }

  // 2. 清理旧文件和 screen 会话
  await sandbox.exec(
    `screen -S ${SCREEN_SESSION} -X quit 2>/dev/null || true; `
    + `rm -f '${SCREEN_OUTPUT}' /tmp/sandbank-code-debug /tmp/sandbank-screen-cmd`,
  )

  // 3. 在 screen 会话中启动 claude login
  //    **不要** stty columns 1000 — screen 虚拟终端固定 80 列，
  //    stty 改宽度会让 TUI 不换行，但超出 80 列的部分直接不可见（hardcopy 不捕获）。
  //    保持默认 80 列让 URL 自然换行，extractUrlFromText 会 trimEnd+join 重组。
  await sandbox.exec(
    `screen -dmS ${SCREEN_SESSION} bash -c 'exec claude login'`,
  )

  // 等待 screen 会话启动
  await new Promise(r => setTimeout(r, 2000))

  // 4. 反复检查屏幕并发送 Enter 直到出现 OAuth URL
  //    关键: 先检查再发送 Enter，避免 URL 出现后多发一个 Enter 误提交空 code
  let urlFound = false
  for (let i = 0; i < maxRetries; i++) {
    await new Promise(r => setTimeout(r, enterInterval * 1000))

    // 先检查当前屏幕（纯文本，无 ANSI 转义码）
    await sandbox.exec(`screen -S ${SCREEN_SESSION} -X hardcopy ${SCREEN_OUTPUT}`)
    const result = await sandbox.exec(`cat '${SCREEN_OUTPUT}' 2>/dev/null || true`)

    if (result.stdout.includes('claude.ai/oauth')) {
      urlFound = true
      break
    }

    // URL 未找到，发送 Enter 导航 TUI
    await sandbox.exec(`screen -S ${SCREEN_SESSION} -X stuff $'\\r'`)
  }

  if (!urlFound) {
    const output = await sandbox.exec(`cat '${SCREEN_OUTPUT}' 2>/dev/null || true`)
    throw new Error(
      `Failed to detect OAuth URL after ${maxRetries} retries.\n`
      + `Screen output:\n${output.stdout.substring(0, 1000)}`,
    )
  }

  // 5. 从 hardcopy 提取完整 URL（extractUrlFromText 处理 80 列断行）
  const screenResult = await sandbox.exec(`cat '${SCREEN_OUTPUT}' 2>/dev/null || true`)
  const url = extractUrlFromText(screenResult.stdout)
  if (!url) {
    throw new Error(
      `OAuth URL detected but failed to extract.\n`
      + `Screen output:\n${screenResult.stdout.substring(0, 1000)}`,
    )
  }

  // 6. sendCode: 用 screen source + stuff 注入 code
  const sendCode = async (code: string): Promise<void> => {
    // 检查当前 screen 状态 — 如果之前的 Enter 导致了 "Invalid code"，先恢复
    await sandbox.exec(`screen -S ${SCREEN_SESSION} -X hardcopy /tmp/sandbank-pre-send`)
    const preState = await sandbox.exec('cat /tmp/sandbank-pre-send 2>/dev/null')
    if (preState.stdout.match(/retry|try.again|Invalid/i)) {
      // 发送 Enter 跳过 retry 提示，回到 code 输入
      await sandbox.exec(`screen -S ${SCREEN_SESSION} -X stuff $'\\r'`)
      await new Promise(r => setTimeout(r, 3000))
    }

    // 直接用 screen -X stuff 注入 code + CR
    // 不能用 source 文件：auth code 含 # 字符，screen source 解析器会把 # 后内容当注释
    // 用 $'...\r' 安全发送：$'...' 内 # 是字面量，\r 被 bash 解释为 CR
    const escaped = code.replace(/\\/g, '\\\\').replace(/'/g, "\\'")
    await sandbox.exec(
      `screen -S ${SCREEN_SESSION} -X stuff $'${escaped}\\r'`,
    )
  }

  // 7. waitForCredentials
  const waitForCredentials = async (timeoutMs = 300_000): Promise<void> => {
    const homeResult = await sandbox.exec('echo $HOME')
    const home = homeResult.stdout.trim() || '/root'
    const credPath = `${home}/.claude/.credentials.json`
    const start = Date.now()
    const interval = 2000

    while (Date.now() - start < timeoutMs) {
      const check = await sandbox.exec(`test -s '${credPath}' && echo OK || echo MISSING`)
      if (check.stdout.trim() === 'OK') {
        return
      }
      await new Promise(r => setTimeout(r, interval))
    }

    // 收集诊断信息
    const diag: string[] = [`Timed out waiting for credentials at ${credPath} (${timeoutMs}ms)`]
    await sandbox.exec(`screen -S ${SCREEN_SESSION} -X hardcopy /tmp/sandbank-screen-final 2>/dev/null || true`)
    const screenFinal = await sandbox.exec('cat /tmp/sandbank-screen-final 2>/dev/null')
    if (screenFinal.stdout) diag.push(`Screen (final):\n${screenFinal.stdout}`)
    const codeDebug = await sandbox.exec('cat /tmp/sandbank-code-debug 2>/dev/null')
    if (codeDebug.stdout) diag.push(`Code debug:\n${codeDebug.stdout}`)
    const screenCmd = await sandbox.exec('cat /tmp/sandbank-screen-cmd 2>/dev/null')
    if (screenCmd.stdout) diag.push(`Screen cmd:\n${screenCmd.stdout}`)
    const psResult = await sandbox.exec('ps aux | grep -E "screen|claude" | grep -v grep 2>/dev/null')
    if (psResult.stdout) diag.push(`Processes:\n${psResult.stdout}`)
    throw new Error(diag.join('\n\n'))
  }

  return { url, sendCode, waitForCredentials }
}

// --- Internal ---

function buildHookDef(
  event: ClaudeHookEvent,
  config: InjectHooksConfig,
  isAsync: boolean,
): Record<string, unknown> {
  if (config.endpoint.type === 'http') {
    return {
      type: 'http',
      url: config.endpoint.url,
      ...(config.endpoint.headers ? { headers: config.endpoint.headers } : {}),
      timeout: 10,
    }
  }

  // file 模式: 使用 command hook 调用 handler 脚本
  return {
    type: 'command',
    command: HANDLER_SCRIPT_PATH,
    timeout: 5,
    async: isAsync,
  }
}

const URL_RE = /https?:\/\/[^\s'"><]+/g

/**
 * 从 screen hardcopy 纯文本中提取 OAuth URL。
 *
 * hardcopy 按 screen 虚拟终端宽度（默认 80 列）输出，
 * 长 URL 会被断行，每行尾部填充空格到 80 列。
 * 先 trimEnd 每行再拼接，消除断行产生的空格，重组完整 URL。
 */
function extractUrlFromText(text: string): string | null {
  if (!text) return null

  // 重组被 hardcopy 断行的长 URL
  const joined = text.split('\n').map(line => line.trimEnd()).join('')

  const urls = joined.match(URL_RE)
  if (!urls) return null

  const oauthUrls = urls.filter(u => u.includes('claude.ai/oauth'))
  if (oauthUrls.length === 0) return null

  return oauthUrls.reduce((a, b) => a.length >= b.length ? a : b)
}

async function writeHandlerScript(sandbox: Sandbox, eventsPath: string): Promise<void> {
  // 使用纯 POSIX shell 以保证最大兼容性
  // tr -d '\n' 确保多行 JSON 输入被压成单行 JSONL
  const script = `#!/bin/sh
TS=$(($(date +%s) * 1000))
INPUT=$(cat | tr -d '\\n')
printf '{"ts":%d,"data":%s}\\n' "$TS" "$INPUT" >> '${eventsPath}'
`
  await sandbox.writeFile(HANDLER_SCRIPT_PATH, script)
  // writeFile 以 root 写入，chmod 需 root 权限
  await sandbox.exec(`chmod +x '${HANDLER_SCRIPT_PATH}'`, { asRoot: true })
  // events 文件由 hook handler（以沙箱用户身份）追加写入，需用户可写
  await sandbox.exec(`touch '${eventsPath}'`)
}
