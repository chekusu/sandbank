/**
 * Pi (@earendil-works/pi-durable) tools from device tools. The result is a ToolRegistration: register it in an
 * extension like any tool made with defineTool.
 */
import { Type } from '@earendil-works/pi-ai'
import type { DeviceTool, DeviceToolContext } from './tools.js'

/** What Pi passes a tool's execute as `api`; only conversationId is read. */
export interface PiToolApi {
  readonly conversationId?: unknown
}

export interface PiDeviceTool {
  name: string
  description: string
  parameters: ReturnType<typeof Type.Unsafe>
  execute(args: Record<string, unknown>, api?: PiToolApi): Promise<{
    output: Array<{ type: 'text'; text: string } | { type: 'image'; data: string; mimeType: string }>
    isError?: true
  }>
}

/**
 * `context` gives the owner and, where the product draws cards, a showCard for this call's conversation.
 * Returns a value structurally compatible with pi-durable's ToolRegistration.
 */
export function toPiTool(tool: DeviceTool, context: (api: PiToolApi | undefined) => DeviceToolContext | Promise<DeviceToolContext>): PiDeviceTool {
  return {
    name: tool.name,
    description: tool.description,
    parameters: Type.Unsafe(tool.parameters),
    async execute(args, api) {
      const result = await tool.execute((args ?? {}) as Record<string, unknown>, await context(api))
      return { output: result.content, ...(result.isError ? { isError: true as const } : {}) }
    },
  }
}
