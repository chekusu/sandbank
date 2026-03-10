#!/usr/bin/env npx tsx
/**
 * Sandbox Observability 端到端集成测试
 * 使用 BoxLite (local mode) 验证:
 *   1. Layer 1: Provider observer 自动记录 exec/writeFile/readFile 事件
 *   2. Layer 2: 在沙箱中实际启动 Claude Code，验证 hooks 捕获工具调用事件
 *
 * 运行: ANTHROPIC_API_KEY=sk-... pnpm exec tsx test/integration-observability.ts
 */

import { createProvider } from '@sandbank.dev/core'
import type { SandboxEvent, SandboxObserver } from '@sandbank.dev/core'
import { injectClaudeHooks, readHookEvents } from '@sandbank.dev/core'
import { BoxLiteAdapter } from '@sandbank.dev/boxlite'

// ── Helpers ──────────────────────────────────────────────────────────────────

function log(label: string, ...args: unknown[]) {
  console.log(`\x1b[36m[${label}]\x1b[0m`, ...args)
}

function pass(msg: string) {
  console.log(`  \x1b[32m✓\x1b[0m ${msg}`)
}

function fail(msg: string, err?: unknown) {
  console.log(`  \x1b[31m✗\x1b[0m ${msg}`)
  if (err) console.error('   ', err)
}

function assert(condition: boolean, msg: string) {
  if (condition) pass(msg)
  else { fail(msg); process.exitCode = 1 }
}

// ── Main ─────────────────────────────────────────────────────────────────────

async function main() {
  const apiKey = process.env['ANTHROPIC_API_KEY']
  if (!apiKey) {
    console.error('ANTHROPIC_API_KEY is required')
    process.exit(1)
  }

  const pythonPath = process.env['PYTHON_PATH'] ?? '/tmp/boxlite-venv/bin/python3'
  const boxliteHome = process.env['BOXLITE_HOME'] ?? '/tmp/sandbank-test-boxlite'

  log('INIT', `BoxLite local mode (python: ${pythonPath}, home: ${boxliteHome})`)

  const adapter = new BoxLiteAdapter({ mode: 'local', pythonPath, boxliteHome })

  const events: SandboxEvent[] = []
  const observer: SandboxObserver = {
    onEvent(event) { events.push(event) },
  }

  const provider = createProvider(adapter, { observer, taskId: 'e2e-test' })

  let sandboxId: string | undefined
  try {
    // ── 创建沙箱（node 镜像，安装 Claude Code） ──────────────────────────

    log('SANDBOX', 'Creating sandbox with node:22-slim...')
    const sandbox = await provider.create({
      image: 'node:22-slim',
      env: { ANTHROPIC_API_KEY: apiKey },
      resources: { disk: 5 },
      timeout: 120,
    })
    sandboxId = sandbox.id
    log('SANDBOX', `Created: ${sandbox.id} (state: ${sandbox.state})`)

    // ── Layer 1: 验证 Provider Observer 基础事件 ─────────────────────────

    log('LAYER 1', 'Testing provider-level observer...')

    const execResult = await sandbox.exec('echo "hello observer"')
    assert(execResult.exitCode === 0, 'exec: exitCode=0')

    const execEvent = events.find(e => e.type === 'sandbox:exec')
    assert(!!execEvent, 'Layer 1: exec event emitted')
    assert(execEvent!.taskId === 'e2e-test', 'Layer 1: taskId attached')
    assert(typeof execEvent!.data.duration === 'number', 'Layer 1: duration tracked')

    await sandbox.writeFile('/tmp/test.txt', 'hello')
    assert(!!events.find(e => e.type === 'sandbox:writeFile'), 'Layer 1: writeFile event emitted')

    log('LAYER 1', `Events so far: ${events.length}`)

    // ── 安装 Claude Code ─────────────────────────────────────────────────

    log('INSTALL', 'Installing Claude Code (npm install -g @anthropic-ai/claude-code)...')
    const installResult = await sandbox.exec(
      'npm install -g @anthropic-ai/claude-code 2>&1',
      { timeout: 300_000 },
    )
    if (installResult.exitCode !== 0) {
      console.error(installResult.stdout)
      throw new Error(`Claude Code install failed: exit ${installResult.exitCode}`)
    }
    pass('Claude Code installed')

    // 验证 claude 可执行
    const versionResult = await sandbox.exec('claude --version 2>&1')
    log('INSTALL', `Claude Code version: ${versionResult.stdout.trim()}`)

    // ── Layer 2: 注入 hooks 并启动 Claude Code ──────────────────────────

    log('LAYER 2', 'Injecting hooks and launching Claude Code...')

    // 注入 file 模式 hooks
    await injectClaudeHooks(sandbox, {
      endpoint: { type: 'file' },
      events: ['PostToolUse', 'Stop'],
    })

    // 验证 hooks 配置已写入
    const homeResult = await sandbox.exec('echo $HOME')
    const home = homeResult.stdout.trim()
    const settingsCheck = await sandbox.exec(`cat '${home}/.claude/settings.json'`)
    assert(settingsCheck.exitCode === 0, 'Layer 2: settings.json exists')
    const settings = JSON.parse(settingsCheck.stdout)
    assert(!!settings.hooks.PostToolUse, 'Layer 2: PostToolUse hook configured')
    assert(!!settings.hooks.Stop, 'Layer 2: Stop hook configured')

    // 创建一个简单的工作目录
    await sandbox.exec('mkdir -p /workspace && cd /workspace && git init 2>&1')

    // 用一个简单的任务启动 Claude Code
    // --print 模式会执行任务然后退出，--max-turns 1 限制只执行一步
    log('LAYER 2', 'Running Claude Code with a simple task...')
    const claudeResult = await sandbox.exec(
      'cd /workspace && claude --print --max-turns 3 "Write hello world to /workspace/hello.txt" 2>&1',
      { timeout: 300_000 },
    )
    log('LAYER 2', `Claude Code exit: ${claudeResult.exitCode}`)
    if (claudeResult.stdout) {
      // 只打前 500 字符
      const preview = claudeResult.stdout.substring(0, 500)
      log('LAYER 2', `Claude output: ${preview}${claudeResult.stdout.length > 500 ? '...' : ''}`)
    }

    // 检查 Claude 是否成功创建了文件
    const fileCheck = await sandbox.exec('cat /workspace/hello.txt 2>/dev/null || echo "FILE_NOT_FOUND"')
    if (fileCheck.stdout.includes('FILE_NOT_FOUND')) {
      log('LAYER 2', 'Note: Claude did not create hello.txt (may have used different approach)')
    } else {
      pass(`Layer 2: Claude created file with content: ${fileCheck.stdout.trim().substring(0, 80)}`)
    }

    // ── 读取 hook 事件 ───────────────────────────────────────────────────

    log('LAYER 2', 'Reading hook events...')
    const hookEvents = await readHookEvents(sandbox)
    log('LAYER 2', `Hook events captured: ${hookEvents.length}`)

    if (hookEvents.length > 0) {
      pass(`Layer 2: ${hookEvents.length} hook event(s) captured from real Claude Code`)

      // 打印每个事件
      for (const e of hookEvents) {
        const toolName = (e.data as Record<string, unknown>).tool_name ?? (e.data as Record<string, unknown>).hook_event_name ?? 'unknown'
        console.log(`    [event] ts=${e.ts} tool=${toolName}`)
      }

      // 验证至少有一个 PostToolUse 事件
      const toolEvents = hookEvents.filter(e =>
        (e.data as Record<string, unknown>).hook_event_name === 'PostToolUse',
      )
      assert(toolEvents.length > 0, 'Layer 2: at least one PostToolUse event from Claude Code')

      // 验证有 tool_name
      const firstTool = toolEvents[0]
      if (firstTool) {
        assert(
          typeof (firstTool.data as Record<string, unknown>).tool_name === 'string',
          `Layer 2: event has tool_name: ${(firstTool.data as Record<string, unknown>).tool_name}`,
        )
      }
    } else {
      fail('Layer 2: No hook events captured — hooks may not have fired')
      // 调试: 检查事件文件是否存在
      const debugCheck = await sandbox.exec('ls -la /tmp/sandbank-hook-events.jsonl 2>&1 && echo "---" && cat /tmp/sandbank-hook-events.jsonl 2>&1')
      log('DEBUG', debugCheck.stdout)
    }

    // ── Summary ───────────────────────────────────────────────────────────

    console.log('')
    log('DONE', 'Integration test complete!')
    console.log('')
    log('SUMMARY', `Layer 1 provider events: ${events.length}`)
    const typeCounts = events.reduce((acc, e) => {
      acc[e.type] = (acc[e.type] ?? 0) + 1
      return acc
    }, {} as Record<string, number>)
    for (const [type, count] of Object.entries(typeCounts)) {
      console.log(`    ${type}: ${count}`)
    }
    console.log('')
    log('SUMMARY', `Layer 2 hook events: ${hookEvents.length}`)

  } finally {
    if (sandboxId) {
      log('CLEANUP', `Destroying sandbox ${sandboxId}`)
      await provider.destroy(sandboxId).catch(() => {})
    }
    await adapter.dispose()
  }
}

main().catch((err) => {
  console.error('\x1b[31mFATAL:\x1b[0m', err)
  process.exit(1)
})
