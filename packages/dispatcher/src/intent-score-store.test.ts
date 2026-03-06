import { describe, it, expect, beforeEach } from 'vitest'
import { IntentScoreStore, InMemoryScoreBackend } from './intent-score-store.js'

describe('IntentScoreStore', () => {
  let store: IntentScoreStore

  beforeEach(() => {
    store = new IntentScoreStore()
  })

  // ── recordHit / recordCorrection ───────────────────────────────────

  describe('recordHit / recordCorrection', () => {
    it('first hit sets score to 1.0', () => {
      store.recordHit('product_search')
      expect(store.getScore('product_search')).toBe(1)
    })

    it('first correction sets score to 0', () => {
      store.recordCorrection('product_search')
      expect(store.getScore('product_search')).toBe(0)
    })

    it('unknown intent returns score 0', () => {
      expect(store.getScore('unknown')).toBe(0)
    })
  })

  // ── EMA convergence ────────────────────────────────────────────────

  describe('EMA convergence', () => {
    it('converges correctly with successive hits', () => {
      // EMA with α=0.1 starting from 1.0 (first hit = 1.0)
      // hit → 0.1*1 + 0.9*1.0 = 1.0
      // hit → 0.1*1 + 0.9*1.0 = 1.0
      store.recordHit('intent_a')
      store.recordHit('intent_a')
      store.recordHit('intent_a')

      expect(store.getScore('intent_a')).toBe(1.0)
    })

    it('drops on correction after hits', () => {
      // Start: 1.0 (first hit)
      // correction: 0.1*0 + 0.9*1.0 = 0.90
      store.recordHit('intent_a')
      store.recordCorrection('intent_a')

      expect(store.getScore('intent_a')).toBeCloseTo(0.9, 2)
    })

    it('recovers after correction with successive hits', () => {
      store.recordHit('intent_a') // 1.0
      store.recordCorrection('intent_a') // 0.9
      store.recordHit('intent_a') // 0.1*1 + 0.9*0.9 = 0.91

      expect(store.getScore('intent_a')).toBeCloseTo(0.91, 2)
    })

    it('decays with successive corrections', () => {
      store.recordHit('intent_a') // 1.0
      store.recordCorrection('intent_a') // 0.9
      store.recordCorrection('intent_a') // 0.1*0 + 0.9*0.9 = 0.81
      store.recordCorrection('intent_a') // 0.1*0 + 0.9*0.81 = 0.729

      expect(store.getScore('intent_a')).toBeCloseTo(0.729, 3)
    })
  })

  // ── isProduction ───────────────────────────────────────────────────

  describe('isProduction', () => {
    it('returns false for unknown intent', () => {
      expect(store.isProduction('unknown')).toBe(false)
    })

    it('returns false with less than 5 events', () => {
      store.recordHit('intent_a')
      store.recordHit('intent_a')
      store.recordHit('intent_a')
      store.recordHit('intent_a')

      expect(store.isProduction('intent_a')).toBe(false)
    })

    it('returns true with 5+ events and high score', () => {
      for (let i = 0; i < 5; i++) {
        store.recordHit('intent_a')
      }

      expect(store.isProduction('intent_a')).toBe(true)
    })

    it('returns false when score drops below 0.70', () => {
      // Build up score then tank it
      store.recordHit('intent_a') // 1.0
      store.recordCorrection('intent_a') // 0.9
      store.recordCorrection('intent_a') // 0.81
      store.recordCorrection('intent_a') // 0.729
      store.recordCorrection('intent_a') // 0.6561
      // Now has 5 events, score < 0.70

      expect(store.isProduction('intent_a')).toBe(false)
    })
  })

  // ── suggestProductionSwitch ────────────────────────────────────────

  describe('suggestProductionSwitch', () => {
    it('returns empty when no intents qualify', () => {
      expect(store.suggestProductionSwitch()).toEqual([])
    })

    it('returns intents with hit rate >= 90%', () => {
      // 10 hits, 0 corrections → 100% hit rate
      for (let i = 0; i < 10; i++) {
        store.recordHit('good_intent')
      }

      // 5 hits, 5 corrections → 50% hit rate
      for (let i = 0; i < 5; i++) {
        store.recordHit('bad_intent')
        store.recordCorrection('bad_intent')
      }

      const suggestions = store.suggestProductionSwitch()
      expect(suggestions).toContain('good_intent')
      expect(suggestions).not.toContain('bad_intent')
    })

    it('ignores intents with less than 5 events', () => {
      for (let i = 0; i < 4; i++) {
        store.recordHit('new_intent')
      }

      expect(store.suggestProductionSwitch()).toEqual([])
    })
  })

  // ── shouldSpeculate ────────────────────────────────────────────────

  describe('shouldSpeculate', () => {
    it('returns true for unknown intents (optimistic)', () => {
      expect(store.shouldSpeculate('unknown')).toBe(true)
    })

    it('returns true for intents with insufficient data', () => {
      store.recordHit('intent_a')
      store.recordCorrection('intent_a')

      expect(store.shouldSpeculate('intent_a')).toBe(true)
    })

    it('returns false for intents with low score after many events', () => {
      store.recordHit('intent_a')
      // 4 more corrections to get 5 events with declining score
      for (let i = 0; i < 4; i++) {
        store.recordCorrection('intent_a')
      }

      // Score: 1.0 → 0.9 → 0.81 → 0.729 → 0.6561 (< 0.70)
      expect(store.shouldSpeculate('intent_a')).toBe(false)
    })
  })

  // ── overallHitRate ─────────────────────────────────────────────────

  describe('overallHitRate', () => {
    it('returns 0 with no data', () => {
      expect(store.overallHitRate()).toBe(0)
    })

    it('calculates correctly across intents', () => {
      store.recordHit('intent_a')
      store.recordHit('intent_a')
      store.recordCorrection('intent_a')

      store.recordHit('intent_b')
      store.recordCorrection('intent_b')

      // 3 hits, 2 corrections = 5 total → 3/5 = 0.6
      expect(store.overallHitRate()).toBeCloseTo(0.6, 2)
    })
  })

  // ── Backend persistence ────────────────────────────────────────────

  describe('backend persistence', () => {
    it('init() loads from backend', async () => {
      const backend = new InMemoryScoreBackend()
      await backend.save([
        {
          intentId: 'product_search',
          ema_score: 0.85,
          hits: 10,
          corrections: 2,
          total_events: 12,
          confidence: 'high',
          last_updated: 1000,
        },
      ])

      const storeWithBackend = new IntentScoreStore({ backend })
      await storeWithBackend.init()

      expect(storeWithBackend.getScore('product_search')).toBe(0.85)
    })

    it('persist() saves to backend', async () => {
      const backend = new InMemoryScoreBackend()
      const storeWithBackend = new IntentScoreStore({ backend })

      storeWithBackend.recordHit('product_search')
      await storeWithBackend.persist()

      const saved = await backend.load()
      expect(saved).toHaveLength(1)
      expect(saved[0].intentId).toBe('product_search')
    })
  })

  // ── getAll / getEntry ──────────────────────────────────────────────

  describe('getAll / getEntry', () => {
    it('getAll returns all entries sorted by events', () => {
      for (let i = 0; i < 3; i++) store.recordHit('intent_a')
      store.recordHit('intent_b')

      const all = store.getAll()
      expect(all[0].intentId).toBe('intent_a')
      expect(all[1].intentId).toBe('intent_b')
    })

    it('getEntry returns specific entry', () => {
      store.recordHit('intent_a')
      const entry = store.getEntry('intent_a')
      expect(entry).not.toBeNull()
      expect(entry!.hits).toBe(1)
    })

    it('getEntry returns null for unknown', () => {
      expect(store.getEntry('unknown')).toBeNull()
    })
  })

  // ── Confidence levels ──────────────────────────────────────────────

  describe('confidence levels', () => {
    it('no_data with < 5 events', () => {
      store.recordHit('intent_a')
      expect(store.getEntry('intent_a')!.confidence).toBe('no_data')
    })

    it('high with score >= 0.85 and 5+ events', () => {
      for (let i = 0; i < 5; i++) store.recordHit('intent_a')
      expect(store.getEntry('intent_a')!.confidence).toBe('high')
    })

    it('medium with score >= 0.70 but < 0.85', () => {
      // Need 5+ events with score between 0.70 and 0.85
      store.recordHit('intent_a') // 1.0
      store.recordCorrection('intent_a') // 0.9
      store.recordCorrection('intent_a') // 0.81
      store.recordHit('intent_a') // 0.829
      store.recordHit('intent_a') // 0.8461
      // total_events=5, score ≈ 0.8461 → this is just above 0.85? Let me recalc
      // Actually: 0.1*1 + 0.9*0.81 = 0.829 → score is 0.829 which IS < 0.85
      // 0.1*1 + 0.9*0.829 = 0.8461 which IS < 0.85 → medium!
      expect(store.getEntry('intent_a')!.confidence).toBe('medium')
    })

    it('low with score < 0.70', () => {
      store.recordHit('intent_a') // 1.0
      store.recordCorrection('intent_a') // 0.9
      store.recordCorrection('intent_a') // 0.81
      store.recordCorrection('intent_a') // 0.729
      store.recordCorrection('intent_a') // 0.6561
      expect(store.getEntry('intent_a')!.confidence).toBe('low')
    })
  })
})
