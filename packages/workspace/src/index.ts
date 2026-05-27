export type {
  AgentOp,
  Checkpoint,
  ListOptions,
  MoveOptions,
  OpId,
  OpLogEntry,
  QueryResult,
  ReadOptions,
  RemoveOptions,
  TransactionOptions,
  WatchOptions,
  Workspace,
  WorkspaceAdapter,
  WorkspaceCapabilities,
  WorkspaceData,
  WorkspaceDiff,
  WorkspaceDiffEntry,
  WorkspaceEntry,
  WorkspaceEntryType,
  WorkspaceEvent,
  WorkspaceEventType,
  WorkspaceLock,
  WorkspaceQuery,
  WorkspaceRef,
  WorkspaceTx,
  WriteOptions,
} from './types.js'
export { WorkspaceError } from './errors.js'
export type { WorkspaceErrorCode } from './errors.js'
export {
  MemoryWorkspaceAdapter,
  memoryWorkspaceCapabilities,
} from './memory.js'
export type { MemoryWorkspaceSnapshot } from './memory.js'
