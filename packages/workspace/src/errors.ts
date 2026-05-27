export type WorkspaceErrorCode =
  | 'NOT_FOUND'
  | 'ALREADY_EXISTS'
  | 'UNSUPPORTED'
  | 'INVALID_PATH'
  | 'CONFLICT'
  | 'LOCKED'

export class WorkspaceError extends Error {
  readonly code: WorkspaceErrorCode

  constructor(code: WorkspaceErrorCode, message: string) {
    super(message)
    this.name = 'WorkspaceError'
    this.code = code
  }
}
