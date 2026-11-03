// @sandbank.dev/devices — cloud desktop, browser and phone for AI assistants, on Sandbank Cloud /v2 sessions.
export {
  DEFAULT_BASE_URL,
  DeviceApiError,
  LINK_PREFIXES,
  SandbankDevices,
  runOnDesktop,
  timedOutExit,
  trustedDeviceLink,
  wrapWithTimeout,
} from './client.js'
export type {
  ApiResponse,
  DeviceKind,
  DeviceLink,
  DeviceSession,
  DeviceState,
  ExecOutcome,
  SandbankDevicesEnv,
  SandbankDevicesOptions,
  Screenshot,
  UiTree,
} from './client.js'
export {
  BROWSER_ACTIONS,
  BROWSER_TOOL_DESCRIPTION,
  CARD_SHOWN_NOTE,
  COMMAND_TOOL_DESCRIPTION,
  COMPUTER_ACTIONS,
  COMPUTER_TOOL_DESCRIPTION,
  DEFAULT_COMMAND_TIMEOUT_SECONDS,
  LINK_AS_TEXT_NOTE,
  MAX_COMMAND_TIMEOUT_SECONDS,
  OUTPUT_LIMIT,
  PHONE_ACTIONS,
  PHONE_TOOL_DESCRIPTION,
  SCREEN_IS_DATA,
  clampTimeout,
  createBrowserTool,
  createCommandTool,
  createComputerTool,
  createDeviceTools,
  createPhoneTool,
  tail,
} from './tools.js'
export type { DeviceCard, DeviceTool, DeviceToolContext, DeviceToolName, DeviceToolOptions, DeviceToolResult, JsonSchema, ToolContent } from './tools.js'
export { accessMode, d1Allowlist, deviceAccessAllowed } from './access.js'
export type { AccessMode, D1Like } from './access.js'
