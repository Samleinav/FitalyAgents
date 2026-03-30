import { describe, it, expect } from 'vitest'
import { InMemoryBus } from './in-memory-bus.js'

describe('InMemoryBus', () => {
  it('continues dispatching to all subscribers when one handler throws', async () => {
    const bus = new InMemoryBus()
    const calls: string[] = []

    bus.subscribe('bus:test', () => {
      calls.push('first')
      throw new Error('handler failed')
    })
    bus.subscribe('bus:test', () => {
      calls.push('second')
    })

    await expect(bus.publish('bus:test', { ok: true })).rejects.toThrow('handler failed')
    expect(calls).toEqual(['first', 'second'])
  })

  it('awaits async exact and pattern subscribers', async () => {
    const bus = new InMemoryBus()
    const calls: string[] = []

    bus.subscribe('bus:test', async () => {
      await new Promise((resolve) => setTimeout(resolve, 10))
      calls.push('exact')
    })
    bus.psubscribe('bus:*', async (channel) => {
      await new Promise((resolve) => setTimeout(resolve, 5))
      calls.push(channel)
    })

    await bus.publish('bus:test', { ok: true })

    expect(calls).toHaveLength(2)
    expect(calls).toContain('exact')
    expect(calls).toContain('bus:test')
  })
})
