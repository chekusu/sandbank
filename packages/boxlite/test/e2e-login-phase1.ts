#!/usr/bin/env npx tsx
/**
 * Phase 1: 创建沙箱 (codebox:latest) → 运行 claude login → 输出 OAuth URL
 * 将 sandbox ID 写入 /tmp/sandbank-e2e-sandbox-id.txt 供 Phase 2 使用
 */
import { createProvider } from '@sandbank.dev/core'
import { startClaudeLogin } from '@sandbank.dev/core'
import { BoxLiteAdapter } from '@sandbank.dev/boxlite'
import * as fs from 'node:fs'
import { resolve, dirname } from 'node:path'
import { fileURLToPath } from 'node:url'

// Load .env (won't override existing env vars)
const __dir = dirname(fileURLToPath(import.meta.url))
try {
  for (const line of fs.readFileSync(resolve(__dir, '.env'), 'utf-8').split('\n')) {
    const m = line.match(/^(\w+)=(.*)$/)
    if (m && !(m[1] in process.env)) process.env[m[1]] = m[2].replace(/^~/, process.env['HOME']!)
  }
} catch {}

function log(label: string, ...args: unknown[]) {
  console.log(`\x1b[36m[${label}]\x1b[0m`, ...args)
}

async function main() {
  const pythonPath = process.env['PYTHON_PATH'] ?? '/tmp/boxlite-venv/bin/python3'
  const boxliteHome = process.env['BOXLITE_HOME'] ?? '/tmp/sandbank-e2e-boxlite'
  const image = process.env['SANDBOX_IMAGE'] ?? 'codebox:latest'

  const adapter = new BoxLiteAdapter({ mode: 'local', pythonPath, boxliteHome })
  const provider = createProvider(adapter)

  let sandboxId: string | undefined

  try {
    log('INIT', `Creating sandbox (${image}, 5GB disk)...`)
    const sandbox = await provider.create({
      image,
      resources: { disk: 5 },
      timeout: 120,
      user: 'sandbank',
    })
    sandboxId = sandbox.id
    log('INIT', `Sandbox created: ${sandboxId}`)
    log('INIT', `User: ${sandbox.user?.name} (home: ${sandbox.user?.home})`)

    // 保存 sandbox ID
    const fs = await import('node:fs')
    fs.writeFileSync('/tmp/sandbank-e2e-sandbox-id.txt', sandboxId)

    const ver = await sandbox.exec('claude --version 2>&1')
    log('INIT', `Claude Code version: ${ver.stdout.trim()}`)

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

    log('LOGIN', 'Credentials received!')

    // 写入 ~/.claude.json 跳过 onboarding（必须在 login 完成后，否则影响 login 流程）
    const home = (await sandbox.exec('echo $HOME')).stdout.trim() || '/root'
    const ver2 = (await sandbox.exec('claude --version 2>&1')).stdout.trim()
    await sandbox.writeFile(`${home}/.claude.json`, JSON.stringify({
      hasCompletedOnboarding: true,
      lastOnboardingVersion: ver2,
    }))
    log('VERIFY', 'Wrote ~/.claude.json (skip onboarding)')

    // 验证 claude 可用（非 root 用户可用 --dangerously-skip-permissions）
    log('VERIFY', 'Running claude -p --dangerously-skip-permissions ...')
    const whoami = await sandbox.exec('timeout 120 claude -p "Say hello" --dangerously-skip-permissions < /dev/null 2>&1', { timeout: 180_000 })
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
