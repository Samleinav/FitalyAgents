import { describe, it, expect, beforeEach, afterEach } from 'vitest'
import { InMemoryIntentLibrary } from './in-memory-intent-library.js'
import type { IntentDefinition } from '../../types/index.js'

function makeDef(overrides: Partial<IntentDefinition> = {}): IntentDefinition {
  return {
    intent_id: 'product_search',
    domain_required: 'customer_facing',
    scope_hint: 'commerce',
    capabilities_required: ['PRODUCT_SEARCH'],
    initial_examples: ['find a product', 'search for shoes'],
    ...overrides,
  }
}

describe('InMemoryIntentLibrary', () => {
  let lib: InMemoryIntentLibrary

  beforeEach(() => {
    lib = new InMemoryIntentLibrary()
  })

  afterEach(() => {
    lib.dispose()
  })

  it('creates and retrieves an intent', async () => {
    await lib.createIntent(makeDef())
    const meta = await lib.getMeta('product_search')
    expect(meta).not.toBeNull()
    expect(meta!.intent_id).toBe('product_search')
    expect(meta!.capabilities_required).toEqual(['PRODUCT_SEARCH'])
  })

  it('retrieves examples', async () => {
    await lib.createIntent(makeDef())
    const examples = await lib.getExamples('product_search')
    expect(examples).toEqual(['find a product', 'search for shoes'])
  })

  it('adds examples', async () => {
    await lib.createIntent(makeDef())
    await lib.addExample('product_search', 'look for sneakers')
    const examples = await lib.getExamples('product_search')
    expect(examples).toContain('look for sneakers')
    expect(examples.length).toBe(3)
  })

  it('throws when adding example to non-existent intent', async () => {
    await expect(lib.addExample('ghost', 'text')).rejects.toThrow('not found')
  })

  it('hasIntentForCapability returns true if capability exists', async () => {
    await lib.createIntent(makeDef())
    expect(await lib.hasIntentForCapability('PRODUCT_SEARCH')).toBe(true)
    expect(await lib.hasIntentForCapability('BOOKING')).toBe(false)
  })

  it('listIntentIds returns all intent IDs', async () => {
    await lib.createIntent(makeDef({ intent_id: 'a' }))
    await lib.createIntent(makeDef({ intent_id: 'b' }))
    const ids = await lib.listIntentIds()
    expect(ids).toContain('a')
    expect(ids).toContain('b')
  })

  it('getMeta returns null for unknown intent', async () => {
    expect(await lib.getMeta('ghost')).toBeNull()
  })

  it('getExamples returns empty array for unknown intent', async () => {
    expect(await lib.getExamples('ghost')).toEqual([])
  })
})
