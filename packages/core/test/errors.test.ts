import { describe, it, expect } from 'vitest'
import {
  SandboxError,
  SandboxNotFoundError,
  SandboxStateError,
  ExecTimeoutError,
  RateLimitError,
  ProviderError,
  CapabilityNotSupportedError,
} from '../src/errors.js'

describe('SandboxError', () => {
  it('sets provider and sandboxId', () => {
    const err = new SandboxError('test', 'daytona', 'sb-123')
    expect(err.message).toBe('test')
    expect(err.provider).toBe('daytona')
    expect(err.sandboxId).toBe('sb-123')
    expect(err.name).toBe('SandboxError')
    expect(err).toBeInstanceOf(Error)
  })
})

describe('SandboxNotFoundError', () => {
  it('formats message correctly', () => {
    const err = new SandboxNotFoundError('daytona', 'sb-123')
    expect(err.message).toContain('sb-123')
    expect(err.message).toContain('not found')
    expect(err.name).toBe('SandboxNotFoundError')
    expect(err).toBeInstanceOf(SandboxError)
  })
})

describe('SandboxStateError', () => {
  it('includes current and required state', () => {
    const err = new SandboxStateError('daytona', 'sb-1', 'stopped', 'running')
    expect(err.currentState).toBe('stopped')
    expect(err.requiredState).toBe('running')
    expect(err.message).toContain('stopped')
    expect(err.message).toContain('running')
    expect(err).toBeInstanceOf(SandboxError)
  })
})

describe('ExecTimeoutError', () => {
  it('includes timeout value', () => {
    const err = new ExecTimeoutError('flyio', 'sb-1', 30000)
    expect(err.timeout).toBe(30000)
    expect(err.message).toContain('30000')
    expect(err).toBeInstanceOf(SandboxError)
  })
})

describe('RateLimitError', () => {
  it('includes retryAfter when provided', () => {
    const err = new RateLimitError('daytona', 60)
    expect(err.retryAfter).toBe(60)
    expect(err.message).toContain('60')
  })

  it('works without retryAfter', () => {
    const err = new RateLimitError('daytona')
    expect(err.retryAfter).toBeUndefined()
    expect(err.message).toContain('Rate limited')
  })
})

describe('ProviderError', () => {
  it('wraps an Error cause', () => {
    const cause = new Error('connection refused')
    const err = new ProviderError('flyio', cause, 'sb-1')
    expect(err.message).toContain('connection refused')
    expect(err.cause).toBe(cause)
    expect(err).toBeInstanceOf(SandboxError)
  })

  it('wraps a string cause', () => {
    const err = new ProviderError('flyio', 'timeout')
    expect(err.message).toContain('timeout')
  })
})

describe('CapabilityNotSupportedError', () => {
  it('includes capability name and provider', () => {
    const err = new CapabilityNotSupportedError('flyio', 'exec.stream')
    expect(err.capability).toBe('exec.stream')
    expect(err.message).toContain('exec.stream')
    expect(err.message).toContain('flyio')
    expect(err).toBeInstanceOf(SandboxError)
  })
})
