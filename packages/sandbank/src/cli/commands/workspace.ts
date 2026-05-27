import { mkdir, readFile, writeFile } from 'node:fs/promises'
import { dirname, resolve } from 'node:path'
import {
  MemoryWorkspaceAdapter,
  type MemoryWorkspaceSnapshot,
  type OpLogEntry,
  type WorkspaceEvent,
} from '@sandbank.dev/workspace'
import type { CliFlags } from '../auth.js'
import { printJson } from '../api.js'

export async function workspaceCommand(args: string[], flags: CliFlags): Promise<void> {
  const storePath = resolve(takeOption(args, '--store') ?? process.env['SANDBANK_WORKSPACE_STORE'] ?? '.sandbank-workspace.json')
  const recursive = takeFlag(args, '--recursive')
  const replay = takeFlag(args, '--replay')
  const sub = args.shift()

  if (!sub || sub === 'help') {
    usage()
    return
  }

  const workspace = await loadWorkspace(storePath)

  if (sub === 'inspect') {
    const snapshot = workspace.exportSnapshot()
    const info = {
      package: '@sandbank.dev/workspace',
      adapter: workspace.kind,
      store: storePath,
      capabilities: workspace.capabilities,
      files: snapshot.files.length,
      checkpoints: snapshot.checkpoints?.length ?? 0,
      ops: snapshot.opLog?.length ?? 0,
    }
    if (flags.json) printJson(info)
    else {
      console.log(`${info.package} ${info.adapter}`)
      console.log(`store ${info.store}`)
      console.log(`files ${info.files}`)
      console.log(`checkpoints ${info.checkpoints}`)
      console.log(`ops ${info.ops}`)
    }
    return
  }

  if (sub === 'list' || sub === 'ls') {
    const path = args[0] ?? '/'
    const entries = await workspace.list(path, { recursive })
    if (flags.json) return printJson(entries)
    for (const entry of entries) {
      console.log(`${entry.type.padEnd(9)} ${entry.path}${entry.size !== undefined ? ` ${entry.size}` : ''}`)
    }
    return
  }

  if (sub === 'read' || sub === 'cat') {
    const path = requireArg(args[0], 'Usage: sandbank workspace read <path>')
    const data = await workspace.read(path)
    console.log(typeof data === 'string' ? data : new TextDecoder().decode(data))
    return
  }

  if (sub === 'write') {
    const path = requireArg(args[0], 'Usage: sandbank workspace write <path> <data>')
    const data = requireArg(args[1], 'Usage: sandbank workspace write <path> <data>')
    const entry = await workspace.write(path, data)
    await saveWorkspace(storePath, workspace.exportSnapshot())
    if (flags.json) printJson(entry)
    else console.log(`wrote ${entry.path}`)
    return
  }

  if (sub === 'checkpoint') {
    const checkpoint = await workspace.checkpoint(args[0])
    await saveWorkspace(storePath, workspace.exportSnapshot())
    if (flags.json) printJson(checkpoint)
    else console.log(`checkpoint ${checkpoint.id} ${checkpoint.ref}`)
    return
  }

  if (sub === 'watch') {
    const path = args[0] ?? '/'
    if (replay) {
      const snapshot = workspace.exportSnapshot()
      for (const event of snapshotToEvents(snapshot, path)) {
        printEvent(event)
      }
      return
    }

    for await (const event of workspace.watch(path)) {
      printEvent(event)
    }
    return
  }

  usage()
  process.exit(1)
}

async function loadWorkspace(storePath: string): Promise<MemoryWorkspaceAdapter> {
  try {
    const raw = await readFile(storePath, 'utf8')
    return MemoryWorkspaceAdapter.fromSnapshot(JSON.parse(raw) as MemoryWorkspaceSnapshot)
  } catch (err) {
    if (isNotFound(err)) return new MemoryWorkspaceAdapter()
    throw err
  }
}

async function saveWorkspace(storePath: string, snapshot: MemoryWorkspaceSnapshot): Promise<void> {
  await mkdir(dirname(storePath), { recursive: true })
  await writeFile(storePath, `${JSON.stringify(snapshot, null, 2)}\n`, 'utf8')
}

function snapshotToEvents(snapshot: MemoryWorkspaceSnapshot, path: string): WorkspaceEvent[] {
  const prefix = normalizePath(path)
  return (snapshot.opLog ?? [])
    .filter(op => op.path && (op.path === prefix || op.path.startsWith(`${prefix}/`)))
    .map(opToEvent)
}

function opToEvent(op: OpLogEntry): WorkspaceEvent {
  const rawType = op.action.startsWith('workspace.') ? op.action.slice('workspace.'.length) : 'log'
  const type = rawType === 'write' || rawType === 'append' || rawType === 'remove' || rawType === 'move'
    || rawType === 'checkpoint' || rawType === 'rollback' || rawType === 'lock' || rawType === 'unlock'
    ? rawType
    : 'log'
  return { type, timestamp: op.createdAt, path: op.path, targetPath: op.targetPath, op }
}

function printEvent(event: WorkspaceEvent): void {
  console.log(`${event.type} ${event.path ?? ''}${event.targetPath ? ` -> ${event.targetPath}` : ''}`.trim())
}

function requireArg(value: string | undefined, message: string): string {
  if (value) return value
  console.error(message)
  process.exit(1)
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

function normalizePath(input: string): string {
  const parts: string[] = []
  for (const part of input.replace(/\\/g, '/').split('/')) {
    if (!part || part === '.') continue
    if (part === '..') parts.pop()
    else parts.push(part)
  }
  return `/${parts.join('/')}`
}

function isNotFound(err: unknown): boolean {
  return typeof err === 'object' && err !== null && 'code' in err && err.code === 'ENOENT'
}

function usage(): void {
  console.log(`Usage: sandbank workspace <command> [options]

Commands:
  inspect                         Show local workspace adapter and store info
  list [path] [--recursive]       List workspace entries
  read <path>                     Read a workspace file
  write <path> <data>             Write text to a workspace file
  watch [path] [--replay]         Watch events, or replay stored op log events
  checkpoint [label]              Create a local checkpoint

Options:
  --store <path>                  Local JSON store (default: .sandbank-workspace.json)`)
}
