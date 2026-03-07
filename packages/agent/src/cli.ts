#!/usr/bin/env node

import {
  sendMessage,
  recvMessages,
  contextGet,
  contextSet,
  contextDelete,
  contextKeys,
  complete,
} from './http-client.js'

async function main(): Promise<void> {
  const args = process.argv.slice(2)
  const command = args[0]

  if (!command) {
    printUsage()
    process.exit(1)
  }

  switch (command) {
    case 'send':
      await handleSend(args.slice(1))
      break
    case 'recv':
      await handleRecv(args.slice(1))
      break
    case 'context':
      await handleContext(args.slice(1))
      break
    case 'complete':
      await handleComplete(args.slice(1))
      break
    case 'help':
    case '--help':
    case '-h':
      printUsage()
      break
    default:
      console.error(`Unknown command: ${command}`)
      printUsage()
      process.exit(1)
  }
}

async function handleSend(args: string[]): Promise<void> {
  // sandbank-agent send <to> <type> [payload] [--steer]
  const steerIdx = args.indexOf('--steer')
  const priority = steerIdx >= 0 ? 'steer' as const : 'normal' as const
  const cleanArgs = args.filter((a) => a !== '--steer')

  const to = cleanArgs[0]
  const type = cleanArgs[1]
  const payloadStr = cleanArgs[2]

  if (!to || !type) {
    console.error('Usage: sandbank-agent send <to> <type> [payload] [--steer]')
    process.exit(1)
  }

  let payload: unknown = payloadStr ?? null
  if (typeof payloadStr === 'string') {
    try {
      payload = JSON.parse(payloadStr)
    } catch {
      // keep as string
    }
  }

  await sendMessage(to, type, payload, priority)
  console.log('OK')
}

async function handleRecv(args: string[]): Promise<void> {
  // sandbank-agent recv [--wait <seconds>] [--limit <n>]
  let wait = 0
  let limit = 100

  for (let i = 0; i < args.length; i++) {
    if (args[i] === '--wait' && args[i + 1]) {
      wait = parseInt(args[i + 1]!, 10) * 1000 // seconds → ms
      i++
    } else if (args[i] === '--limit' && args[i + 1]) {
      limit = parseInt(args[i + 1]!, 10)
      i++
    }
  }

  const messages = await recvMessages(limit, wait)
  console.log(JSON.stringify(messages, null, 2))
}

async function handleContext(args: string[]): Promise<void> {
  const sub = args[0]

  switch (sub) {
    case 'get': {
      const key = args[1]
      if (!key) {
        console.error('Usage: sandbank-agent context get <key>')
        process.exit(1)
      }
      const value = await contextGet(key)
      console.log(JSON.stringify(value, null, 2))
      break
    }
    case 'set': {
      const key = args[1]
      const valueStr = args[2]
      if (!key || valueStr === undefined) {
        console.error('Usage: sandbank-agent context set <key> <value>')
        process.exit(1)
      }
      let value: unknown = valueStr
      try {
        value = JSON.parse(valueStr)
      } catch {
        // keep as string
      }
      await contextSet(key, value)
      console.log('OK')
      break
    }
    case 'delete': {
      const key = args[1]
      if (!key) {
        console.error('Usage: sandbank-agent context delete <key>')
        process.exit(1)
      }
      await contextDelete(key)
      console.log('OK')
      break
    }
    case 'keys': {
      const keys = await contextKeys()
      console.log(JSON.stringify(keys, null, 2))
      break
    }
    default:
      console.error('Usage: sandbank-agent context <get|set|delete|keys> [args]')
      process.exit(1)
  }
}

async function handleComplete(args: string[]): Promise<void> {
  // sandbank-agent complete --status <status> --summary <text>
  let status = 'success'
  let summary = ''

  for (let i = 0; i < args.length; i++) {
    if (args[i] === '--status' && args[i + 1]) {
      status = args[i + 1]!
      i++
    } else if (args[i] === '--summary' && args[i + 1]) {
      summary = args[i + 1]!
      i++
    }
  }

  await complete(status, summary)
  console.log('OK')
}

function printUsage(): void {
  console.log(`sandbank-agent — Sandbank Agent CLI

Commands:
  send <to> <type> [payload] [--steer]   Send a message
  recv [--wait <sec>] [--limit <n>]      Receive messages
  context get <key>                      Get context value
  context set <key> <value>              Set context value
  context delete <key>                   Delete context key
  context keys                           List all context keys
  complete --status <s> --summary <text> Mark sandbox as complete

Environment variables:
  SANDBANK_RELAY_URL     Relay HTTP URL
  SANDBANK_SESSION_ID    Session ID
  SANDBANK_SANDBOX_NAME  This sandbox's name
  SANDBANK_AUTH_TOKEN    Auth token (required)`)
}

main().catch((err) => {
  console.error((err as Error).message)
  process.exit(1)
})
