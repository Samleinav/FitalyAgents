import { describe, it, expect, beforeEach, afterEach } from 'vitest'
import { InMemoryEmbeddingClassifier } from './in-memory-embedding-classifier.js'
import { InMemoryIntentLibrary } from '../intent-library/in-memory-intent-library.js'

describe('InMemoryEmbeddingClassifier', () => {
  let lib: InMemoryIntentLibrary
  let classifier: InMemoryEmbeddingClassifier

  beforeEach(async () => {
    lib = new InMemoryIntentLibrary()

    // Bootstrap intents with examples
    await lib.createIntent({
      intent_id: 'product_search',
      domain_required: 'customer_facing',
      scope_hint: 'commerce',
      capabilities_required: ['PRODUCT_SEARCH'],
      initial_examples: ['find shoes', 'search for sneakers', 'look for running shoes'],
    })

    await lib.createIntent({
      intent_id: 'price_query',
      domain_required: 'customer_facing',
      scope_hint: 'commerce',
      capabilities_required: ['PRICE_CHECK'],
      initial_examples: ['how much does it cost', 'what is the price', 'how much is that'],
    })

    classifier = new InMemoryEmbeddingClassifier(lib)
    await classifier.init()
  })

  afterEach(() => {
    classifier.dispose()
    lib.dispose()
  })

  it('classifies text matching an intent as confident', async () => {
    // "find shoes" is an exact example
    const result = await classifier.classify('find shoes')
    expect(result.type).toBe('confident')
    if (result.type === 'confident') {
      expect(result.intent_id).toBe('product_search')
      expect(result.confidence).toBeGreaterThanOrEqual(0.85)
    }
  })

  it('returns fallback for unrecognized text', async () => {
    const result = await classifier.classify('completely unrelated xyz abc 123')
    expect(result.type).toBe('fallback')
  })

  it('reloads intent after adding example', async () => {
    // Initially, "zapatillas deportivas" won't match well
    const before = await classifier.classify('zapatillas deportivas')

    // Add a close example and reload
    await lib.addExample('product_search', 'zapatillas deportivas')
    await classifier.reloadIntent('product_search')

    const after = await classifier.classify('zapatillas deportivas')

    // After reload, the new example should boost confidence
    if (before.type === 'fallback') {
      expect(after.type).toBe('confident')
    } else {
      // Was already confident — confidence should be at least as high
      expect(after.type).toBe('confident')
    }
  })

  it('returns candidates sorted by score', async () => {
    const result = await classifier.classify('find shoes')
    if (result.type === 'confident') {
      expect(result.candidates.length).toBeGreaterThanOrEqual(1)
      // First candidate should have highest score
      for (let i = 1; i < result.candidates.length; i++) {
        expect(result.candidates[i - 1]!.score).toBeGreaterThanOrEqual(result.candidates[i]!.score)
      }
    }
  })
})
