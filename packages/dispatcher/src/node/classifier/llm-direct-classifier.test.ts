import { describe, it, expect, beforeEach } from 'vitest'
import { LLMDirectClassifier } from './llm-direct-classifier.js'
import { InMemoryIntentLibrary } from '../intent-library/in-memory-intent-library.js'
import type { LLMProvider } from '../../llm/types.js'

// ── Test doubles ──────────────────────────────────────────────────────────────

/**
 * Mock LLM that returns a confident classification for known keywords.
 */
function makeMockLLM(overrides?: {
  intentId?: string
  confidence?: number
  malformed?: boolean
}): LLMProvider {
  return {
    async complete(_system: string, user: string) {
      if (overrides?.malformed) {
        return 'This is not JSON'
      }

      // Detect which intent to classify based on keywords in the user prompt
      const text = user.match(/User utterance: "(.+?)"/)?.[1]?.toLowerCase() ?? ''

      let intentId = overrides?.intentId ?? 'unknown'
      if (!overrides?.intentId) {
        if (text.includes('nike') || text.includes('shoes') || text.includes('search')) {
          intentId = 'product_search'
        } else if (text.includes('price') || text.includes('cost')) {
          intentId = 'price_query'
        } else if (text.includes('order')) {
          intentId = 'order_query'
        }
      }

      const confidence = overrides?.confidence ?? 0.92

      return JSON.stringify({ intent_id: intentId, confidence, reason: 'matched keywords' })
    },
  }
}

/**
 * Seed a library with common test intents.
 */
async function seedLibrary(library: InMemoryIntentLibrary) {
  await library.createIntent({
    intent_id: 'product_search',
    domain_required: 'customer_facing',
    scope_hint: 'commerce',
    capabilities_required: ['PRODUCT_SEARCH'],
    initial_examples: ['find shoes', 'search for Nike'],
  })
  await library.createIntent({
    intent_id: 'price_query',
    domain_required: 'customer_facing',
    scope_hint: 'commerce',
    capabilities_required: ['PRICE_QUERY'],
    initial_examples: ['how much does it cost', 'what is the price'],
  })
  await library.createIntent({
    intent_id: 'order_query',
    domain_required: 'customer_facing',
    scope_hint: 'orders',
    capabilities_required: ['ORDER_STATUS'],
    initial_examples: ['where is my order', 'track my order'],
  })
}

// ── Tests ─────────────────────────────────────────────────────────────────────

describe('LLMDirectClassifier', () => {
  let library: InMemoryIntentLibrary

  beforeEach(() => {
    library = new InMemoryIntentLibrary()
  })

  // ── init ─────────────────────────────────────────────────────────────────

  describe('init()', () => {
    it('loads intent metas from the library without requiring examples', async () => {
      await seedLibrary(library)

      const classifier = new LLMDirectClassifier({ llm: makeMockLLM(), intentLibrary: library })
      await classifier.init()

      // After init, classify should work (meaning metas were loaded)
      const result = await classifier.classify('I want to find Nike shoes')
      expect(result.type).toBe('confident')
    })

    it('works correctly when library is empty', async () => {
      const classifier = new LLMDirectClassifier({ llm: makeMockLLM(), intentLibrary: library })
      await classifier.init()

      const result = await classifier.classify('I want shoes')
      expect(result.type).toBe('fallback')
    })
  })

  // ── classify — confident ──────────────────────────────────────────────────

  describe('classify() — confident results', () => {
    it('returns confident result for a clear match', async () => {
      await seedLibrary(library)
      const classifier = new LLMDirectClassifier({ llm: makeMockLLM(), intentLibrary: library })
      await classifier.init()

      const result = await classifier.classify('I want to search for Nike shoes size 42')
      expect(result.type).toBe('confident')
      if (result.type === 'confident') {
        expect(result.intent_id).toBe('product_search')
        expect(result.confidence).toBeGreaterThanOrEqual(0.85)
      }
    })

    it('fills domain, scope, and capabilities from intent meta', async () => {
      await seedLibrary(library)
      const classifier = new LLMDirectClassifier({ llm: makeMockLLM(), intentLibrary: library })
      await classifier.init()

      const result = await classifier.classify('search for shoes')
      expect(result.type).toBe('confident')
      if (result.type === 'confident') {
        expect(result.domain_required).toBe('customer_facing')
        expect(result.scope_hint).toBe('commerce')
        expect(result.capabilities_required).toContain('PRODUCT_SEARCH')
      }
    })

    it('classifies price queries correctly', async () => {
      await seedLibrary(library)
      const classifier = new LLMDirectClassifier({ llm: makeMockLLM(), intentLibrary: library })
      await classifier.init()

      const result = await classifier.classify('how much does this cost?')
      expect(result.type).toBe('confident')
      if (result.type === 'confident') {
        expect(result.intent_id).toBe('price_query')
      }
    })

    it('includes candidates array in the result', async () => {
      await seedLibrary(library)
      const classifier = new LLMDirectClassifier({ llm: makeMockLLM(), intentLibrary: library })
      await classifier.init()

      const result = await classifier.classify('search for Nike')
      expect(result.type).toBe('confident')
      if (result.type === 'confident') {
        expect(result.candidates).toHaveLength(1)
        expect(result.candidates[0]?.intent_id).toBe('product_search')
      }
    })
  })

  // ── classify — fallback ───────────────────────────────────────────────────

  describe('classify() — fallback results', () => {
    it('returns fallback when LLM confidence is below threshold', async () => {
      await seedLibrary(library)
      const classifier = new LLMDirectClassifier({
        llm: makeMockLLM({ confidence: 0.5 }),
        intentLibrary: library,
      })
      await classifier.init()

      const result = await classifier.classify('some ambiguous utterance')
      expect(result.type).toBe('fallback')
    })

    it('returns fallback when LLM returns malformed JSON', async () => {
      await seedLibrary(library)
      const classifier = new LLMDirectClassifier({
        llm: makeMockLLM({ malformed: true }),
        intentLibrary: library,
      })
      await classifier.init()

      const result = await classifier.classify('something')
      expect(result.type).toBe('fallback')
    })

    it('returns fallback when LLM returns an unknown intent_id', async () => {
      await seedLibrary(library)
      const classifier = new LLMDirectClassifier({
        llm: makeMockLLM({ intentId: 'nonexistent_intent', confidence: 0.95 }),
        intentLibrary: library,
      })
      await classifier.init()

      const result = await classifier.classify('some text')
      expect(result.type).toBe('fallback')
    })
  })

  // ── reloadIntent ─────────────────────────────────────────────────────────

  describe('reloadIntent()', () => {
    it('picks up a newly added intent after reload', async () => {
      const classifier = new LLMDirectClassifier({
        llm: makeMockLLM({ intentId: 'new_intent', confidence: 0.92 }),
        intentLibrary: library,
      })
      await classifier.init()

      // Before reload — no intents, returns fallback
      const before = await classifier.classify('something')
      expect(before.type).toBe('fallback')

      // Add new intent to library
      await library.createIntent({
        intent_id: 'new_intent',
        domain_required: 'customer_facing',
        scope_hint: 'commerce',
        capabilities_required: ['NEW_CAPABILITY'],
        initial_examples: [],
      })

      // Hot reload
      await classifier.reloadIntent('new_intent')

      // After reload — should classify as confident
      const after = await classifier.classify('something')
      expect(after.type).toBe('confident')
      if (after.type === 'confident') {
        expect(after.intent_id).toBe('new_intent')
      }
    })

    it('ignores reloadIntent for an intent_id that does not exist in the library', async () => {
      await seedLibrary(library)
      const classifier = new LLMDirectClassifier({ llm: makeMockLLM(), intentLibrary: library })
      await classifier.init()

      // Should not throw
      await expect(classifier.reloadIntent('does_not_exist')).resolves.toBeUndefined()
    })
  })

  // ── dispose ───────────────────────────────────────────────────────────────

  describe('dispose()', () => {
    it('clears intent metas and returns fallback for subsequent classifies', async () => {
      await seedLibrary(library)
      const classifier = new LLMDirectClassifier({ llm: makeMockLLM(), intentLibrary: library })
      await classifier.init()

      classifier.dispose()

      const result = await classifier.classify('search for shoes')
      expect(result.type).toBe('fallback')
    })
  })

  // ── markdown fence stripping ──────────────────────────────────────────────

  describe('handles LLM response formatting', () => {
    it('parses JSON wrapped in markdown code fences', async () => {
      await seedLibrary(library)

      const fencedLLM: LLMProvider = {
        async complete() {
          return '```json\n{"intent_id":"product_search","confidence":0.92}\n```'
        },
      }

      const classifier = new LLMDirectClassifier({ llm: fencedLLM, intentLibrary: library })
      await classifier.init()

      const result = await classifier.classify('find me shoes')
      expect(result.type).toBe('confident')
      if (result.type === 'confident') {
        expect(result.intent_id).toBe('product_search')
      }
    })
  })
})
