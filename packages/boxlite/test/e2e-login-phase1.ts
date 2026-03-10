#!/usr/bin/env npx tsx
/**
 * Phase 1: 创建沙箱 → 安装 Claude Code → 运行 claude login → 输出 OAuth URL
 * 将 sandbox ID 写入 /tmp/sandbank-e2e-sandbox-id.txt 供 Phase 2 使用
 */
import { createProvider } from '@sandbank.dev/core'
import { startClaudeLogin } from '@sandbank.dev/core'
import { BoxLiteAdapter } from '@sandbank.dev/boxlite'

function log(label: string, ...args: unknown[]) {
  console.log(`\x1b[36m[${label}]\x1b[0m`, ...args)
}

async function main() {
  const pythonPath = process.env['PYTHON_PATH'] ?? '/tmp/boxlite-venv/bin/python3'
  const boxliteHome = '/tmp/sandbank-e2e-boxlite'

  const adapter = new BoxLiteAdapter({ mode: 'local', pythonPath, boxliteHome })
  const provider = createProvider(adapter)

  let sandboxId: string | undefined

  try {
    log('INIT', 'Creating sandbox (node:22-slim, 5GB disk)...')
    const sandbox = await provider.create({
      image: 'node:22-slim',
      resources: { disk: 5 },
      timeout: 120,
    })
    sandboxId = sandbox.id
    log('INIT', `Sandbox created: ${sandboxId}`)

    // 保存 sandbox ID
    const fs = await import('node:fs')
    fs.writeFileSync('/tmp/sandbank-e2e-sandbox-id.txt', sandboxId)

    // 安装 Claude Code
    log('INSTALL', 'Installing Claude Code (npm install -g @anthropic-ai/claude-code)...')
    const install = await sandbox.exec(
      'npm install -g @anthropic-ai/claude-code 2>&1 | tail -5',
      { timeout: 300_000 },
    )
    log('INSTALL', install.stdout.trim())

    const ver = await sandbox.exec('claude --version 2>&1')
    log('INSTALL', `Claude Code version: ${ver.stdout.trim()}`)

    // 运行 claude login 自动化
    log('LOGIN', 'Starting claude login automation...')
    const result = await startClaudeLogin(sandbox)

    console.log('')
    console.log('\x1b[33m' + '='.repeat(60) + '\x1b[0m')
    console.log('\x1b[33m  请在浏览器中打开以下 URL 完成 OAuth 授权：\x1b[0m')
    console.log('')
    console.log(`  \x1b[32m${result.url}\x1b[0m`)
    console.log('')
    console.log('\x1b[33m  Sandbox ID: ' + sandboxId + '\x1b[0m')
    console.log('\x1b[33m' + '='.repeat(60) + '\x1b[0m')
    console.log('')

    // 等待 auth code 文件出现（从 host 文件系统读取）
    const hostCodeFile = '/tmp/sandbank-host-auth-code'
    fs.rmSync(hostCodeFile, { force: true })
    log('LOGIN', `Waiting for auth code file: ${hostCodeFile}`)
    log('LOGIN', `写入 code: echo "YOUR_CODE" > ${hostCodeFile}`)

    const codeStartTime = Date.now()
    let code = ''
    let heartbeatCount = 0
    while (Date.now() - codeStartTime < 600_000) {
      try {
        if (fs.existsSync(hostCodeFile)) {
          code = fs.readFileSync(hostCodeFile, 'utf-8').trim()
          if (code) break
        }
      } catch {}
      // 每 10 秒对 sandbox 做一次心跳检测
      heartbeatCount++
      if (heartbeatCount % 10 === 0) {
        try {
          const hb = await sandbox.exec('echo alive')
          if (hb.stdout.trim() !== 'alive') {
            log('WARN', `Sandbox heartbeat unexpected: ${hb.stdout.trim()}`)
          }
        } catch (hbErr) {
          log('ERROR', `Sandbox heartbeat failed: ${hbErr}`)
          throw new Error(`Sandbox died while waiting for auth code: ${hbErr}`)
        }
      }
      await new Promise(r => setTimeout(r, 1000))
    }
    if (!code) throw new Error('Timed out waiting for auth code file')

    log('LOGIN', `Sending auth code (${code.substring(0, 10)}...)`)
    await result.sendCode(code)

    // 等待凭证（2 分钟超时，code 发送后应很快完成）
    log('LOGIN', 'Waiting for credentials...')
    await result.waitForCredentials(120_000)

    log('LOGIN', 'Credentials received! ✓')

    // 写入 ~/.claude.json 跳过 onboarding（必须在 login 完成后，否则影响 login 流程）
    const home = (await sandbox.exec('echo $HOME')).stdout.trim() || '/root'
    const ver2 = (await sandbox.exec('claude --version 2>&1')).stdout.trim()
    await sandbox.writeFile(`${home}/.claude.json`, JSON.stringify({
      hasCompletedOnboarding: true,
      lastOnboardingVersion: ver2,
    }))
    log('VERIFY', 'Wrote ~/.claude.json (skip onboarding)')

    // 验证 claude 可用（--dangerously-skip-permissions 不能在 root 下使用，用 acceptEdits）
    log('VERIFY', 'Running claude -p --permission-mode acceptEdits ...')
    const whoami = await sandbox.exec('timeout 120 claude -p "Say hello" --permission-mode acceptEdits < /dev/null 2>&1', { timeout: 180_000 })
    log('VERIFY', `Claude response: ${whoami.stdout.trim().substring(0, 200)}`)

    console.log('')
    log('DONE', 'Phase 1 complete. Sandbox ready for integration test.')
    log('DONE', `Sandbox ID saved to /tmp/sandbank-e2e-sandbox-id.txt`)

  } catch (err) {
    console.error('\x1b[31mERROR:\x1b[0m', err)
    // 出错时不销毁沙箱，方便调试
    if (sandboxId) {
      log('INFO', `Sandbox ${sandboxId} preserved for debugging`)
    }
    process.exit(1)
  } finally {
    await adapter.dispose()
  }
}

main().catch((err) => {
  console.error('\x1b[31mFATAL:\x1b[0m', err)
  process.exit(1)
})
