/**
 * IntentScoreStore — EMA-based learning store for speculative dispatcher.
 *
 * Records whether each speculated tool was confirmed (HIT) or corrected
 * by the LLM. Over time the EMA score reflects how reliable each
 * speculation is, and in production mode low-confidence tools are skipped.
 *
 * Exponential Moving Average (α=0.1):
 *   new_score = α × event + (1-α) × previous_score
 *   Recent corrections outweigh old confirmations within ~10–20 events.
 *
 * Modes:
 *   training   — always speculate regardless of score (accumulate data)
 *   production — skip speculation when score < SPECULATE_MIN_SCORE
 */

import { readFileSync, writeFileSync, mkdirSync } from 'fs'
import { dirname } from 'path'

/** How much recent events outweigh history. Lower = slower decay. */
const EMA_ALPHA = 0.1

/** Minimum recorded events before score is considered reliable. */
const MIN_EVENTS_FOR_CONFIDENCE = 5

export type LearningMode = 'training' | 'production'

export interface ScoreEntry {
  tool_name: string
  ema_score: number // current reliability score (0–1)
  hits: number
  corrections: number
  total_events: number
  confidence: 'no_data' | 'low' | 'medium' | 'high'
  last_updated: number
}

export class IntentScoreStore {
  /** EMA score >= this to speculate in production mode. */
  static readonly SPECULATE_MIN_SCORE = 0.7
  /** EMA score >= this is considered "high confidence". */
  static readonly SPECULATE_HIGH_SCORE = 0.85

  private scores = new Map<string, ScoreEntry>()
  private mode: LearningMode = 'training'
  private readonly persistPath: string | null

  constructor(persistPath?: string) {
    this.persistPath = persistPath ?? null
    if (persistPath) this._load()
  }

  // ─── Mode ─────────────────────────────────────────────────────────────────

  setMode(mode: LearningMode): void {
    this.mode = mode
  }
  getMode(): LearningMode {
    return this.mode
  }

  // ─── Core API ─────────────────────────────────────────────────────────────

  /**
   * Record outcome of a speculative execution.
   *   hit        → speculation confirmed by LLM (+1 to EMA)
   *   correction → LLM chose different tool (0 to EMA)
   */
  update(tool_name: string, outcome: 'hit' | 'correction'): void {
    const event = outcome === 'hit' ? 1 : 0
    const existing = this.scores.get(tool_name)

    if (!existing) {
      const entry: ScoreEntry = {
        tool_name,
        ema_score: event,
        hits: outcome === 'hit' ? 1 : 0,
        corrections: outcome === 'correction' ? 1 : 0,
        total_events: 1,
        confidence: 'no_data',
        last_updated: Date.now(),
      }
      entry.confidence = this._confidence(entry)
      this.scores.set(tool_name, entry)
    } else {
      existing.ema_score = EMA_ALPHA * event + (1 - EMA_ALPHA) * existing.ema_score
      if (outcome === 'hit') existing.hits++
      else existing.corrections++
      existing.total_events++
      existing.confidence = this._confidence(existing)
      existing.last_updated = Date.now()
    }

    if (this.persistPath) this._save()
  }

  /**
   * Should the dispatcher speculate this tool right now?
   *   training   → always yes (collect data)
   *   production → only if score is reliable and above threshold
   */
  shouldSpeculate(tool_name: string): boolean {
    if (this.mode === 'training') return true
    const e = this.scores.get(tool_name)
    // Not enough data yet → optimistic (speculate to keep learning)
    if (!e || e.total_events < MIN_EVENTS_FOR_CONFIDENCE) return true
    return e.ema_score >= IntentScoreStore.SPECULATE_MIN_SCORE
  }

  getAll(): ScoreEntry[] {
    return [...this.scores.values()].sort((a, b) => b.total_events - a.total_events)
  }

  /** Overall hit rate across all speculated tools. */
  overallHitRate(): number {
    const all = this.getAll()
    const total = all.reduce((s, e) => s + e.total_events, 0)
    if (total === 0) return 0
    const hits = all.reduce((s, e) => s + e.hits, 0)
    return hits / total
  }

  // ─── Persistence ──────────────────────────────────────────────────────────

  private _save(): void {
    if (!this.persistPath) return
    try {
      mkdirSync(dirname(this.persistPath), { recursive: true })
      writeFileSync(this.persistPath, JSON.stringify(this.getAll(), null, 2), 'utf-8')
    } catch {
      /* ignore write errors in demo */
    }
  }

  private _load(): void {
    if (!this.persistPath) return
    try {
      const raw = readFileSync(this.persistPath, 'utf-8')
      const entries: ScoreEntry[] = JSON.parse(raw)
      for (const e of entries) this.scores.set(e.tool_name, e)
    } catch {
      /* first run — no file yet */
    }
  }

  // ─── Internal ─────────────────────────────────────────────────────────────

  private _confidence(e: ScoreEntry): ScoreEntry['confidence'] {
    if (e.total_events < MIN_EVENTS_FOR_CONFIDENCE) return 'no_data'
    if (e.ema_score >= IntentScoreStore.SPECULATE_HIGH_SCORE) return 'high'
    if (e.ema_score >= IntentScoreStore.SPECULATE_MIN_SCORE) return 'medium'
    return 'low'
  }
}
