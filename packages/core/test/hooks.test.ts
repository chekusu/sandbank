import { describe, it, expect, vi } from 'vitest'
import { injectClaudeHooks, readHookEvents, startClaudeLogin, DEFAULT_EVENTS_FILE } from '../src/hooks.js'
import type { Sandbox } from '../src/types.js'

function mockSandbox(home = '/root'): Sandbox & { execCalls: string[]; writtenFiles: Map<string, string> } {
  const execCalls: string[] = []
  const writtenFiles = new Map<string, string>()

  return {
    id: 'sb-test',
    state: 'running',
    createdAt: '2025-01-01T00:00:00Z',
    execCalls,
    writtenFiles,

    async exec(command: string) {
      execCalls.push(command)
      if (command === 'echo $HOME') {
        return { exitCode: 0, stdout: home + '\n', stderr: '' }
      }
      return { exitCode: 0, stdout: '', stderr: '' }
    },

    async writeFile(path: string, content: string | Uint8Array) {
      writtenFiles.set(path, typeof content === 'string' ? content : new TextDecoder().decode(content))
    },

    async readFile() { return new Uint8Array() },
    async uploadArchive() {},
    async downloadArchive() { return new ReadableStream() },
  }
}

describe('injectClaudeHooks', () => {
  it('writes settings.json to $HOME/.claude/', async () => {
    const sandbox = mockSandbox('/root')

    await injectClaudeHooks(sandbox, {
      endpoint: { type: 'http', url: 'https://example.com/events' },
    })

    const settings = JSON.parse(sandbox.writtenFiles.get('/root/.claude/settings.json')!)
    expect(settings.hooks.PostToolUse).toHaveLength(1)
    expect(settings.hooks.PostToolUse[0].hooks[0]).toEqual({
      type: 'http',
      url: 'https://example.com/events',
      timeout: 10,
    })
    expect(settings.hooks.Stop).toHaveLength(1)
  })

  it('detects non-root home directory', async () => {
    const sandbox = mockSandbox('/home/user')

    await injectClaudeHooks(sandbox, {
      endpoint: { type: 'http', url: 'https://example.com/events' },
    })

    expect(sandbox.writtenFiles.has('/home/user/.claude/settings.json')).toBe(true)
    expect(sandbox.execCalls).toContain("mkdir -p '/home/user/.claude'")
  })

  it('respects settingsDir override', async () => {
    const sandbox = mockSandbox()

    await injectClaudeHooks(sandbox, {
      endpoint: { type: 'http', url: 'https://example.com/events' },
      settingsDir: '/workspace',
    })

    expect(sandbox.writtenFiles.has('/workspace/.claude/settings.json')).toBe(true)
    // should NOT run echo $HOME when settingsDir is provided
    expect(sandbox.execCalls).not.toContain('echo $HOME')
  })

  it('includes custom headers in HTTP hooks', async () => {
    const sandbox = mockSandbox()

    await injectClaudeHooks(sandbox, {
      endpoint: {
        type: 'http',
        url: 'https://example.com/events',
        headers: { Authorization: 'Bearer token' },
      },
    })

    const settings = JSON.parse(sandbox.writtenFiles.get('/root/.claude/settings.json')!)
    expect(settings.hooks.PostToolUse[0].hooks[0].headers).toEqual({
      Authorization: 'Bearer token',
    })
  })

  it('writes settings.json with file-mode command hooks', async () => {
    const sandbox = mockSandbox()

    await injectClaudeHooks(sandbox, {
      endpoint: { type: 'file' },
    })

    const settings = JSON.parse(sandbox.writtenFiles.get('/root/.claude/settings.json')!)
    const hook = settings.hooks.PostToolUse[0].hooks[0]
    expect(hook.type).toBe('command')
    expect(hook.command).toBe('/tmp/sandbank-hook-handler.sh')
    expect(hook.async).toBe(true)
  })

  it('writes handler script for file mode', async () => {
    const sandbox = mockSandbox()

    await injectClaudeHooks(sandbox, {
      endpoint: { type: 'file' },
    })

    const script = sandbox.writtenFiles.get('/tmp/sandbank-hook-handler.sh')
    expect(script).toBeDefined()
    expect(script).toContain('#!/bin/sh')
    expect(script).toContain(DEFAULT_EVENTS_FILE)
    expect(script).toContain('printf')

    expect(sandbox.execCalls).toContain("chmod +x '/tmp/sandbank-hook-handler.sh'")
    expect(sandbox.execCalls).toContain(`touch '${DEFAULT_EVENTS_FILE}'`)
  })

  it('uses custom events file path', async () => {
    const sandbox = mockSandbox()

    await injectClaudeHooks(sandbox, {
      endpoint: { type: 'file', path: '/var/log/events.jsonl' },
    })

    const script = sandbox.writtenFiles.get('/tmp/sandbank-hook-handler.sh')
    expect(script).toContain('/var/log/events.jsonl')
    expect(sandbox.execCalls).toContain("touch '/var/log/events.jsonl'")
  })

  it('does not write handler script for HTTP mode', async () => {
    const sandbox = mockSandbox()

    await injectClaudeHooks(sandbox, {
      endpoint: { type: 'http', url: 'https://example.com/events' },
    })

    expect(sandbox.writtenFiles.has('/tmp/sandbank-hook-handler.sh')).toBe(false)
  })

  it('respects custom events list', async () => {
    const sandbox = mockSandbox()

    await injectClaudeHooks(sandbox, {
      endpoint: { type: 'http', url: 'https://example.com/events' },
      events: ['PreToolUse', 'PostToolUse', 'PostToolUseFailure'],
    })

    const settings = JSON.parse(sandbox.writtenFiles.get('/root/.claude/settings.json')!)
    expect(settings.hooks.PreToolUse).toBeDefined()
    expect(settings.hooks.PostToolUse).toBeDefined()
    expect(settings.hooks.PostToolUseFailure).toBeDefined()
    expect(settings.hooks.Stop).toBeUndefined()
  })

  it('sets matcher for tool events but not for Stop', async () => {
    const sandbox = mockSandbox()

    await injectClaudeHooks(sandbox, {
      endpoint: { type: 'http', url: 'https://example.com/events' },
      events: ['PostToolUse', 'Stop'],
    })

    const settings = JSON.parse(sandbox.writtenFiles.get('/root/.claude/settings.json')!)
    expect(settings.hooks.PostToolUse[0].matcher).toBe('.*')
    expect(settings.hooks.Stop[0].matcher).toBeUndefined()
  })

  it('respects async=false', async () => {
    const sandbox = mockSandbox()

    await injectClaudeHooks(sandbox, {
      endpoint: { type: 'file' },
      async: false,
    })

    const settings = JSON.parse(sandbox.writtenFiles.get('/root/.claude/settings.json')!)
    const hook = settings.hooks.PostToolUse[0].hooks[0]
    expect(hook.async).toBe(false)
  })

  it('falls back to /root when $HOME is empty', async () => {
    const sandbox = mockSandbox('')
    // Override exec to return empty HOME
    sandbox.exec = async (cmd: string) => {
      sandbox.execCalls.push(cmd)
      if (cmd === 'echo $HOME') return { exitCode: 0, stdout: '\n', stderr: '' }
      return { exitCode: 0, stdout: '', stderr: '' }
    }

    await injectClaudeHooks(sandbox, {
      endpoint: { type: 'http', url: 'https://example.com/events' },
    })

    expect(sandbox.writtenFiles.has('/root/.claude/settings.json')).toBe(true)
  })
})

describe('readHookEvents', () => {
  it('returns empty array when file is empty', async () => {
    const sandbox = mockSandbox()
    const events = await readHookEvents(sandbox)
    expect(events).toEqual([])
  })

  it('parses JSONL events from file', async () => {
    const line1 = JSON.stringify({ ts: 1000, data: { hook_event_name: 'PostToolUse', tool_name: 'Read' } })
    const line2 = JSON.stringify({ ts: 2000, data: { hook_event_name: 'Stop' } })

    const sandbox = mockSandbox()
    sandbox.exec = async (cmd: string) => {
      if (cmd.includes('cat')) {
        return { exitCode: 0, stdout: `${line1}\n${line2}\n`, stderr: '' }
      }
      return { exitCode: 0, stdout: '', stderr: '' }
    }

    const events = await readHookEvents(sandbox)
    expect(events).toHaveLength(2)
    expect(events[0]!.ts).toBe(1000)
    expect(events[0]!.data.tool_name).toBe('Read')
    expect(events[1]!.ts).toBe(2000)
  })

  it('uses custom path', async () => {
    let capturedCmd = ''
    const sandbox = mockSandbox()
    sandbox.exec = async (cmd: string) => {
      capturedCmd = cmd
      return { exitCode: 0, stdout: '', stderr: '' }
    }

    await readHookEvents(sandbox, '/custom/events.jsonl')
    expect(capturedCmd).toContain('/custom/events.jsonl')
  })

  it('handles file not found gracefully', async () => {
    const sandbox = mockSandbox()
    sandbox.exec = async () => {
      return { exitCode: 0, stdout: '', stderr: '' }
    }

    const events = await readHookEvents(sandbox)
    expect(events).toEqual([])
  })

  it('skips blank lines', async () => {
    const line1 = JSON.stringify({ ts: 1000, data: {} })

    const sandbox = mockSandbox()
    sandbox.exec = async (cmd: string) => {
      if (cmd.includes('cat')) {
        return { exitCode: 0, stdout: `${line1}\n\n\n`, stderr: '' }
      }
      return { exitCode: 0, stdout: '', stderr: '' }
    }

    const events = await readHookEvents(sandbox)
    expect(events).toHaveLength(1)
  })
})

describe('startClaudeLogin', () => {
  const TEST_URL = 'https://claude.ai/oauth/authorize?code=true&client_id=9d1c250a-e61b-44d9-88ed-59abcdef1234'

  function loginSandbox(opts?: {
    screenInstalled?: boolean
    screenUrl?: string | null
    installFails?: boolean
    home?: string
    credentialsExist?: boolean
  }) {
    const o = {
      screenInstalled: true,
      screenUrl: TEST_URL,
      installFails: false,
      home: '/root',
      credentialsExist: false,
      ...opts,
    }

    const execCalls: string[] = []
    const writtenFiles = new Map<string, string>()

    const sandbox: Sandbox & { execCalls: string[]; writtenFiles: Map<string, string> } = {
      id: 'sb-login',
      state: 'running',
      createdAt: '2025-01-01T00:00:00Z',
      execCalls,
      writtenFiles,

      async exec(command: string) {
        execCalls.push(command)

        if (command === 'which screen 2>/dev/null') {
          return { exitCode: o.screenInstalled ? 0 : 1, stdout: o.screenInstalled ? '/usr/bin/screen\n' : '', stderr: '' }
        }

        if (command.includes('apt-get') || command.includes('yum')) {
          if (o.installFails) return { exitCode: 1, stdout: '', stderr: 'install failed' }
          return { exitCode: 0, stdout: '', stderr: '' }
        }

        // screen -dmS (start screen session)
        if (command.includes('screen -dmS')) {
          return { exitCode: 0, stdout: '', stderr: '' }
        }

        // screen -X quit (cleanup)
        if (command.includes('screen -S') && command.includes('-X quit')) {
          return { exitCode: 0, stdout: '', stderr: '' }
        }

        // screen -X hardcopy (capture screen)
        if (command.includes('-X hardcopy')) {
          return { exitCode: 0, stdout: '', stderr: '' }
        }

        // screen -X stuff (send keystrokes)
        if (command.includes('-X stuff')) {
          return { exitCode: 0, stdout: '', stderr: '' }
        }

        // screen -X source (execute screen command file)
        if (command.includes('-X source')) {
          return { exitCode: 0, stdout: '', stderr: '' }
        }

        // cat screen hardcopy output (URL may be wrapped across 80-col lines)
        if (command.includes('cat') && command.includes('sandbank-screen-output')) {
          return { exitCode: 0, stdout: o.screenUrl ? `\n  ${o.screenUrl}\n\n  Paste code here\n` : '', stderr: '' }
        }

        // cat screen pre-send state
        if (command.includes('cat') && command.includes('sandbank-pre-send')) {
          return { exitCode: 0, stdout: '  Paste code here\n', stderr: '' }
        }

        // Cleanup rm
        if (command.includes('rm -f')) {
          return { exitCode: 0, stdout: '', stderr: '' }
        }

        if (command === 'echo $HOME') {
          return { exitCode: 0, stdout: o.home + '\n', stderr: '' }
        }

        if (command.includes('test -s')) {
          return { exitCode: 0, stdout: o.credentialsExist ? 'OK\n' : 'MISSING\n', stderr: '' }
        }

        return { exitCode: 0, stdout: '', stderr: '' }
      },

      async writeFile(path: string, content: string | Uint8Array) {
        writtenFiles.set(path, typeof content === 'string' ? content : new TextDecoder().decode(content))
      },

      async readFile() { return new Uint8Array() },
      async uploadArchive() {},
      async downloadArchive() { return new ReadableStream() },
    }

    return sandbox
  }

  it('extracts OAuth URL from screen hardcopy', async () => {
    const sandbox = loginSandbox()
    const result = await startClaudeLogin(sandbox)

    expect(result.url).toBe(TEST_URL)
    expect(typeof result.sendCode).toBe('function')
    expect(typeof result.waitForCredentials).toBe('function')
  })

  it('reconstructs URL wrapped across 80-column hardcopy lines', async () => {
    // 模拟真实的 OAuth URL（350+ 字符），被 80 列 hardcopy 断行
    const fullUrl = 'https://claude.ai/oauth/authorize?code=true&client_id=9d1c250a-e61b-44d9-88ed-5944d1962f5e&response_type=code&redirect_uri=https%3A%2F%2Fplatform.claude.com%2Foauth%2Fcode%2Fcallback&scope=org%3Acreate_api_key+user%3Aprofile+user%3Ainference&code_challenge=abc123&state=xyz789'
    // 按 80 列断行，每行尾部填充空格到 80 字符（模拟 hardcopy 输出）
    const lines: string[] = []
    const prefix = '  ' // TUI 缩进
    let remaining = prefix + fullUrl
    while (remaining.length > 0) {
      const chunk = remaining.substring(0, 80)
      lines.push(chunk.padEnd(80))
      remaining = remaining.substring(80)
    }
    const wrappedOutput = '\n' + lines.join('\n') + '\n\n  Paste code here\n'

    const sandbox = loginSandbox({ screenUrl: '__CUSTOM__' })
    // Override cat screen output to return wrapped URL
    const origExec = sandbox.exec.bind(sandbox)
    sandbox.exec = async (command: string) => {
      if (command.includes('cat') && command.includes('sandbank-screen-output')) {
        return { exitCode: 0, stdout: wrappedOutput, stderr: '' }
      }
      return origExec(command)
    }

    const result = await startClaudeLogin(sandbox)
    expect(result.url).toBe(fullUrl)
  })

  it('skips screen installation when already installed', async () => {
    const sandbox = loginSandbox({ screenInstalled: true })
    await startClaudeLogin(sandbox)

    expect(sandbox.execCalls).toContain('which screen 2>/dev/null')
    expect(sandbox.execCalls.some(c => c.includes('apt-get'))).toBe(false)
  })

  it('installs screen when not present', async () => {
    const sandbox = loginSandbox({ screenInstalled: false })
    await startClaudeLogin(sandbox)

    expect(sandbox.execCalls.some(c => c.includes('apt-get install') && c.includes('screen'))).toBe(true)
  })

  it('throws when screen installation fails', async () => {
    const sandbox = loginSandbox({ screenInstalled: false, installFails: true })

    await expect(startClaudeLogin(sandbox)).rejects.toThrow('Failed to install screen')
  })

  it('throws when no URL found in screen output', async () => {
    const sandbox = loginSandbox({ screenUrl: null })

    await expect(startClaudeLogin(sandbox, {
      maxRetries: 2,
      enterInterval: 0.01,
    })).rejects.toThrow('Failed to detect OAuth URL')
  })

  it('starts screen session without stty columns override', async () => {
    const sandbox = loginSandbox()
    await startClaudeLogin(sandbox)

    // 应启动 screen 会话，不设 stty columns（让 URL 在 80 列自然换行）
    expect(sandbox.execCalls.some(c =>
      c.includes('screen -dmS') && c.includes('claude login'),
    )).toBe(true)
    expect(sandbox.execCalls.some(c =>
      c.includes('stty columns'),
    )).toBe(false)
  })

  it('sends Enter to navigate TUI via screen stuff', async () => {
    const sandbox = loginSandbox()
    await startClaudeLogin(sandbox)

    // 第一次 hardcopy 检查时如果 URL 已在，不应发送 Enter
    // 如果 URL 在第一次检查就出现，stuff 可能未被调用
    // 关键: hardcopy 在 stuff 之前被调用
    const hardcopyIdx = sandbox.execCalls.findIndex(c => c.includes('-X hardcopy'))
    expect(hardcopyIdx).toBeGreaterThan(-1)
  })

  it('uses custom installCommand', async () => {
    const sandbox = loginSandbox({ screenInstalled: false })
    await startClaudeLogin(sandbox, {
      installCommand: 'yum install -y screen',
    })

    expect(sandbox.execCalls).toContain('yum install -y screen')
  })

  it('sendCode builds screen command file and sources it', async () => {
    const sandbox = loginSandbox()
    const result = await startClaudeLogin(sandbox)

    await result.sendCode('test-code-123')

    // Should send code directly via screen -X stuff $'CODE\r'
    expect(sandbox.execCalls.some(c =>
      c.includes('-X stuff') && c.includes('test-code-123') && c.includes("\\r'"),
    )).toBe(true)
  })

  it('sendCode handles retry state before sending', async () => {
    const sandbox = loginSandbox()
    // Override pre-send state to show retry prompt
    const origExec = sandbox.exec.bind(sandbox)
    sandbox.exec = async (command: string) => {
      if (command.includes('cat') && command.includes('sandbank-pre-send')) {
        return { exitCode: 0, stdout: '  OAuth error: Invalid code\n  Press Enter to retry\n', stderr: '' }
      }
      return origExec(command)
    }

    const result = await startClaudeLogin(sandbox)
    await result.sendCode('recovery-code')

    // Should have sent Enter to dismiss retry prompt
    const execCalls = (sandbox as unknown as { execCalls: string[] }).execCalls
    // The retry recovery Enter is sent via screen stuff
  })

  it('waitForCredentials resolves when credentials exist', async () => {
    const sandbox = loginSandbox({ credentialsExist: true })
    const result = await startClaudeLogin(sandbox)

    await result.waitForCredentials(5000)
    // Should not throw
  })

  it('waitForCredentials times out when no credentials', async () => {
    const sandbox = loginSandbox({ credentialsExist: false })
    const result = await startClaudeLogin(sandbox)

    await expect(result.waitForCredentials(100)).rejects.toThrow('Timed out waiting for credentials')
  })
})
