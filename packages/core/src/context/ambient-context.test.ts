import { describe, it, expect, beforeEach, afterEach } from 'vitest'
import { InMemoryContextStore } from './in-memory-context-store.js'
import type { AmbientContext } from './types.js'

describe('InMemoryContextStore — Ambient Context', () => {
  let store: InMemoryContextStore

  beforeEach(() => {
    store = new InMemoryContextStore()
  })

  afterEach(() => {
    store.dispose()
  })

  it('getAmbient returns null for unknown session', async () => {
    const result = await store.getAmbient('session-1')
    expect(result).toBeNull()
  })

  it('setAmbient + getAmbient roundtrip', async () => {
    const ambient: AmbientContext = {
      last_product_mentioned: 'Nike Air Max',
      conversation_snippets: [
        { speaker_id: 'bystander_1', text: 'Those shoes look nice', timestamp: 1000 },
      ],
      timestamp: 1000,
    }

    await store.setAmbient('session-1', ambient)
    const result = await store.getAmbient('session-1')

    expect(result).not.toBeNull()
    expect(result!.last_product_mentioned).toBe('Nike Air Max')
    expect(result!.conversation_snippets).toHaveLength(1)
  })

  it('setAmbient overwrites previous ambient data', async () => {
    await store.setAmbient('session-1', {
      last_product_mentioned: 'Nike Air',
      conversation_snippets: [],
      timestamp: 1000,
    })

    await store.setAmbient('session-1', {
      last_product_mentioned: 'Adidas Ultra Boost',
      conversation_snippets: [{ text: 'I prefer Adidas', timestamp: 2000 }],
      timestamp: 2000,
    })

    const result = await store.getAmbient('session-1')
    expect(result!.last_product_mentioned).toBe('Adidas Ultra Boost')
  })

  it('ambient persists across regular context operations', async () => {
    await store.set('session-1', 'cart', { items: [] })
    await store.setAmbient('session-1', {
      conversation_snippets: [{ text: 'hello', timestamp: 1000 }],
      timestamp: 1000,
    })

    // Regular context operations don't affect ambient
    await store.set('session-1', 'cart', { items: ['shirt'] })
    const ambient = await store.getAmbient('session-1')
    expect(ambient).not.toBeNull()
    expect(ambient!.conversation_snippets).toHaveLength(1)
  })

  it('delete(sessionId) clears ambient too', async () => {
    await store.set('session-1', 'cart', {})
    await store.setAmbient('session-1', {
      conversation_snippets: [],
      timestamp: 1000,
    })

    await store.delete('session-1')

    const ambient = await store.getAmbient('session-1')
    expect(ambient).toBeNull()
  })

  it('delete(sessionId, field) does not affect ambient', async () => {
    await store.set('session-1', 'cart', {})
    await store.setAmbient('session-1', {
      conversation_snippets: [],
      timestamp: 1000,
    })

    await store.delete('session-1', 'cart')

    const ambient = await store.getAmbient('session-1')
    expect(ambient).not.toBeNull()
  })

  it('dispose clears ambient data', async () => {
    await store.setAmbient('session-1', {
      conversation_snippets: [],
      timestamp: 1000,
    })

    store.dispose()

    const ambient = await store.getAmbient('session-1')
    expect(ambient).toBeNull()
  })

  it('ambient context with multiple snippets', async () => {
    const ambient: AmbientContext = {
      last_product_mentioned: 'Nike Dunk',
      conversation_snippets: [
        { speaker_id: 'person_A', text: 'Check out those Dunks', timestamp: 1000 },
        { speaker_id: 'person_B', text: 'Yeah, the blue ones are fire', timestamp: 1500 },
        { text: 'Maybe size 42?', timestamp: 2000 },
      ],
      timestamp: 2000,
    }

    await store.setAmbient('session-1', ambient)
    const result = await store.getAmbient('session-1')

    expect(result!.conversation_snippets).toHaveLength(3)
    expect(result!.conversation_snippets[0].speaker_id).toBe('person_A')
    expect(result!.conversation_snippets[2].speaker_id).toBeUndefined()
  })
})
