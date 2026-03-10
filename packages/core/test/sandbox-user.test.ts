import { describe, it, expect, vi } from 'vitest'
import { setupSandboxUser, wrapAsUser } from '../src/sandbox-user.js'
import type { AdapterSandbox } from '../src/types.js'

function mockAdapterSandbox(): AdapterSandbox {
  return {
    id: 'sb-mock',
    state: 'running',
    createdAt: '2025-01-01T00:00:00Z',
    exec: vi.fn(async (cmd: string) => {
      if (cmd.includes('sudoers.d/')) return { exitCode: 0, stdout: '', stderr: '' }
      if (cmd.includes('useradd') || cmd.startsWith('id ')) return { exitCode: 0, stdout: '', stderr: '' }
      if (cmd.startsWith('eval echo ~')) {
        const user = cmd.split('~')[1]!
        return { exitCode: 0, stdout: `/home/${user}\n`, stderr: '' }
      }
      return { exitCode: 0, stdout: '', stderr: '' }
    }),
  }
}

// --- wrapAsUser (pure function) ---

describe('wrapAsUser', () => {
  it('wraps simple command', () => {
    expect(wrapAsUser('echo hello', 'sandbank'))
      .toBe("su - sandbank -c 'echo hello'")
  })

  it('escapes single quotes in command', () => {
    expect(wrapAsUser("echo 'hi'", 'sandbank'))
      .toBe("su - sandbank -c 'echo '\\''hi'\\'''")
  })

  it('prepends cd with cwd', () => {
    expect(wrapAsUser('ls', 'sandbank', '/workspace'))
      .toBe('su - sandbank -c \'cd "/workspace" && ls\'')
  })

  it('handles cwd with spaces', () => {
    expect(wrapAsUser('ls', 'sandbank', '/my dir'))
      .toBe('su - sandbank -c \'cd "/my dir" && ls\'')
  })

  it('escapes dollar signs in cwd', () => {
    const result = wrapAsUser('ls', 'sandbank', '/path/$HOME')
    expect(result).toContain('\\$HOME')
  })

  it('handles different user names', () => {
    expect(wrapAsUser('whoami', 'claude'))
      .toBe("su - claude -c 'whoami'")
  })

  it('handles command with double quotes', () => {
    expect(wrapAsUser('echo "hello"', 'sandbank'))
      .toBe("su - sandbank -c 'echo \"hello\"'")
  })
})

// --- setupSandboxUser ---

describe('setupSandboxUser', () => {
  it('creates user with default name "sandbank"', async () => {
    const sandbox = mockAdapterSandbox()
    const result = await setupSandboxUser(sandbox, {})

    expect(result.name).toBe('sandbank')
    expect(result.home).toBe('/home/sandbank')
    expect(sandbox.exec).toHaveBeenCalledWith(
      expect.stringContaining('useradd -m -s /bin/bash'),
    )
  })

  it('creates user with string shorthand', async () => {
    const sandbox = mockAdapterSandbox()
    const result = await setupSandboxUser(sandbox, 'claude')

    expect(result.name).toBe('claude')
    expect(result.home).toBe('/home/claude')
  })

  it('creates user with custom UID', async () => {
    const sandbox = mockAdapterSandbox()
    await setupSandboxUser(sandbox, { name: 'sandbank', uid: 1500 })

    expect(sandbox.exec).toHaveBeenCalledWith(
      expect.stringContaining('-u 1500'),
    )
  })

  it('configures sudo by default', async () => {
    const sandbox = mockAdapterSandbox()
    await setupSandboxUser(sandbox, 'sandbank')

    const calls = (sandbox.exec as ReturnType<typeof vi.fn>).mock.calls
    const sudoCall = calls.find((c: string[]) => c[0].includes('sudoers.d/'))
    expect(sudoCall).toBeTruthy()
  })

  it('skips sudo when sudo: false', async () => {
    const sandbox = mockAdapterSandbox()
    await setupSandboxUser(sandbox, { name: 'sandbank', sudo: false })

    const calls = (sandbox.exec as ReturnType<typeof vi.fn>).mock.calls
    const sudoCall = calls.find((c: string[]) => c[0].includes('sudoers.d/'))
    expect(sudoCall).toBeUndefined()
  })

  it('throws when useradd fails', async () => {
    const sandbox: AdapterSandbox = {
      id: 'sb-mock',
      state: 'running',
      createdAt: '2025-01-01T00:00:00Z',
      exec: vi.fn(async (cmd: string) => {
        if (cmd.includes('useradd') || cmd.startsWith('id ')) {
          return { exitCode: 1, stdout: '', stderr: 'useradd: failed' }
        }
        return { exitCode: 0, stdout: '', stderr: '' }
      }),
    }

    await expect(setupSandboxUser(sandbox, 'baduser'))
      .rejects.toThrow("Failed to create user 'baduser'")
  })

  it('throws when home directory cannot be resolved', async () => {
    const sandbox: AdapterSandbox = {
      id: 'sb-mock',
      state: 'running',
      createdAt: '2025-01-01T00:00:00Z',
      exec: vi.fn(async (cmd: string) => {
        if (cmd.includes('useradd') || cmd.startsWith('id ')) {
          return { exitCode: 0, stdout: '', stderr: '' }
        }
        if (cmd.startsWith('eval echo ~')) {
          return { exitCode: 0, stdout: '~nouser\n', stderr: '' }
        }
        return { exitCode: 0, stdout: '', stderr: '' }
      }),
    }

    await expect(setupSandboxUser(sandbox, 'nouser'))
      .rejects.toThrow('Failed to resolve home directory')
  })
})
