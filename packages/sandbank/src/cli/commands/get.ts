import type { CliFlags } from '../auth.js'
import type { CloudBox } from '@sandbank.dev/cloud'
import { createApiClient, printJson } from '../api.js'

export async function getCommand(args: string[], flags: CliFlags): Promise<void> {
  const id = args[0]
  if (!id) {
    console.error('Usage: sandbank get <id>')
    process.exit(1)
  }

  const api = createApiClient(flags)
  const box = await api.x402Fetch<CloudBox>(`/boxes/${id}`)

  if (flags.json) return printJson(box)
  console.log(`id:      ${box.id}`)
  console.log(`status:  ${box.status}`)
  console.log(`image:   ${box.image}`)
  console.log(`cpu:     ${box.cpu}`)
  console.log(`memory:  ${box.memory_mb} MB`)
  console.log(`created: ${box.created_at}`)
  if (box.ports && Object.keys(box.ports).length > 0) {
    console.log(`ports:   ${JSON.stringify(box.ports)}`)
  }
}
