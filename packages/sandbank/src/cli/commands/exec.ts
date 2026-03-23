import type { CliFlags } from '../auth.js'
import type { CloudExecResult } from '@sandbank.dev/cloud'
import { createApiClient, printJson } from '../api.js'

export async function execCommand(args: string[], flags: CliFlags): Promise<void> {
  const id = args[0]
  const command = args.slice(1).join(' ')
  if (!id || !command) {
    console.error('Usage: sandbank exec <id> <command>')
    process.exit(1)
  }

  const api = createApiClient(flags)
  const result = await api.x402Fetch<CloudExecResult>(`/boxes/${id}/exec`, {
    method: 'POST',
    body: JSON.stringify({ cmd: ['bash', '-c', command] }),
  })

  if (flags.json) return printJson(result)

  if (result.stdout) process.stdout.write(result.stdout)
  if (result.stderr) process.stderr.write(result.stderr)
  if (result.exit_code !== 0) process.exit(result.exit_code)
}
