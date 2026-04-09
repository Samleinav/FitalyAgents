import { describe, expect, it } from 'vitest'
import { AaakDialect } from './aaak-dialect.js'
import { InMemoryMemoryStore } from './memory-store.js'

describe('InMemoryMemoryStore', () => {
  it('returns the most similar memory for the same room', async () => {
    const store = new InMemoryMemoryStore()

    await store.write({
      text: 'customer prefers decaf coffee every morning',
      wing: 'customer',
      room: 'maria_123',
    })
    await store.write({
      text: 'customer asked for a refund because the price increased',
      wing: 'customer',
      room: 'maria_123',
    })
    await store.write({
      text: 'employee handles inventory requests well',
      wing: 'employee',
      room: 'pedro_456',
    })

    const hits = await store.query('she wants her usual decaf coffee', {
      room: 'maria_123',
      n: 2,
    })

    expect(hits.length).toBeGreaterThan(0)
    expect(hits[0]).toHaveProperty('room', 'maria_123')
    expect(hits[0]?.text).toContain('decaf coffee')
    expect(hits[0]?.similarity).toBeGreaterThan(0)
  })

  it('supports lossy text transforms while keeping original memory text', async () => {
    const store = new InMemoryMemoryStore({
      textTransform: (text) => text.replace(/premium/gi, 'plan'),
    })

    await store.write({
      text: 'The customer never used the premium features',
      wing: 'customer',
      room: 'sess_1',
    })

    const hits = await store.query('They did not use the plan features', { room: 'sess_1' })

    expect(hits).toHaveLength(1)
    expect(hits[0]?.text).toBe('The customer never used the premium features')
  })

  it('supports AAAK compression before embedding while keeping original memory text', async () => {
    const store = new InMemoryMemoryStore({
      dialect: new AaakDialect({
        entities: { Pedro: 'PED' },
      }),
    })

    await store.write({
      text: 'Pedro decided to cancel the subscription because the price increased and he never used the premium features.',
      wing: 'customer',
      room: 'sess_2',
    })

    const hits = await store.query(
      'Pedro decided the premium subscription was not worth the price increase.',
      {
        room: 'sess_2',
      },
    )

    expect(hits).toHaveLength(1)
    expect(hits[0]?.text).toContain('cancel the subscription')
  })
})
