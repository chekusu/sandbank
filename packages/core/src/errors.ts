import type { Capability, SandboxState } from './types.js'

/** 所有 SDK 错误的基类 */
export class SandboxError extends Error {
  readonly provider: string
  readonly sandboxId?: string

  constructor(message: string, provider: string, sandboxId?: string) {
    super(message)
    this.name = 'SandboxError'
    this.provider = provider
    this.sandboxId = sandboxId
  }
}

/** 沙箱不存在（已销毁或从未创建） */
export class SandboxNotFoundError extends SandboxError {
  constructor(provider: string, sandboxId: string) {
    super(`Sandbox '${sandboxId}' not found`, provider, sandboxId)
    this.name = 'SandboxNotFoundError'
  }
}

/** 沙箱状态不对（如在 stopped 状态下 exec） */
export class SandboxStateError extends SandboxError {
  readonly currentState: SandboxState
  readonly requiredState: SandboxState

  constructor(provider: string, sandboxId: string, currentState: SandboxState, requiredState: SandboxState) {
    super(
      `Sandbox '${sandboxId}' is '${currentState}', expected '${requiredState}'`,
      provider,
      sandboxId,
    )
    this.name = 'SandboxStateError'
    this.currentState = currentState
    this.requiredState = requiredState
  }
}

/** 命令执行超时 */
export class ExecTimeoutError extends SandboxError {
  readonly timeout: number

  constructor(provider: string, sandboxId: string, timeout: number) {
    super(`Command timed out after ${timeout}ms`, provider, sandboxId)
    this.name = 'ExecTimeoutError'
    this.timeout = timeout
  }
}

/** Provider 返回速率限制 */
export class RateLimitError extends SandboxError {
  readonly retryAfter?: number

  constructor(provider: string, retryAfter?: number) {
    super(
      retryAfter
        ? `Rate limited, retry after ${retryAfter}s`
        : 'Rate limited',
      provider,
    )
    this.name = 'RateLimitError'
    this.retryAfter = retryAfter
  }
}

/** Provider 自身错误（500、网络问题等） */
export class ProviderError extends SandboxError {
  override readonly cause: unknown

  constructor(provider: string, cause: unknown, sandboxId?: string) {
    const message = cause instanceof Error ? cause.message : String(cause)
    super(`Provider error: ${message}`, provider, sandboxId)
    this.name = 'ProviderError'
    this.cause = cause
  }
}

/** 不支持的能力 */
export class CapabilityNotSupportedError extends SandboxError {
  readonly capability: Capability

  constructor(provider: string, capability: Capability) {
    super(`Capability '${capability}' is not supported by '${provider}'`, provider)
    this.name = 'CapabilityNotSupportedError'
    this.capability = capability
  }
}
