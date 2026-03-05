/**
 * IntentRegistry — speculative tool execution with LLM feedback loop.
 *
 * Flow per request:
 *   1. Dispatcher calls speculate() → starts tool in background immediately
 *   2. LLM decides which tool to call
 *   3. resolve() intercepts the call:
 *        HIT        — same tool → returns cached result (0ms wait)
 *        CORRECTION — different tool → records correction, executes fresh
 *        MISS       — no speculation existed → records miss, executes fresh
 *
 * Outcomes accumulate across requests. Sprint D2 will use them to drive
 * dispatcher score updates (EMA per intent→tool_name mapping).
 */

import type { Intent } from './dispatcher.js'

export type OutcomeType = 'hit' | 'correction' | 'miss'

export interface OutcomeEvent {
  outcome: OutcomeType
  dispatcher_tool: string | null // null on MISS
  llm_tool: string
  latency_saved_ms: number // TOOL_LATENCY_MS on HIT, 0 otherwise
  ts: number
}

interface SpecEntry {
  intent: Intent
  tool_name: string
  status: 'running' | 'done' | 'cancelled'
  resultPromise: Promise<unknown>
  _resolve: (v: unknown) => void
}

export class IntentRegistry {
  private entry: SpecEntry | null = null
  private outcomes: OutcomeEvent[] = []

  /**
   * Dispatcher starts a speculative tool execution.
   * executor() runs immediately in the background.
   * A previous unresolved speculation is cancelled automatically.
   */
  speculate(intent: Intent, tool_name: string, executor: () => Promise<unknown>): void {
    this._cancel()

    let _resolve!: (v: unknown) => void
    const resultPromise = new Promise<unknown>((r) => {
      _resolve = r
    })

    const entry: SpecEntry = { intent, tool_name, status: 'running', resultPromise, _resolve }
    this.entry = entry

    executor()
      .then((result) => {
        if (entry.status === 'running') {
          entry.status = 'done'
          _resolve(result)
        }
      })
      .catch(() => {
        if (entry.status === 'running') {
          entry.status = 'cancelled'
          _resolve(null)
        }
      })
  }

  /**
   * LLM is about to execute llm_tool_name. Check the registry:
   *   HIT        → same tool, return cached result Promise (resolves immediately if done)
   *   CORRECTION → different tool, return null (caller executes normally)
   *   MISS       → no speculation, return null (caller executes normally)
   */
  resolve(
    llm_tool: string,
    toolLatencyMs = 300,
  ): {
    cached: boolean
    resultPromise: Promise<unknown> | null
    latency_saved_ms: number
  } {
    const e = this.entry

    if (e && e.status !== 'cancelled' && e.tool_name === llm_tool) {
      // HIT — dispatcher speculated the same tool
      e.status = 'done'
      this.entry = null
      this.outcomes.push({
        outcome: 'hit',
        dispatcher_tool: e.tool_name,
        llm_tool,
        latency_saved_ms: toolLatencyMs,
        ts: Date.now(),
      })
      return { cached: true, resultPromise: e.resultPromise, latency_saved_ms: toolLatencyMs }
    }

    if (e && e.status !== 'cancelled') {
      // CORRECTION — dispatcher ran a different tool
      this._cancel()
      this.outcomes.push({
        outcome: 'correction',
        dispatcher_tool: e.tool_name,
        llm_tool,
        latency_saved_ms: 0,
        ts: Date.now(),
      })
    } else {
      // MISS — no speculation existed
      this.outcomes.push({
        outcome: 'miss',
        dispatcher_tool: null,
        llm_tool,
        latency_saved_ms: 0,
        ts: Date.now(),
      })
    }

    return { cached: false, resultPromise: null, latency_saved_ms: 0 }
  }

  /** LLM responded without calling any tool — speculation goes unused. */
  onNoToolCall(): void {
    this._cancel()
  }

  private _cancel(): void {
    if (this.entry?.status === 'running') {
      this.entry.status = 'cancelled'
      this.entry._resolve(null)
    }
    this.entry = null
  }

  // ─── Metrics ──────────────────────────────────────────────────────────────

  getLastOutcome(): OutcomeEvent | null {
    return this.outcomes.at(-1) ?? null
  }

  getOutcomes(): OutcomeEvent[] {
    return [...this.outcomes]
  }

  /**
   * Hit rate = hits / queries_where_dispatcher_speculated.
   * Queries with no speculation (L4 fallback, intent=none) are excluded.
   */
  getHitRate(window?: number): number {
    const slice = window ? this.outcomes.slice(-window) : this.outcomes
    const speculated = slice.filter((o) => o.dispatcher_tool !== null)
    if (speculated.length === 0) return 0
    return speculated.filter((o) => o.outcome === 'hit').length / speculated.length
  }

  getTotalSavedMs(): number {
    return this.outcomes.reduce((s, o) => s + o.latency_saved_ms, 0)
  }
}
