# Changelog

All notable changes to this project will be documented in this file.

## [Unreleased]

### Added
- `connectTerminal()` in `@sandbank/core` — wraps ttyd WebSocket binary protocol into `TerminalSession` interface with `write`/`onData`/`resize`/`close`
- GitHub Actions CI workflows (PR checks, integration tests, npm release)
- Vitest resolve aliases for cross-package imports without build step

### Fixed
- `uploadArchive`/`downloadArchive` error messages now correctly identify the unsupported operation instead of misleading `'snapshot'`
- Daytona integration tests now properly skip when `DAYTONA_API_KEY` is not set
- `@sandbank/relay` package resolution failure in tests (missing `dist/` directory)

### Changed
- README terminal capability updated from ❌ to ✅ for all providers (ttyd-based implementation)

## [0.1.0] - 2026-02-27

Initial release.

### Added

#### Core (`@sandbank/core`)
- `SandboxProvider` interface with `create`/`get`/`list`/`destroy` operations
- Capability system: `exec.stream`, `terminal`, `sleep`, `volumes`, `snapshot`, `port.expose`
- Type-safe capability detection: `withTerminal()`, `withStreaming()`, `withVolumes()`, etc.
- Error hierarchy: `SandboxError`, `SandboxNotFoundError`, `ExecTimeoutError`, `CapabilityNotSupportedError`, etc.
- `createSession()` for multi-agent orchestration with shared context
- `writeFileViaExec`/`readFileViaExec` fallbacks for adapters without native file I/O

#### Adapters
- `@sandbank/daytona` — Daytona cloud VM adapter (volumes, port.expose, terminal)
- `@sandbank/flyio` — Fly.io Machines adapter, zero external dependencies (volumes, port.expose, terminal)
- `@sandbank/cloudflare` — Cloudflare Workers adapter (exec.stream, snapshot, volumes, port.expose, terminal)

#### Communication
- `@sandbank/relay` — WebSocket + HTTP relay server with JSON-RPC 2.0 protocol
- `@sandbank/agent` — Lightweight in-sandbox client with `connect()`, messaging, and shared context

#### Testing
- Cross-provider conformance test suite (38+ tests)
- Unit tests for all packages
- Integration tests gated by environment variables (Daytona, Fly.io, Cloudflare)
- E2E tests for Cloudflare Workers

#### Documentation
- README in English, Chinese, and Japanese
