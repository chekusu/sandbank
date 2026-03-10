// Types
export type {
  // Core
  SandboxProvider,
  Sandbox,
  CreateConfig,
  ExecOptions,
  ExecResult,
  SandboxState,
  SandboxInfo,
  ListFilter,
  // Capabilities
  Capability,
  StreamableSandbox,
  TerminalSandbox,
  TerminalOptions,
  TerminalInfo,
  TerminalSession,
  Disposable,
  SleepableSandbox,
  PortExposeSandbox,
  SnapshotSandbox,
  VolumeProvider,
  VolumeConfig,
  VolumeInfo,
  // Service
  ServiceType,
  ServiceConfig,
  ServiceCredentials,
  ServiceInfo,
  ServiceProvider,
  ServiceBinding,
  // Adapter
  SandboxAdapter,
  AdapterSandbox,
  // Skill
  SkillDefinition,
  // User
  SandboxUser,
  SandboxUserInfo,
} from './types.js'

// Provider factory
export { createProvider } from './provider.js'

// Capability detection
export {
  hasCapability,
  withStreaming,
  withTerminal,
  withSleep,
  withPortExpose,
  withSnapshot,
  withVolumes,
  withServices,
} from './capabilities.js'

// Errors
export {
  SandboxError,
  SandboxNotFoundError,
  SandboxStateError,
  ExecTimeoutError,
  RateLimitError,
  ProviderError,
  CapabilityNotSupportedError,
} from './errors.js'

// Terminal session
export { connectTerminal } from './terminal.js'

// Skill injection
export { injectSkills } from './skill-inject.js'

// File helpers (for adapter authors)
export { writeFileViaExec, readFileViaExec, uploadArchiveViaExec, downloadArchiveViaExec } from './file-helpers.js'

// Sandbox user
export { setupSandboxUser, wrapAsUser } from './sandbox-user.js'

// Observer
export type { SandboxEvent, SandboxEventType, SandboxObserver, ProviderOptions } from './observer.js'
export { emitEvent, createNoopObserver, createWebhookObserver } from './observer.js'

// Hooks (Claude Code inner-agent observation)
export type { ClaudeHookEvent, InjectHooksConfig, HookEventData, ClaudeLoginConfig, ClaudeLoginResult } from './hooks.js'
export { injectClaudeHooks, readHookEvents, startClaudeLogin, DEFAULT_EVENTS_FILE } from './hooks.js'

// Session types
export type {
  MessagePriority,
  SessionMessage,
  ContextStore,
  CompletionStatus,
  SandboxCompletion,
  SendOptions,
  Session,
  RelayConfig,
  CreateSessionConfig,
  JsonRpcRequest,
  JsonRpcResponse,
  JsonRpcNotification,
  JsonRpcError,
  Transport,
} from './session-types.js'

// Session factory
export { createSession } from './session.js'
