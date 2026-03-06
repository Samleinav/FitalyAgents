// ── Speculative Cache Types ───────────────────────────────────────────────────

export interface SpeculativeToolResult {
  type: 'tool_result'
  intentId: string
  result: unknown
  cachedAt: number
  ttlMs: number
}

export interface SpeculativeDraftRef {
  type: 'draft_ref'
  intentId: string
  draftId: string
  cachedAt: number
  ttlMs: number
}

export interface SpeculativeHint {
  type: 'hint'
  intentId: string
  confidence: number
  cachedAt: number
  ttlMs: number
}

export type SpeculativeResult = SpeculativeToolResult | SpeculativeDraftRef | SpeculativeHint

// ── SpeculativeCache ──────────────────────────────────────────────────────────

/**
 * SpeculativeCache — LRU cache for pre-executed tool results.
 *
 * While the customer is still speaking (SPEECH_PARTIAL), the dispatcher
 * can classify the partial text and:
 * - **SAFE** tools: execute immediately, cache the result
 * - **STAGED** tools: create a draft, cache the draft reference
 * - **PROTECTED/RESTRICTED** tools: cache a hint (no execution)
 *
 * When the LLM eventually calls the tool, the cached result is returned
 * instantly — saving 200-2000ms of latency.
 *
 * @example
 * ```typescript
 * const cache = new SpeculativeCache({ maxEntries: 256 })
 *
 * // On SPEECH_PARTIAL → classifier detects "product_search"
 * cache.set('session-1', 'product_search', { results: [...] }, 30_000)
 *
 * // Later, LLM calls product_search → instant result
 * const hit = cache.get('session-1', 'product_search')
 * // → { type: 'tool_result', result: { results: [...] }, ... }
 * ```
 */
export class SpeculativeCache {
  private readonly maxEntries: number
  private readonly entries: Map<string, SpeculativeResult> = new Map()

  constructor(deps?: { maxEntries?: number }) {
    this.maxEntries = deps?.maxEntries ?? 256
  }

  /**
   * Cache a SAFE tool result.
   */
  set(sessionId: string, intentId: string, result: unknown, ttlMs: number = 30_000): void {
    const key = this.makeKey(sessionId, intentId)

    const entry: SpeculativeToolResult = {
      type: 'tool_result',
      intentId,
      result,
      cachedAt: Date.now(),
      ttlMs,
    }

    this.putEntry(key, entry)
  }

  /**
   * Cache a STAGED draft reference.
   */
  setDraft(sessionId: string, draftId: string, intentId: string, ttlMs?: number): void {
    const key = this.makeKey(sessionId, intentId)

    const entry: SpeculativeDraftRef = {
      type: 'draft_ref',
      intentId,
      draftId,
      cachedAt: Date.now(),
      ttlMs: ttlMs ?? 300_000, // default: match draft TTL
    }

    this.putEntry(key, entry)
  }

  /**
   * Cache a PROTECTED/RESTRICTED hint (no pre-execution, just a prediction).
   */
  setHint(sessionId: string, intentId: string, confidence: number, ttlMs: number = 10_000): void {
    const key = this.makeKey(sessionId, intentId)

    const entry: SpeculativeHint = {
      type: 'hint',
      intentId,
      confidence,
      cachedAt: Date.now(),
      ttlMs,
    }

    this.putEntry(key, entry)
  }

  /**
   * Get a specific cached result by session + intent.
   * Returns null if not found or expired.
   */
  get(sessionId: string, intentId: string): SpeculativeResult | null {
    const key = this.makeKey(sessionId, intentId)
    const entry = this.entries.get(key)

    if (!entry) return null

    // Check TTL
    if (Date.now() - entry.cachedAt > entry.ttlMs) {
      this.entries.delete(key)
      return null
    }

    // LRU: move to end (most recently accessed)
    this.entries.delete(key)
    this.entries.set(key, entry)

    return entry
  }

  /**
   * Get any cached result for a session (first non-expired match).
   * Useful when the dispatcher doesn't know the exact intent yet.
   */
  getAny(sessionId: string): SpeculativeResult | null {
    const prefix = `${sessionId}:`
    const now = Date.now()

    for (const [key, entry] of this.entries) {
      if (!key.startsWith(prefix)) continue

      if (now - entry.cachedAt > entry.ttlMs) {
        this.entries.delete(key)
        continue
      }

      return entry
    }

    return null
  }

  /**
   * Get all non-expired entries for a session.
   */
  getAllForSession(sessionId: string): SpeculativeResult[] {
    const prefix = `${sessionId}:`
    const now = Date.now()
    const results: SpeculativeResult[] = []

    for (const [key, entry] of this.entries) {
      if (!key.startsWith(prefix)) continue

      if (now - entry.cachedAt > entry.ttlMs) {
        this.entries.delete(key)
        continue
      }

      results.push(entry)
    }

    return results
  }

  /**
   * Invalidate all entries for a session (end of turn cleanup).
   */
  invalidate(sessionId: string): void {
    const prefix = `${sessionId}:`
    const keysToDelete: string[] = []

    for (const key of this.entries.keys()) {
      if (key.startsWith(prefix)) {
        keysToDelete.push(key)
      }
    }

    for (const key of keysToDelete) {
      this.entries.delete(key)
    }
  }

  /**
   * Invalidate a specific entry.
   */
  invalidateEntry(sessionId: string, intentId: string): void {
    this.entries.delete(this.makeKey(sessionId, intentId))
  }

  /**
   * Get number of entries currently in the cache.
   */
  get size(): number {
    return this.entries.size
  }

  /**
   * Clear all entries.
   */
  clear(): void {
    this.entries.clear()
  }

  // ── Private ──────────────────────────────────────────────────────────

  private makeKey(sessionId: string, intentId: string): string {
    return `${sessionId}:${intentId}`
  }

  private putEntry(key: string, entry: SpeculativeResult): void {
    // If key already exists, delete first (for LRU ordering)
    if (this.entries.has(key)) {
      this.entries.delete(key)
    }

    // Evict oldest entries if at capacity
    while (this.entries.size >= this.maxEntries) {
      const oldest = this.entries.keys().next().value
      if (oldest !== undefined) {
        this.entries.delete(oldest)
      } else {
        break
      }
    }

    this.entries.set(key, entry)
  }
}
