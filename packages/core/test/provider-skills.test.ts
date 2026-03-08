import { describe, it, expect, vi } from 'vitest'
import { createProvider } from '../src/provider.js'
import type { SandboxAdapter, AdapterSandbox, Capability } from '../src/types.js'

function mockAdapterSandbox(overrides: Partial<AdapterSandbox> = {}): AdapterSandbox {
  return {
    id: 'sb-mock',
    state: 'running',
    createdAt: '2025-01-01T00:00:00Z',
    exec: vi.fn(async () => ({ exitCode: 0, stdout: '', stderr: '' })),
    ...overrides,
  }
}

function mockAdapter(overrides: Partial<SandboxAdapter> = {}): SandboxAdapter {
  const raw = mockAdapterSandbox()
  return {
    name: 'mock',
    capabilities: new Set<Capability>(),
    createSandbox: vi.fn(async () => raw),
    getSandbox: vi.fn(async () => raw),
    listSandboxes: vi.fn(async () => []),
    destroySandbox: vi.fn(async () => {}),
    ...overrides,
  }
}

describe('provider skill injection', () => {
  it('injects skills into sandbox when skills are provided in config', async () => {
    const writeFileFn = vi.fn(async () => {})
    const execFn = vi.fn(async () => ({ exitCode: 0, stdout: '', stderr: '' }))
    const adapter = mockAdapter({
      createSandbox: vi.fn(async () => mockAdapterSandbox({ writeFile: writeFileFn, exec: execFn })),
    })
    const provider = createProvider(adapter)

    await provider.create({
      image: 'node:22',
      skills: [
        { name: 'coding', content: '# Coding skill' },
        { name: 'testing', content: '# Testing skill' },
      ],
    })

    expect(writeFileFn).toHaveBeenCalledTimes(2)
    expect(writeFileFn).toHaveBeenCalledWith('/root/.claude/skills/coding.md', '# Coding skill')
    expect(writeFileFn).toHaveBeenCalledWith('/root/.claude/skills/testing.md', '# Testing skill')
  })

  it('does not call writeFile when skills is not provided', async () => {
    const writeFileFn = vi.fn(async () => {})
    const adapter = mockAdapter({
      createSandbox: vi.fn(async () => mockAdapterSandbox({ writeFile: writeFileFn })),
    })
    const provider = createProvider(adapter)

    await provider.create({ image: 'node:22' })

    expect(writeFileFn).not.toHaveBeenCalled()
  })

  it('does not call writeFile when skills is an empty array', async () => {
    const writeFileFn = vi.fn(async () => {})
    const adapter = mockAdapter({
      createSandbox: vi.fn(async () => mockAdapterSandbox({ writeFile: writeFileFn })),
    })
    const provider = createProvider(adapter)

    await provider.create({ image: 'node:22', skills: [] })

    expect(writeFileFn).not.toHaveBeenCalled()
  })

  it('destroys sandbox if skill injection fails', async () => {
    const writeFileFn = vi.fn(async () => { throw new Error('write failed') })
    const execFn = vi.fn(async () => ({ exitCode: 0, stdout: '', stderr: '' }))
    const destroyFn = vi.fn(async () => {})
    const adapter = mockAdapter({
      createSandbox: vi.fn(async () => mockAdapterSandbox({ writeFile: writeFileFn, exec: execFn })),
      destroySandbox: destroyFn,
    })
    const provider = createProvider(adapter)

    await expect(
      provider.create({
        image: 'node:22',
        skills: [{ name: 'bad', content: 'fail' }],
      }),
    ).rejects.toThrow('write failed')

    expect(destroyFn).toHaveBeenCalledWith('sb-mock')
  })
})
