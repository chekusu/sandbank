import { describe, it, expect } from 'vitest'
import {
  hasCapability,
  withStreaming,
  withTerminal,
  withSleep,
  withPortExpose,
  withSnapshot,
  withVolumes,
} from '../src/capabilities.js'
import type {
  Sandbox,
  SandboxProvider,
  ExecResult,
} from '../src/types.js'

/** Minimal mock sandbox */
function mockSandbox(extras: Record<string, unknown> = {}): Sandbox {
  return {
    id: 'test-id',
    state: 'running',
    createdAt: '2025-01-01T00:00:00Z',
    exec: async () => ({ stdout: '', stderr: '', exitCode: 0 }),
    writeFile: async () => {},
    readFile: async () => new Uint8Array(),
    uploadArchive: async () => {},
    downloadArchive: async () => new ReadableStream(),
    ...extras,
  }
}

/** Minimal mock provider */
function mockProvider(caps: string[], extras: Record<string, unknown> = {}): SandboxProvider {
  return {
    name: 'test',
    capabilities: new Set(caps) as ReadonlySet<any>,
    create: async () => mockSandbox(),
    get: async () => mockSandbox(),
    list: async () => [],
    destroy: async () => {},
    ...extras,
  }
}

describe('hasCapability', () => {
  it('returns true when capability exists', () => {
    const provider = mockProvider(['exec.stream', 'volumes'])
    expect(hasCapability(provider, 'exec.stream')).toBe(true)
    expect(hasCapability(provider, 'volumes')).toBe(true)
  })

  it('returns false when capability missing', () => {
    const provider = mockProvider(['exec.stream'])
    expect(hasCapability(provider, 'terminal')).toBe(false)
    expect(hasCapability(provider, 'sleep')).toBe(false)
  })

  it('returns false for empty capabilities', () => {
    const provider = mockProvider([])
    expect(hasCapability(provider, 'exec.stream')).toBe(false)
  })
})

describe('withStreaming', () => {
  it('returns StreamableSandbox when execStream exists', () => {
    const sandbox = mockSandbox({ execStream: async () => new ReadableStream() })
    const result = withStreaming(sandbox)
    expect(result).not.toBeNull()
    expect(result!.execStream).toBeDefined()
  })

  it('returns null when execStream missing', () => {
    const sandbox = mockSandbox()
    expect(withStreaming(sandbox)).toBeNull()
  })
})

describe('withTerminal', () => {
  it('returns TerminalSandbox when startTerminal exists', () => {
    const sandbox = mockSandbox({ startTerminal: async () => ({ url: 'ws://...', port: 8080 }) })
    const result = withTerminal(sandbox)
    expect(result).not.toBeNull()
  })

  it('returns null when startTerminal missing', () => {
    expect(withTerminal(mockSandbox())).toBeNull()
  })
})

describe('withSleep', () => {
  it('returns SleepableSandbox when sleep exists', () => {
    const sandbox = mockSandbox({ sleep: async () => {}, wake: async () => {} })
    const result = withSleep(sandbox)
    expect(result).not.toBeNull()
  })

  it('returns null when sleep missing', () => {
    expect(withSleep(mockSandbox())).toBeNull()
  })
})

describe('withPortExpose', () => {
  it('returns PortExposeSandbox when exposePort exists', () => {
    const sandbox = mockSandbox({ exposePort: async () => ({ url: 'https://...' }) })
    expect(withPortExpose(sandbox)).not.toBeNull()
  })

  it('returns null when exposePort missing', () => {
    expect(withPortExpose(mockSandbox())).toBeNull()
  })
})

describe('withSnapshot', () => {
  it('returns SnapshotSandbox when createSnapshot exists', () => {
    const sandbox = mockSandbox({ createSnapshot: async () => ({ snapshotId: 'snap-1' }) })
    expect(withSnapshot(sandbox)).not.toBeNull()
  })

  it('returns null when createSnapshot missing', () => {
    expect(withSnapshot(mockSandbox())).toBeNull()
  })
})

describe('withVolumes', () => {
  it('returns VolumeProvider when volume methods exist', () => {
    const provider = mockProvider(['volumes'], {
      createVolume: async () => ({ id: 'v1', name: 'vol', sizeGB: 1, attachedTo: null }),
      deleteVolume: async () => {},
      listVolumes: async () => [],
    })
    expect(withVolumes(provider)).not.toBeNull()
  })

  it('returns null when volume methods missing', () => {
    expect(withVolumes(mockProvider([]))).toBeNull()
  })
})
