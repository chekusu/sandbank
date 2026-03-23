#!/usr/bin/env node

import { loginCommand } from './commands/login.js'
import { configCommand } from './commands/config.js'
import { createCommand } from './commands/create.js'
import { listCommand } from './commands/list.js'
import { getCommand } from './commands/get.js'
import { destroyCommand } from './commands/destroy.js'
import { execCommand } from './commands/exec.js'
import { cloneCommand } from './commands/clone.js'
import { keepCommand } from './commands/keep.js'
import { addonsCommand } from './commands/addons.js'
import { snapshotCommand } from './commands/snapshot.js'
import { helpCommand } from './commands/help.js'
import type { CliFlags } from './auth.js'

export const VERSION = '0.5.1'

export function takeFlag(args: string[], name: string): boolean {
  const idx = args.indexOf(name)
  if (idx === -1) return false
  args.splice(idx, 1)
  return true
}

export function takeOption(args: string[], name: string): string | undefined {
  const idx = args.indexOf(name)
  if (idx === -1) return undefined
  const value = args[idx + 1]
  args.splice(idx, 2)
  return value
}

export function parseGlobalFlags(args: string[]): CliFlags {
  return {
    apiKey: takeOption(args, '--api-key'),
    walletKey: takeOption(args, '--wallet-key'),
    url: takeOption(args, '--url'),
    json: takeFlag(args, '--json'),
  }
}

export async function dispatch(args: string[]): Promise<void> {
  if (takeFlag(args, '--version') || takeFlag(args, '-v')) {
    console.log(VERSION)
    return
  }

  if (takeFlag(args, '--help') || takeFlag(args, '-h') || args.length === 0) {
    helpCommand()
    return
  }

  const command = args.shift()!
  const flags = parseGlobalFlags(args)

  switch (command) {
    case 'login':    return loginCommand(args, flags)
    case 'config':   return configCommand(args, flags)
    case 'create':   return createCommand(args, flags)
    case 'list':     return listCommand(args, flags)
    case 'ls':       return listCommand(args, flags)
    case 'get':      return getCommand(args, flags)
    case 'destroy':  return destroyCommand(args, flags)
    case 'rm':       return destroyCommand(args, flags)
    case 'exec':     return execCommand(args, flags)
    case 'clone':    return cloneCommand(args, flags)
    case 'keep':     return keepCommand(args, flags)
    case 'addons':   return addonsCommand(args, flags)
    case 'snapshot': return snapshotCommand(args, flags)
    case 'help':     return helpCommand()
    default:
      console.error(`Unknown command: ${command}`)
      helpCommand()
      process.exit(1)
  }
}

// Only run when executed directly (not when imported for testing)
const isDirectRun = process.argv[1]?.endsWith('/cli/index.js') || process.argv[1]?.endsWith('/cli/index.ts')
if (isDirectRun) {
  dispatch(process.argv.slice(2)).catch(err => {
    const msg = err instanceof Error ? err.message : String(err)
    console.error(msg)
    process.exit(1)
  })
}
