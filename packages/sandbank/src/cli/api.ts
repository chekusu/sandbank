import { createX402Fetch } from '@sandbank.dev/cloud'
import type { CliFlags } from './auth.js'
import { resolveCloudConfig } from './auth.js'

export type ApiClient = ReturnType<typeof createX402Fetch>

export function createApiClient(flags: CliFlags): ApiClient {
  return createX402Fetch(resolveCloudConfig(flags))
}

export function printJson(value: unknown): void {
  console.log(JSON.stringify(value, null, 2))
}
