import type { CliFlags } from '../auth.js'
import { createApiClient, printJson } from '../api.js'

export async function snapshotCommand(args: string[], flags: CliFlags): Promise<void> {
  const sub = args[0]

  if (sub === 'create') {
    const id = args[1]
    const name = args[2]
    if (!id || !name) {
      console.error('Usage: sandbank snapshot create <box_id> <name>')
      process.exit(1)
    }
    const api = createApiClient(flags)
    await api.x402Fetch(`/boxes/${id}/snapshots`, {
      method: 'POST',
      body: JSON.stringify({ name }),
    })
    if (flags.json) printJson({ id, name, created: true })
    else console.log(`Snapshot "${name}" created for ${id}`)
    return
  }

  if (sub === 'list' || sub === 'ls') {
    const id = args[1]
    if (!id) {
      console.error('Usage: sandbank snapshot list <box_id>')
      process.exit(1)
    }
    const api = createApiClient(flags)
    const snapshots = await api.x402Fetch<Array<{ name: string; created_at?: string }>>(`/boxes/${id}/snapshots`)
    if (flags.json) return printJson(snapshots)
    if (snapshots.length === 0) { console.log('No snapshots'); return }
    for (const s of snapshots) {
      console.log(`${s.name}${s.created_at ? `  ${s.created_at}` : ''}`)
    }
    return
  }

  if (sub === 'restore') {
    const id = args[1]
    const name = args[2]
    if (!id || !name) {
      console.error('Usage: sandbank snapshot restore <box_id> <name>')
      process.exit(1)
    }
    const api = createApiClient(flags)
    await api.x402Fetch(`/boxes/${id}/snapshots/${encodeURIComponent(name)}/restore`, {
      method: 'POST',
      body: JSON.stringify({}),
    })
    if (flags.json) printJson({ id, name, restored: true })
    else console.log(`Restored "${name}" on ${id}`)
    return
  }

  if (sub === 'delete' || sub === 'rm') {
    const id = args[1]
    const name = args[2]
    if (!id || !name) {
      console.error('Usage: sandbank snapshot delete <box_id> <name>')
      process.exit(1)
    }
    const api = createApiClient(flags)
    await api.x402Fetch(`/boxes/${id}/snapshots/${encodeURIComponent(name)}`, {
      method: 'DELETE',
    })
    if (flags.json) printJson({ id, name, deleted: true })
    else console.log(`Deleted "${name}" from ${id}`)
    return
  }

  console.error('Usage: sandbank snapshot <create|list|restore|delete> ...')
  process.exit(1)
}
