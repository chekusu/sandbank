import type { CliFlags } from '../auth.js'
import { currentBoxId } from '../auth.js'
import { createApiClient, printJson } from '../api.js'

export async function cloneCommand(args: string[], flags: CliFlags): Promise<void> {
  const id = args[0] || currentBoxId()
  if (!id) {
    console.error('Usage: sandbank clone <id>')
    console.error('Inside a sandbox, <id> defaults to the current box.')
    process.exit(1)
  }

  const api = createApiClient(flags)
  const result = await api.x402Fetch<{ id: string; status: string }>(`/boxes/${id}/clone`, {
    method: 'POST',
    body: JSON.stringify({}),
  })

  if (flags.json) return printJson(result)
  console.log(`Cloned ${id} → ${result.id} (${result.status})`)
}
