import type { CliFlags } from '../auth.js'
import { createApiClient } from '../api.js'

export async function destroyCommand(args: string[], flags: CliFlags): Promise<void> {
  const id = args[0]
  if (!id) {
    console.error('Usage: sandbank destroy <id>')
    process.exit(1)
  }

  const api = createApiClient(flags)
  await api.x402Fetch(`/boxes/${id}`, { method: 'DELETE' })

  if (flags.json) {
    console.log(JSON.stringify({ id, destroyed: true }))
  } else {
    console.log(`Destroyed ${id}`)
  }
}
