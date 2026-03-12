import { x402Client, x402HTTPClient } from '@x402/core/client'
import { registerExactEvmScheme } from '@x402/evm/exact/client'
import { toClientEvmSigner } from '@x402/evm'
import { createPublicClient, http } from 'viem'
import { privateKeyToAccount } from 'viem/accounts'
import { base } from 'viem/chains'
import type { SandbankCloudConfig } from './types.js'

/**
 * Create a fetch wrapper that handles x402 payment automatically.
 * On HTTP 402 responses, it parses payment requirements, signs with the wallet,
 * and retries the request with the payment header.
 */
export function createX402Fetch(config: SandbankCloudConfig) {
  const baseUrl = (config.url || 'https://cloud.sandbank.dev').replace(/\/$/, '')
  const apiToken = config.apiToken

  // Setup x402 HTTP client if wallet is provided
  let httpClient: x402HTTPClient | null = null
  if (config.walletPrivateKey) {
    const account = privateKeyToAccount(config.walletPrivateKey as `0x${string}`)
    const publicClient = createPublicClient({ chain: base, transport: http() })
    const signer = toClientEvmSigner(account, publicClient)

    const client = new x402Client()
    registerExactEvmScheme(client, { signer })
    httpClient = new x402HTTPClient(client)
  }

  async function x402Fetch<T>(
    path: string,
    options: RequestInit = {},
  ): Promise<T> {
    const url = `${baseUrl}/v1${path}`
    const headers: Record<string, string> = {
      'Content-Type': 'application/json',
      ...(options.headers as Record<string, string>),
    }
    if (apiToken) {
      headers['Authorization'] = `Bearer ${apiToken}`
    }

    const response = await fetch(url, { ...options, headers })

    // Handle x402 payment
    if (response.status === 402 && httpClient) {
      const paymentRequired = httpClient.getPaymentRequiredResponse(
        (name) => response.headers.get(name),
        await response.clone().json().catch(() => undefined),
      )

      // Try hooks first (e.g., cached tokens) — if they succeed, return; if not, fall through to payment
      const hookHeaders = await httpClient.handlePaymentRequired(paymentRequired)
      if (hookHeaders) {
        const retryResp = await fetch(url, {
          ...options,
          headers: { ...headers, ...hookHeaders },
        })
        if (retryResp.ok) {
          const text = await retryResp.text()
          if (!text) throw new Error('Sandbank Cloud: empty response after x402 payment')
          return JSON.parse(text) as T
        }
        // Hook payment was rejected — don't create a second payment, throw immediately
        const body = await retryResp.text()
        throw new Error(`Sandbank Cloud API error ${retryResp.status} (after hook payment): ${body}`)
      }

      // Create payment payload and retry
      const paymentPayload = await httpClient.createPaymentPayload(paymentRequired)
      const paymentHeaders = httpClient.encodePaymentSignatureHeader(paymentPayload)

      const paidResponse = await fetch(url, {
        ...options,
        headers: { ...headers, ...paymentHeaders },
      })

      if (!paidResponse.ok) {
        const body = await paidResponse.text()
        throw new Error(`Sandbank Cloud API error ${paidResponse.status}: ${body}`)
      }

      const text = await paidResponse.text()
      if (!text) throw new Error('Sandbank Cloud: empty response after x402 payment')
      return JSON.parse(text) as T
    }

    if (response.status === 402) {
      throw new Error(
        'Sandbank Cloud: HTTP 402 Payment Required — provide walletPrivateKey for x402 payment or apiToken for authenticated access',
      )
    }

    if (!response.ok) {
      const body = await response.text()
      throw new Error(`Sandbank Cloud API error ${response.status}: ${body}`)
    }

    const text = await response.text()
    if (!text) {
      // Only DELETE returns empty bodies legitimately
      return undefined as T
    }
    return JSON.parse(text) as T
  }

  async function x402FetchRaw(
    path: string,
    options: RequestInit = {},
  ): Promise<Response> {
    const url = `${baseUrl}/v1${path}`
    const headers: Record<string, string> = {
      ...(options.headers as Record<string, string>),
    }
    if (apiToken) {
      headers['Authorization'] = `Bearer ${apiToken}`
    }
    // Default to JSON content type if body is present and no Content-Type set
    if (options.body && !headers['Content-Type']) {
      headers['Content-Type'] = 'application/json'
    }
    return fetch(url, { ...options, headers })
  }

  return { x402Fetch, x402FetchRaw, baseUrl }
}
