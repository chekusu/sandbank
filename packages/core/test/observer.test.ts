import { describe, it, expect, vi } from 'vitest'
import {
  emitEvent,
  createNoopObserver,
  createWebhookObserver,
} from '../src/observer.js'
import type { SandboxEvent, SandboxObserver } from '../src/observer.js'

function makeEvent(overrides: Partial<SandboxEvent> = {}): SandboxEvent {
  return {
    type: 'sandbox:exec',
    sandboxId: 'sb-1',
    timestamp: 1000,
    data: { command: 'echo hi' },
    ...overrides,
  }
}

describe('emitEvent', () => {
  it('calls observer.onEvent with the event', () => {
    const onEvent = vi.fn()
    emitEvent({ onEvent }, makeEvent())
    expect(onEvent).toHaveBeenCalledWith(makeEvent())
  })

  it('does not throw when observer.onEvent throws synchronously', () => {
    const observer: SandboxObserver = {
      onEvent() { throw new Error('boom') },
    }
    expect(() => emitEvent(observer, makeEvent())).not.toThrow()
  })

  it('silently catches rejected promises from onEvent', () => {
    const observer: SandboxObserver = {
      onEvent() { return Promise.reject(new Error('async boom')) },
    }
    // should not cause unhandled rejection
    expect(() => emitEvent(observer, makeEvent())).not.toThrow()
  })

  it('works with async onEvent that resolves', () => {
    const observer: SandboxObserver = {
      onEvent() { return Promise.resolve() },
    }
    expect(() => emitEvent(observer, makeEvent())).not.toThrow()
  })
})

describe('createNoopObserver', () => {
  it('returns an observer that does nothing', () => {
    const observer = createNoopObserver()
    expect(() => observer.onEvent(makeEvent())).not.toThrow()
  })
})

describe('createWebhookObserver', () => {
  it('POSTs event to the given URL', async () => {
    const mockFetch = vi.fn(async () => new Response('ok'))
    vi.stubGlobal('fetch', mockFetch)

    const observer = createWebhookObserver('https://example.com/events')
    const event = makeEvent({ taskId: 't-1' })
    await observer.onEvent(event)

    expect(mockFetch).toHaveBeenCalledWith('https://example.com/events', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(event),
    })

    vi.unstubAllGlobals()
  })

  it('includes custom headers', async () => {
    const mockFetch = vi.fn(async () => new Response('ok'))
    vi.stubGlobal('fetch', mockFetch)

    const observer = createWebhookObserver('https://example.com/events', {
      headers: { Authorization: 'Bearer token-123' },
    })
    await observer.onEvent(makeEvent())

    expect(mockFetch).toHaveBeenCalledWith('https://example.com/events', {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        Authorization: 'Bearer token-123',
      },
      body: expect.any(String),
    })

    vi.unstubAllGlobals()
  })

  it('returns a promise (for fire-and-forget handling)', () => {
    const mockFetch = vi.fn(async () => new Response('ok'))
    vi.stubGlobal('fetch', mockFetch)

    const observer = createWebhookObserver('https://example.com/events')
    const result = observer.onEvent(makeEvent())
    expect(result).toBeInstanceOf(Promise)

    vi.unstubAllGlobals()
  })
})
