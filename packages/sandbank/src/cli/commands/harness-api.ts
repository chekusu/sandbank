import type { DbNativeAgentHarnessEnv } from '../../harness-api.js'
import { startDbNativeAgentHarnessServer } from '../../harness-node.js'
import type { CliFlags } from '../auth.js'

export async function harnessApiCommand(args: string[], _flags: CliFlags): Promise<void> {
  if (takeFlag(args, '--help') || takeFlag(args, '-h')) {
    usage()
    return
  }

  const port = Number(takeOption(args, '--port') ?? process.env['SANDBANK_HARNESS_PORT'] ?? process.env['PORT'] ?? '8789')
  const host = takeOption(args, '--host') ?? process.env['SANDBANK_HARNESS_HOST'] ?? '0.0.0.0'

  if (!Number.isInteger(port) || port < 0 || port > 65535) {
    console.error('Usage: sandbank harness-api [--host <host>] [--port <port>]')
    process.exit(1)
  }

  const server = await startDbNativeAgentHarnessServer(process.env as DbNativeAgentHarnessEnv, { host, port })
  console.log(`sandbank db-native harness API listening on ${server.url}`)
  console.log(`POST ${server.url}/api/db-native-agent-harness/stream`)
  console.log(`GET  ${server.url}/api/db-native-agent-harness/capabilities`)
  console.log(`GET  ${server.url}/health`)

  await new Promise<void>(() => {})
}

function takeFlag(args: string[], name: string): boolean {
  const idx = args.indexOf(name)
  if (idx === -1) return false
  args.splice(idx, 1)
  return true
}

function takeOption(args: string[], name: string): string | undefined {
  const idx = args.indexOf(name)
  if (idx === -1) return undefined
  const value = args[idx + 1]
  args.splice(idx, 2)
  return value
}

function usage(): void {
  console.log(`Usage: sandbank harness-api [--host <host>] [--port <port>]

Starts the deployable DB-native agent harness API.

Routes:
  GET  /health
  GET  /api/db-native-agent-harness/capabilities
  POST /api/db-native-agent-harness/stream

Required env for live db9 + DeepSeek:
  DB9_DATABASE_ID
  DB9_TOKEN
  DEEPSEEK_API_KEY or CHATW_DEEPSEEK_API_KEY

Optional env:
  DEEPSEEK_MODEL=deepseek-v4-pro
  DEEPSEEK_BASE_URL=https://api.deepseek.com
  DB9_BASE_URL=https://db9.ai/api
  SANDBANK_HARNESS_API_KEY=<optional bearer token>`)
}
