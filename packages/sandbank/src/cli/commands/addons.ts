import type { CliFlags } from '../auth.js'
import { currentBoxId } from '../auth.js'
import { createApiClient, printJson } from '../api.js'

function takeOption(args: string[], name: string): string | undefined {
  const idx = args.indexOf(name)
  if (idx === -1) return undefined
  const value = args[idx + 1]
  args.splice(idx, 2)
  return value
}

export async function addonsCommand(args: string[], flags: CliFlags): Promise<void> {
  const sub = args[0]
  const boxId = takeOption(args, '--box') || currentBoxId()

  if (sub === 'create') {
    const type = args[1]
    if (!type) {
      console.error('Usage: sandbank addons create <type> [--intent "..."] [--box <id>]')
      process.exit(1)
    }
    if (!boxId) {
      console.error('No box ID. Use --box <id> or run inside a sandbox.')
      process.exit(1)
    }

    const intent = takeOption(args, '--intent') || args.slice(2).join(' ') || undefined
    const api = createApiClient(flags)
    const result = await api.x402Fetch<{ id: string; type: string; status: string; relay_name: string | null }>(
      `/boxes/${boxId}/addons`,
      { method: 'POST', body: JSON.stringify({ type, intent }) },
    )

    if (flags.json) return printJson(result)
    console.log(`${result.type} ${result.id} ${result.status}`)
    if (result.relay_name) console.log(`relay: ${result.relay_name}`)
    return
  }

  if (sub === 'list' || sub === 'ls') {
    if (!boxId) {
      console.error('No box ID. Use --box <id> or run inside a sandbox.')
      process.exit(1)
    }

    const api = createApiClient(flags)
    const addons = await api.x402Fetch<Array<{ id: string; type: string; status: string; created_at: string }>>(
      `/boxes/${boxId}/addons`,
    )

    if (flags.json) return printJson(addons)
    if (addons.length === 0) { console.log('No addons'); return }
    for (const a of addons) {
      console.log(`${a.id}  ${a.type.padEnd(12)}  ${a.status.padEnd(8)}  ${a.created_at}`)
    }
    return
  }

  console.error('Usage: sandbank addons <create|list> ...')
  process.exit(1)
}
