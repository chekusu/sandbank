import type { CliFlags } from '../auth.js'
import type { CloudBox } from '@sandbank.dev/cloud'
import { createApiClient, printJson } from '../api.js'

function takeOption(args: string[], name: string): string | undefined {
  const idx = args.indexOf(name)
  if (idx === -1) return undefined
  const value = args[idx + 1]
  args.splice(idx, 2)
  return value
}

export async function createCommand(args: string[], flags: CliFlags): Promise<void> {
  const image = takeOption(args, '--image') || 'codebox'
  const cpu = Number(takeOption(args, '--cpu') || 2)
  const memory = Number(takeOption(args, '--memory') || 1024)
  const timeout = takeOption(args, '--timeout')

  const api = createApiClient(flags)
  const body: Record<string, unknown> = {
    image,
    cpu,
    memory_mb: memory,
  }
  if (timeout) body.timeout_minutes = Number(timeout)

  const box = await api.x402Fetch<CloudBox>('/boxes', {
    method: 'POST',
    body: JSON.stringify(body),
  })

  if (flags.json) return printJson(box)
  console.log(`${box.id} ${box.status} (${box.image})`)
}
