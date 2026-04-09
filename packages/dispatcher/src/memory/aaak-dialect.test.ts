import { describe, expect, it } from 'vitest'
import { AaakDialect } from './aaak-dialect.js'

describe('AaakDialect', () => {
  it('compresses plain text into AAAK-style symbolic output', () => {
    const dialect = new AaakDialect({
      entities: { Pedro: 'PED' },
    })

    const compressed = dialect.compress(
      'Pedro decided to cancel the subscription because the price increased and he never used the premium features.',
    )

    expect(compressed).toContain('0:PED')
    expect(compressed).toContain('subscription')
    expect(compressed).toContain('determ')
    expect(compressed).toContain('DECISION')
  })

  it('adds a source header when compression metadata is provided', () => {
    const dialect = new AaakDialect()

    const compressed = dialect.compress(
      'We switched the API server config because the old setup failed.',
      {
        wing: 'store',
        room: 'store_9',
        date: '2026-04-09',
        source_file: '/tmp/store-config-notes.md',
      },
    )

    const [header, body] = compressed.split('\n')

    expect(header).toBe('store|store_9|2026-04-09|store-config-notes')
    expect(body).toContain('TECHNICAL')
    expect(body).toContain('DECISION')
  })

  it('uses entity mappings before falling back to auto-detected capitalized names', () => {
    const dialect = new AaakDialect({
      entities: { Priya: 'PRI' },
    })

    const compressed = dialect.compress(
      'Yesterday Priya realized the migration needed a new database strategy.',
    )

    expect(compressed).toContain('0:PRI')
    expect(compressed).not.toContain('0:PRI+MIG')
  })
})
