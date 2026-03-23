import type { CliFlags } from '../auth.js'
import type { CloudBox } from '@sandbank.dev/cloud'
import { createApiClient, printJson } from '../api.js'

export async function listCommand(args: string[], flags: CliFlags): Promise<void> {
  const api = createApiClient(flags)
  const boxes = await api.x402Fetch<CloudBox[]>('/boxes')

  if (flags.json) return printJson(boxes)

  if (boxes.length === 0) {
    console.log('No sandboxes')
    return
  }
  for (const box of boxes) {
    console.log(`${box.id}  ${box.status.padEnd(8)}  ${box.image}  ${box.created_at}`)
  }
}
