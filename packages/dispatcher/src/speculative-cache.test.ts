import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest'
import { SpeculativeCache } from './speculative-cache.js'

describe('SpeculativeCache', () => {
  let cache: SpeculativeCache

  beforeEach(() => {
    vi.useFakeTimers()
    cache = new SpeculativeCache({ maxEntries: 5 })
  })

  afterEach(() => {
    vi.useRealTimers()
  })

  // ── set() + get() ──────────────────────────────────────────────────

  describe('set() + get()', () => {
    it('stores and retrieves a SAFE tool result', () => {
      cache.set('session-1', 'product_search', { results: ['Nike Air'] }, 30_000)

      const hit = cache.get('session-1', 'product_search')
      expect(hit).not.toBeNull()
      expect(hit!.type).toBe('tool_result')
      if (hit!.type === 'tool_result') {
        expect(hit!.result).toEqual({ results: ['Nike Air'] })
      }
    })

    it('returns null for missing entry', () => {
      expect(cache.get('session-1', 'unknown')).toBeNull()
    })

    it('returns null for different session', () => {
      cache.set('session-1', 'product_search', { results: [] }, 30_000)
      expect(cache.get('session-2', 'product_search')).toBeNull()
    })
  })

  // ── setDraft() ─────────────────────────────────────────────────────

  describe('setDraft()', () => {
    it('stores a draft reference', () => {
      cache.setDraft('session-1', 'draft_001', 'order_create')

      const hit = cache.get('session-1', 'order_create')
      expect(hit).not.toBeNull()
      expect(hit!.type).toBe('draft_ref')
      if (hit!.type === 'draft_ref') {
        expect(hit!.draftId).toBe('draft_001')
      }
    })
  })

  // ── setHint() ──────────────────────────────────────────────────────

  describe('setHint()', () => {
    it('stores a hint with confidence', () => {
      cache.setHint('session-1', 'refund_create', 0.92)

      const hit = cache.get('session-1', 'refund_create')
      expect(hit).not.toBeNull()
      expect(hit!.type).toBe('hint')
      if (hit!.type === 'hint') {
        expect(hit!.confidence).toBe(0.92)
      }
    })
  })

  // ── TTL expiry ─────────────────────────────────────────────────────

  describe('TTL expiry', () => {
    it('entries expire after TTL', () => {
      cache.set('session-1', 'product_search', { results: [] }, 5_000)

      vi.advanceTimersByTime(4_999)
      expect(cache.get('session-1', 'product_search')).not.toBeNull()

      vi.advanceTimersByTime(2)
      expect(cache.get('session-1', 'product_search')).toBeNull()
    })

    it('draft entries use custom TTL', () => {
      cache.setDraft('session-1', 'draft_001', 'order_create', 10_000)

      vi.advanceTimersByTime(10_001)
      expect(cache.get('session-1', 'order_create')).toBeNull()
    })

    it('hint entries use default 10s TTL', () => {
      cache.setHint('session-1', 'refund_create', 0.95)

      vi.advanceTimersByTime(10_001)
      expect(cache.get('session-1', 'refund_create')).toBeNull()
    })
  })

  // ── LRU eviction ───────────────────────────────────────────────────

  describe('LRU eviction', () => {
    it('evicts oldest entry when at capacity', () => {
      // Fill cache to capacity (5)
      cache.set('s1', 'i1', 1, 60_000)
      cache.set('s1', 'i2', 2, 60_000)
      cache.set('s1', 'i3', 3, 60_000)
      cache.set('s1', 'i4', 4, 60_000)
      cache.set('s1', 'i5', 5, 60_000)

      expect(cache.size).toBe(5)

      // Add one more → should evict i1
      cache.set('s1', 'i6', 6, 60_000)

      expect(cache.size).toBe(5)
      expect(cache.get('s1', 'i1')).toBeNull() // evicted
      expect(cache.get('s1', 'i6')).not.toBeNull() // newest
    })

    it('accessing an entry refreshes its LRU position', () => {
      cache.set('s1', 'i1', 1, 60_000)
      cache.set('s1', 'i2', 2, 60_000)
      cache.set('s1', 'i3', 3, 60_000)
      cache.set('s1', 'i4', 4, 60_000)
      cache.set('s1', 'i5', 5, 60_000)

      // Access i1 → moves it to end (most recent)
      cache.get('s1', 'i1')

      // Add new → should evict i2 (now the oldest)
      cache.set('s1', 'i6', 6, 60_000)

      expect(cache.get('s1', 'i1')).not.toBeNull() // refreshed
      expect(cache.get('s1', 'i2')).toBeNull() // evicted
    })

    it('overwriting an entry does not increase size', () => {
      cache.set('s1', 'i1', 1, 60_000)
      cache.set('s1', 'i1', 'updated', 60_000)

      expect(cache.size).toBe(1)
      const hit = cache.get('s1', 'i1')
      if (hit?.type === 'tool_result') {
        expect(hit.result).toBe('updated')
      }
    })
  })

  // ── getAny() ───────────────────────────────────────────────────────

  describe('getAny()', () => {
    it('returns first non-expired entry for session', () => {
      cache.set('session-1', 'product_search', { results: ['Nike'] }, 30_000)
      cache.setDraft('session-1', 'draft_001', 'order_create')

      const hit = cache.getAny('session-1')
      expect(hit).not.toBeNull()
    })

    it('returns null when session has no entries', () => {
      expect(cache.getAny('empty_session')).toBeNull()
    })

    it('skips expired entries', () => {
      cache.set('session-1', 'product_search', { results: [] }, 1_000)

      vi.advanceTimersByTime(1_001)

      expect(cache.getAny('session-1')).toBeNull()
    })
  })

  // ── getAllForSession() ─────────────────────────────────────────────

  describe('getAllForSession()', () => {
    it('returns all non-expired entries for a session', () => {
      cache.set('session-1', 'product_search', {}, 30_000)
      cache.setDraft('session-1', 'draft_001', 'order_create')
      cache.setHint('session-1', 'refund_create', 0.9)
      cache.set('session-2', 'other', {}, 30_000) // different session

      const results = cache.getAllForSession('session-1')
      expect(results).toHaveLength(3)
    })

    it('filters out expired entries', () => {
      cache.set('session-1', 'product_search', {}, 1_000)
      cache.set('session-1', 'inventory_check', {}, 30_000)

      vi.advanceTimersByTime(1_001)

      const results = cache.getAllForSession('session-1')
      expect(results).toHaveLength(1)
      expect(results[0].intentId).toBe('inventory_check')
    })
  })

  // ── invalidate() ───────────────────────────────────────────────────

  describe('invalidate()', () => {
    it('removes all entries for a session', () => {
      cache.set('session-1', 'product_search', {}, 30_000)
      cache.setDraft('session-1', 'draft_001', 'order_create')
      cache.set('session-2', 'other', {}, 30_000)

      cache.invalidate('session-1')

      expect(cache.get('session-1', 'product_search')).toBeNull()
      expect(cache.get('session-1', 'order_create')).toBeNull()
      expect(cache.get('session-2', 'other')).not.toBeNull()
    })
  })

  // ── invalidateEntry() ──────────────────────────────────────────────

  describe('invalidateEntry()', () => {
    it('removes a specific entry', () => {
      cache.set('session-1', 'product_search', {}, 30_000)
      cache.set('session-1', 'inventory_check', {}, 30_000)

      cache.invalidateEntry('session-1', 'product_search')

      expect(cache.get('session-1', 'product_search')).toBeNull()
      expect(cache.get('session-1', 'inventory_check')).not.toBeNull()
    })
  })

  // ── clear() ────────────────────────────────────────────────────────

  describe('clear()', () => {
    it('removes all entries', () => {
      cache.set('s1', 'i1', 1, 60_000)
      cache.set('s2', 'i2', 2, 60_000)

      cache.clear()

      expect(cache.size).toBe(0)
      expect(cache.get('s1', 'i1')).toBeNull()
    })
  })

  // ── Default TTLs ───────────────────────────────────────────────────

  describe('default TTLs', () => {
    it('set() defaults to 30s', () => {
      cache.set('s1', 'i1', 1)

      vi.advanceTimersByTime(29_999)
      expect(cache.get('s1', 'i1')).not.toBeNull()

      vi.advanceTimersByTime(2)
      expect(cache.get('s1', 'i1')).toBeNull()
    })

    it('setDraft() defaults to 300s', () => {
      cache.setDraft('s1', 'draft_001', 'order_create')

      vi.advanceTimersByTime(299_999)
      expect(cache.get('s1', 'order_create')).not.toBeNull()

      vi.advanceTimersByTime(2)
      expect(cache.get('s1', 'order_create')).toBeNull()
    })
  })

  // ── Default capacity ───────────────────────────────────────────────

  describe('default capacity', () => {
    it('defaults to 256 entries', () => {
      const bigCache = new SpeculativeCache()

      for (let i = 0; i < 256; i++) {
        bigCache.set('s1', `intent_${i}`, i, 60_000)
      }

      expect(bigCache.size).toBe(256)

      bigCache.set('s1', 'intent_256', 256, 60_000)
      expect(bigCache.size).toBe(256) // oldest evicted
      expect(bigCache.get('s1', 'intent_0')).toBeNull()
    })
  })
})
