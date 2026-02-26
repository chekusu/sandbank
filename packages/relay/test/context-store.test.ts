import { describe, it, expect, vi } from 'vitest'
import { ContextStoreServer } from '../src/context-store.js'

describe('ContextStoreServer', () => {
  it('should set and get values', () => {
    const ctx = new ContextStoreServer()
    ctx.set('key1', 'value1')
    expect(ctx.get('key1')).toBe('value1')
  })

  it('should return undefined for missing keys', () => {
    const ctx = new ContextStoreServer()
    expect(ctx.get('missing')).toBeUndefined()
  })

  it('should delete keys', () => {
    const ctx = new ContextStoreServer()
    ctx.set('key1', 'value1')
    expect(ctx.delete('key1')).toBe(true)
    expect(ctx.get('key1')).toBeUndefined()
  })

  it('should return false when deleting non-existent key', () => {
    const ctx = new ContextStoreServer()
    expect(ctx.delete('missing')).toBe(false)
  })

  it('should list keys', () => {
    const ctx = new ContextStoreServer()
    ctx.set('a', 1)
    ctx.set('b', 2)
    ctx.set('c', 3)
    expect(ctx.keys()).toEqual(['a', 'b', 'c'])
  })

  it('should notify watchers on set', () => {
    const ctx = new ContextStoreServer()
    const fn = vi.fn()
    ctx.watch(fn)

    ctx.set('key1', 'value1')
    expect(fn).toHaveBeenCalledWith('key1', 'value1')
  })

  it('should notify watchers on delete', () => {
    const ctx = new ContextStoreServer()
    ctx.set('key1', 'value1')

    const fn = vi.fn()
    ctx.watch(fn)

    ctx.delete('key1')
    expect(fn).toHaveBeenCalledWith('key1', undefined)
  })

  it('should unwatch', () => {
    const ctx = new ContextStoreServer()
    const fn = vi.fn()
    const unwatch = ctx.watch(fn)

    ctx.set('key1', 'value1')
    expect(fn).toHaveBeenCalledTimes(1)

    unwatch()
    ctx.set('key2', 'value2')
    expect(fn).toHaveBeenCalledTimes(1) // no more calls
  })

  it('should store complex objects', () => {
    const ctx = new ContextStoreServer()
    const obj = { nested: { data: [1, 2, 3] } }
    ctx.set('complex', obj)
    expect(ctx.get('complex')).toEqual(obj)
  })
})
