import type { JsonRpcRequest, JsonRpcResponse } from '@sandbank.dev/core'
import { createRequest } from './rpc.js'

export interface HttpClientConfig {
  relayUrl: string
  sessionId: string
  sandboxName: string
  token: string
}

function getConfig(): HttpClientConfig {
  const relayUrl = process.env['SANDBANK_RELAY_URL']
  const sessionId = process.env['SANDBANK_SESSION_ID']
  const sandboxName = process.env['SANDBANK_SANDBOX_NAME']
  const token = process.env['SANDBANK_AUTH_TOKEN']

  if (!relayUrl) throw new Error('Missing SANDBANK_RELAY_URL')
  if (!sessionId) throw new Error('Missing SANDBANK_SESSION_ID')
  if (!sandboxName) throw new Error('Missing SANDBANK_SANDBOX_NAME')
  if (!token) throw new Error('Missing SANDBANK_AUTH_TOKEN')

  return { relayUrl, sessionId, sandboxName, token }
}

async function rpcCall(method: string, params?: Record<string, unknown>): Promise<unknown> {
  const config = getConfig()
  const request = createRequest(method, params)

  const response = await fetch(`${config.relayUrl}/rpc`, {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      'X-Session-Id': config.sessionId,
      'X-Sandbox-Name': config.sandboxName,
      'X-Auth-Token': config.token,
    },
    body: JSON.stringify(request),
  })

  const result = await response.json() as JsonRpcResponse
  if (result.error) {
    throw new Error(`RPC error ${result.error.code}: ${result.error.message}`)
  }
  return result.result
}

export async function sendMessage(
  to: string,
  type: string,
  payload: unknown,
  priority: 'normal' | 'steer' = 'normal',
): Promise<void> {
  await rpcCall('message.send', { to, type, payload, priority })
}

export async function recvMessages(
  limit = 100,
  waitMs = 0,
): Promise<unknown[]> {
  const result = await rpcCall('message.recv', { limit, wait: waitMs }) as { messages: unknown[] }
  return result.messages
}

export async function contextGet(key: string): Promise<unknown> {
  const result = await rpcCall('context.get', { key }) as { value: unknown }
  return result.value ?? undefined
}

export async function contextSet(key: string, value: unknown): Promise<void> {
  await rpcCall('context.set', { key, value })
}

export async function contextDelete(key: string): Promise<void> {
  await rpcCall('context.delete', { key })
}

export async function contextKeys(): Promise<string[]> {
  const result = await rpcCall('context.keys') as { keys: string[] }
  return result.keys
}

export async function complete(status: string, summary: string): Promise<void> {
  await rpcCall('sandbox.complete', { status, summary })
}
