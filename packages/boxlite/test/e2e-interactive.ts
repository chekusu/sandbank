#!/usr/bin/env npx tsx
/**
 * 交互式 E2E 测试: 单进程，从文件读取 auth code，无超时限制
 *
 * 流程:
 *   1. 创建沙箱 (codebox:latest，预装 Claude Code) + 启动 OAuth 登录
 *   2. 复制 URL 到剪贴板，等待 auth code 写入 /tmp/sandbank-host-auth-code
 *   3. 发送 code → 等待凭证
 *   4. 注入 hooks → 运行 Claude Code → 验证事件
 *
 * 运行: pnpm exec tsx test/e2e-interactive.ts
 */
import { BoxLiteAdapter } from '@sandbank.dev/boxlite'
import { createProvider, startClaudeLogin, injectClaudeHooks, readHookEvents } from '@sandbank.dev/core'
import * as fs from 'node:fs'
import { execSync } from 'node:child_process'

const HOST_CODE_FILE = '/tmp/sandbank-host-auth-code'
const PYTHON_PATH = process.env['PYTHON_PATH'] ?? '/tmp/boxlite-venv/bin/python3'
const BOXLITE_HOME = '/tmp/sandbank-e2e-boxlite'
const SANDBOX_IMAGE = process.env['SANDBOX_IMAGE'] ?? 'codebox:latest'
// 跳过 Phase 2（仅测试登录）
const LOGIN_ONLY = process.argv.includes('--login-only')

function log(label: string, ...args: unknown[]) {
  console.log(`\x1b[36m[${label}]\x1b[0m`, ...args)
}

function pass(msg: string) {
  console.log(`  \x1b[32m✓\x1b[0m ${msg}`)
}

function fail(msg: string) {
  console.log(`  \x1b[31m✗\x1b[0m ${msg}`)
  process.exitCode = 1
}

function assert(cond: boolean, msg: string) {
  if (cond) pass(msg); else fail(msg)
}

async function main() {
  // 清理上次的 code 文件
  fs.rmSync(HOST_CODE_FILE, { force: true })

  const adapter = new BoxLiteAdapter({ mode: 'local', pythonPath: PYTHON_PATH, boxliteHome: BOXLITE_HOME })
  const provider = createProvider(adapter)
  let sandboxId: string | undefined

  try {
    // ═══ Phase 1: 创建沙箱 + 安装 Claude Code + OAuth 登录 ═══

    log('PHASE1', `Creating sandbox (${SANDBOX_IMAGE}, 5GB disk)...`)
    const sandbox = await provider.create({
      image: SANDBOX_IMAGE,
      resources: { disk: 5 },
      timeout: 120,
      user: 'sandbank',
    })
    sandboxId = sandbox.id
    log('PHASE1', `Sandbox: ${sandboxId}`)
    log('PHASE1', `User: ${sandbox.user?.name} (home: ${sandbox.user?.home})`)

    const ver = await sandbox.exec('claude --version 2>&1')
    log('PHASE1', `Claude Code: ${ver.stdout.trim()}`)

    log('PHASE1', 'Starting OAuth login...')
    const loginResult = await startClaudeLogin(sandbox)

    // 自动在浏览器中打开 OAuth URL
    try {
      execSync(`open ${JSON.stringify(loginResult.url)}`)
      log('PHASE1', 'OAuth URL 已在浏览器中打开 ✓')
    } catch {
      log('PHASE1', '无法自动打开浏览器，请手动打开以下 URL')
    }

    console.log('')
    console.log('\x1b[33m' + '='.repeat(60) + '\x1b[0m')
    console.log('\x1b[33m  OAuth URL:\x1b[0m')
    console.log(`  \x1b[32m${loginResult.url}\x1b[0m`)
    console.log('')
    console.log('\x1b[33m  授权后写入 auth code:\x1b[0m')
    console.log(`\x1b[32m  echo "YOUR_CODE" > ${HOST_CODE_FILE}\x1b[0m`)
    console.log('\x1b[33m' + '='.repeat(60) + '\x1b[0m')
    console.log('')

    // 等待 auth code（无硬超时，每 30 秒心跳）
    log('PHASE1', `Waiting for auth code in ${HOST_CODE_FILE}...`)
    let code = ''
    let tick = 0
    while (true) {
      try {
        if (fs.existsSync(HOST_CODE_FILE)) {
          code = fs.readFileSync(HOST_CODE_FILE, 'utf-8').trim()
          if (code) break
        }
      } catch {}

      tick++
      if (tick % 30 === 0) {
        try {
          await sandbox.exec('echo alive')
          log('HEARTBEAT', `Sandbox alive (${Math.floor(tick)} seconds)`)
        } catch (err) {
          throw new Error(`Sandbox heartbeat failed: ${err}`)
        }
      }
      await new Promise(r => setTimeout(r, 1000))
    }

    log('PHASE1', `Auth code received (${code.substring(0, 10)}...)`)
    await loginResult.sendCode(code)

    // 等待凭证
    log('PHASE1', 'Waiting for credentials...')
    const home = (await sandbox.exec('echo $HOME')).stdout.trim() || '/root'
    const credPath = `${home}/.claude/.credentials.json`

    for (let i = 0; i < 90; i++) {
      const check = await sandbox.exec(`test -s '${credPath}' && echo OK || echo WAIT`)
      if (check.stdout.trim() === 'OK') {
        pass('Credentials received!')

        // 关闭 screen 登录会话，避免干扰
        await sandbox.exec(`screen -S claude-login -X quit 2>/dev/null || true`)

        // 写入 ~/.claude.json 跳过 onboarding（必须在 login 完成后，否则影响 login 流程）
        const ver = (await sandbox.exec('claude --version 2>&1')).stdout.trim()
        await sandbox.writeFile(`${home}/.claude.json`, JSON.stringify({
          hasCompletedOnboarding: true,
          lastOnboardingVersion: ver,
        }))
        log('PHASE1', 'Wrote ~/.claude.json (skip onboarding)')

        // 诊断: 检查内存和网络
        const memInfo = await sandbox.exec('free -m 2>/dev/null || cat /proc/meminfo 2>/dev/null | head -5')
        log('DEBUG', `Memory: ${memInfo.stdout.trim().substring(0, 200)}`)
        const netCheck = await sandbox.exec('node -e "fetch(\'https://api.anthropic.com\').then(r=>console.log(\'API:\',r.status)).catch(e=>console.log(\'ERR:\',e.message))" 2>&1', { timeout: 15_000 })
        log('DEBUG', `Network: ${netCheck.stdout.trim()}`)

        // 验证 claude 可用
        // 现在以非 root 用户运行，可以用 --dangerously-skip-permissions
        log('PHASE1', 'Verifying claude (timeout 120s)...')
        const whoami = await sandbox.exec(
          'timeout 120 claude -p "Say hello" --dangerously-skip-permissions < /dev/null 2>&1',
          { timeout: 180_000 },
        )
        log('PHASE1', `Claude says: ${whoami.stdout.trim().substring(0, 500)}`)
        break
      }

      // 每 20 秒输出诊断
      if (i > 0 && i % 10 === 0) {
        const psCheck = await sandbox.exec('ps aux | grep -E "expect|claude" | grep -v grep')
        log('DEBUG', `Processes: ${psCheck.stdout.trim() || '(none)'}`)
        const codeDebug = await sandbox.exec('cat /tmp/sandbank-code-debug 2>/dev/null')
        if (codeDebug.stdout.trim()) log('DEBUG', `Code debug:\n${codeDebug.stdout.trim()}`)
        const expectOut = await sandbox.exec('tail -10 /tmp/claude-login-expect.out 2>/dev/null')
        if (expectOut.stdout.trim()) log('DEBUG', `Expect output:\n${expectOut.stdout.trim()}`)
      }

      if (i === 89) {
        fail('Credentials not found after 180s')
        // 完整诊断
        const loginLog = await sandbox.exec('tail -30 /tmp/claude-login.log 2>/dev/null')
        console.log(`\nLogin log:\n${loginLog.stdout}`)
        const expectOut = await sandbox.exec('cat /tmp/claude-login-expect.out 2>/dev/null')
        console.log(`\nExpect output:\n${expectOut.stdout}`)
        const codeDebug = await sandbox.exec('cat /tmp/sandbank-code-debug 2>/dev/null')
        console.log(`\nCode debug:\n${codeDebug.stdout}`)
        process.exit(1)
      }

      await new Promise(r => setTimeout(r, 2000))
    }

    if (LOGIN_ONLY) {
      log('DONE', '\x1b[32mPhase 1 完成!\x1b[0m')
      return
    }

    // ═══ Phase 2: 注入 Hooks → 运行 Claude Code → 验证事件 ═══

    log('PHASE2', 'Injecting Claude Code hooks (file mode)...')
    await injectClaudeHooks(sandbox, {
      endpoint: { type: 'file' },
      events: ['PostToolUse', 'Stop'],
    })

    const settings = await sandbox.exec(`cat '${home}/.claude/settings.json'`)
    const parsed = JSON.parse(settings.stdout)
    assert(!!parsed.hooks?.PostToolUse, 'PostToolUse hook configured')
    assert(!!parsed.hooks?.Stop, 'Stop hook configured')

    await sandbox.exec('mkdir -p /workspace && cd /workspace && git init 2>&1', { asRoot: true })
    await sandbox.exec('chown -R sandbank:sandbank /workspace', { asRoot: true })

    log('PHASE2', 'Running Claude Code (-p --dangerously-skip-permissions --max-turns 3)...')
    const claudeResult = await sandbox.exec(
      'cd /workspace && claude -p "Write hello world to /workspace/hello.txt" --dangerously-skip-permissions --max-turns 3 < /dev/null 2>&1',
      { timeout: 300_000 },
    )
    log('PHASE2', `Exit code: ${claudeResult.exitCode}`)
    log('PHASE2', `Output: ${claudeResult.stdout.substring(0, 500)}`)

    const fileCheck = await sandbox.exec('cat /workspace/hello.txt 2>/dev/null || echo FILE_NOT_FOUND')
    if (!fileCheck.stdout.includes('FILE_NOT_FOUND')) {
      pass(`File created: ${fileCheck.stdout.trim().substring(0, 80)}`)
    }

    log('PHASE2', 'Reading hook events...')
    const events = await readHookEvents(sandbox)
    log('PHASE2', `Captured ${events.length} hook events`)

    if (events.length > 0) {
      pass(`Captured ${events.length} events from real Claude Code`)
      for (const e of events) {
        const d = e.data as Record<string, unknown>
        console.log(`    [event] tool=${d.tool_name ?? d.hook_event_name ?? 'unknown'}`)
      }
      const toolEvents = events.filter(e => (e.data as Record<string, unknown>).hook_event_name === 'PostToolUse')
      assert(toolEvents.length > 0, 'At least one PostToolUse event')
    } else {
      fail('No hook events captured')
    }

    console.log('')
    log('DONE', process.exitCode === 1 ? '\x1b[31m部分测试失败\x1b[0m' : '\x1b[32m全部通过!\x1b[0m')

  } catch (err) {
    console.error('\x1b[31mERROR:\x1b[0m', err)
    if (sandboxId) log('INFO', `Sandbox ${sandboxId} preserved for debugging`)
    process.exit(1)
  } finally {
    if (sandboxId && process.exitCode === 1) {
      log('INFO', 'Sandbox preserved (exit code 1)')
    } else if (sandboxId) {
      log('CLEANUP', `Destroying sandbox ${sandboxId}`)
      await provider.destroy(sandboxId).catch(() => {})
    }
    await adapter.dispose()
  }
}

main().catch(err => {
  console.error('\x1b[31mFATAL:\x1b[0m', err)
  process.exit(1)
})
