import { describe, it, expect } from 'vitest'

describe('boxlite exports', () => {
  it('should export BoxLiteAdapter class', async () => {
    const mod = await import('../src/index.js')
    expect(mod.BoxLiteAdapter).toBeDefined()
    expect(typeof mod.BoxLiteAdapter).toBe('function')
  })
})
