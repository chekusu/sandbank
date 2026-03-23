import type { CliFlags } from '../auth.js'
import { createApiClient, printJson } from '../api.js'

function takeOption(args: string[], name: string): string | undefined {
  const idx = args.indexOf(name)
  if (idx === -1) return undefined
  const value = args[idx + 1]
  args.splice(idx, 2)
  return value
}

export async function keepCommand(args: string[], flags: CliFlags): Promise<void> {
  const minutes = Number(takeOption(args, '--minutes') || 30)
  const id = args[0]
  if (!id) {
    console.error('Usage: sandbank keep <id> [--minutes <n>]')
    process.exit(1)
  }

  const api = createApiClient(flags)
  const result = await api.x402Fetch<{ timeout_minutes: number }>(`/boxes/${id}/keep`, {
    method: 'POST',
    body: JSON.stringify({ timeout_minutes: minutes }),
  })

  if (flags.json) return printJson(result)
  console.log(`Extended ${id} by ${result.timeout_minutes} minutes`)
}
