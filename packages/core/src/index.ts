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
  SleepableSandbox,
  PortExposeSandbox,
  SnapshotSandbox,
  VolumeProvider,
  VolumeConfig,
  VolumeInfo,
  // Adapter
  SandboxAdapter,
  AdapterSandbox,
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

// File helpers (for adapter authors)
export { writeFileViaExec, readFileViaExec } from './file-helpers.js'

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
