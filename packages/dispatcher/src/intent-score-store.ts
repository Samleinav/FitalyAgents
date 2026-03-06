/**
 * IntentScoreStore — EMA-based learning metrics for speculative dispatch.
 *
 * Records whether each speculated intent was confirmed (HIT) or corrected
 * by the LLM. Over time the EMA score reflects how reliable each
 * speculation is, and in production mode low-confidence intents are skipped.
 *
 * Exponential Moving Average (α=0.1):
 *   new_score = α × event + (1-α) × previous_score
 *   Recent corrections outweigh old confirmations within ~10–20 events.
 *
 * @example
 * ```typescript
 * const store = new IntentScoreStore()
 *
 * // Training: record outcomes
 * store.recordHit('product_search')
 * store.recordHit('product_search')
 * store.recordCorrection('product_search')
 *
 * // Check reliability
 * store.getScore('product_search') // → 0.729
 * store.isProduction('product_search') // → true (>= 0.70)
 *
 * // Find intents ready for production
 * store.suggestProductionSwitch() // → ['product_search']
 * ```
 */

/** How much recent events outweigh history. Lower = slower decay. */
const EMA_ALPHA = 0.1

/** Minimum recorded events before score is considered reliable. */
const MIN_EVENTS_FOR_CONFIDENCE = 5

export type ConfidenceLevel = 'no_data' | 'low' | 'medium' | 'high'

export interface ScoreEntry {
  intentId: string
  ema_score: number
  hits: number
  corrections: number
  total_events: number
  confidence: ConfidenceLevel
  last_updated: number
}

/** Threshold constants */
export const SCORE_THRESHOLDS = {
  /** Minimum EMA score to speculate in production mode */
  PRODUCTION_MIN: 0.7,
  /** EMA score considered "high confidence" */
  HIGH_CONFIDENCE: 0.85,
  /** Hit rate threshold for suggesting production switch */
  PRODUCTION_SWITCH_HIT_RATE: 0.9,
} as const

/**
 * Backend interface for persistence. Implementations can use
 * in-memory (tests), filesystem, or Redis (production).
 */
export interface IScoreBackend {
  load(): Promise<ScoreEntry[]>
  save(entries: ScoreEntry[]): Promise<void>
}

// ── InMemoryScoreBackend ──────────────────────────────────────────────────────

export class InMemoryScoreBackend implements IScoreBackend {
  private data: ScoreEntry[] = []

  async load(): Promise<ScoreEntry[]> {
    return [...this.data]
  }

  async save(entries: ScoreEntry[]): Promise<void> {
    this.data = [...entries]
  }
}

// ── IntentScoreStore ──────────────────────────────────────────────────────────

export class IntentScoreStore {
  private scores = new Map<string, ScoreEntry>()
  private readonly backend: IScoreBackend | null

  constructor(deps?: { backend?: IScoreBackend }) {
    this.backend = deps?.backend ?? null
  }

  /**
   * Load scores from the backend (call once on startup).
   */
  async init(): Promise<void> {
    if (!this.backend) return
    const entries = await this.backend.load()
    for (const e of entries) {
      this.scores.set(e.intentId, e)
    }
  }

  // ── Public API ──────────────────────────────────────────────────────────

  /**
   * Record a confirmed speculation (LLM called the same tool we predicted).
   */
  recordHit(intentId: string): void {
    this.update(intentId, 'hit')
  }

  /**
   * Record a correction (LLM called a different tool than predicted).
   */
  recordCorrection(intentId: string): void {
    this.update(intentId, 'correction')
  }

  /**
   * Get the current EMA score for an intent (0-1).
   * Returns 0 for unknown intents.
   */
  getScore(intentId: string): number {
    return this.scores.get(intentId)?.ema_score ?? 0
  }

  /**
   * Whether an intent has reached production-ready reliability.
   * Returns true if EMA score >= 0.70 with enough data.
   */
  isProduction(intentId: string): boolean {
    const entry = this.scores.get(intentId)
    if (!entry || entry.total_events < MIN_EVENTS_FOR_CONFIDENCE) return false
    return entry.ema_score >= SCORE_THRESHOLDS.PRODUCTION_MIN
  }

  /**
   * Suggest intents ready for production mode switch.
   * Returns intent IDs with hit rate >= 90% and enough data.
   */
  suggestProductionSwitch(): string[] {
    const result: string[] = []

    for (const entry of this.scores.values()) {
      if (entry.total_events < MIN_EVENTS_FOR_CONFIDENCE) continue

      const hitRate = entry.hits / entry.total_events
      if (hitRate >= SCORE_THRESHOLDS.PRODUCTION_SWITCH_HIT_RATE) {
        result.push(entry.intentId)
      }
    }

    return result
  }

  /**
   * Should the dispatcher speculate this intent?
   * Uses EMA score + minimum data thresholds.
   * Intents with insufficient data are optimistically speculated.
   */
  shouldSpeculate(intentId: string): boolean {
    const e = this.scores.get(intentId)
    if (!e || e.total_events < MIN_EVENTS_FOR_CONFIDENCE) return true
    return e.ema_score >= SCORE_THRESHOLDS.PRODUCTION_MIN
  }

  /**
   * Get all score entries, sorted by total events (descending).
   */
  getAll(): ScoreEntry[] {
    return [...this.scores.values()].sort((a, b) => b.total_events - a.total_events)
  }

  /**
   * Get a specific score entry, or null if not found.
   */
  getEntry(intentId: string): ScoreEntry | null {
    return this.scores.get(intentId) ?? null
  }

  /**
   * Overall hit rate across all intents.
   */
  overallHitRate(): number {
    const all = this.getAll()
    const total = all.reduce((s, e) => s + e.total_events, 0)
    if (total === 0) return 0
    const hits = all.reduce((s, e) => s + e.hits, 0)
    return hits / total
  }

  /**
   * Persist current scores to the backend.
   */
  async persist(): Promise<void> {
    if (!this.backend) return
    await this.backend.save(this.getAll())
  }

  // ── Private ──────────────────────────────────────────────────────────

  private update(intentId: string, outcome: 'hit' | 'correction'): void {
    const event = outcome === 'hit' ? 1 : 0
    const existing = this.scores.get(intentId)

    if (!existing) {
      const entry: ScoreEntry = {
        intentId,
        ema_score: event,
        hits: outcome === 'hit' ? 1 : 0,
        corrections: outcome === 'correction' ? 1 : 0,
        total_events: 1,
        confidence: 'no_data',
        last_updated: Date.now(),
      }
      entry.confidence = this.computeConfidence(entry)
      this.scores.set(intentId, entry)
    } else {
      existing.ema_score = EMA_ALPHA * event + (1 - EMA_ALPHA) * existing.ema_score
      if (outcome === 'hit') existing.hits++
      else existing.corrections++
      existing.total_events++
      existing.confidence = this.computeConfidence(existing)
      existing.last_updated = Date.now()
    }
  }

  private computeConfidence(e: ScoreEntry): ConfidenceLevel {
    if (e.total_events < MIN_EVENTS_FOR_CONFIDENCE) return 'no_data'
    if (e.ema_score >= SCORE_THRESHOLDS.HIGH_CONFIDENCE) return 'high'
    if (e.ema_score >= SCORE_THRESHOLDS.PRODUCTION_MIN) return 'medium'
    return 'low'
  }
}
