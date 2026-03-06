import type { IEventBus, Unsubscribe } from 'fitalyagents'
import type {
  IEmbeddingClassifier,
  ILLMFallbackAgent,
  SpeechFinalEvent,
  SpeechPartialEvent,
  ClassifyResult,
} from '../types/index.js'
import type { SpeculativeCache } from '../speculative-cache.js'
import { CONFIDENCE_THRESHOLD } from '../types/index.js'

// Ambient timer declarations (available in Node.js but not in ES2022 lib)
declare function setInterval(callback: () => void, ms: number): number
declare function clearInterval(id: number): void

// ── Speculative execution thresholds ─────────────────────────────────────────

/**
 * Confidence **and** margin thresholds for speculative execution
 * on SPEECH_PARTIAL events. These are intentionally stricter than
 * CONFIDENCE_THRESHOLD (0.85) because we're pre-executing before
 * the user finishes speaking.
 */
export const SPECULATIVE_CONFIDENCE_MIN = 0.9
export const SPECULATIVE_MARGIN_MIN = 0.15

// ── Tool safety levels for speculative decisions ─────────────────────────────

export type SpeculativeSafetyLevel = 'safe' | 'staged' | 'protected' | 'restricted'

export interface SpeculativeToolMeta {
  tool_id: string
  safety: SpeculativeSafetyLevel
}

/**
 * Callback to execute a SAFE tool speculatively.
 * Returns the tool result (or throws on failure).
 */
export type SpeculativeExecutor = (intentId: string, sessionId: string) => Promise<unknown>

/**
 * Resolves an intent_id to its tool metadata (safety level, tool_id).
 * Returns null if the intent doesn't map to a known tool.
 */
export type IntentToolResolver = (intentId: string) => SpeculativeToolMeta | null

// ── Dependencies ─────────────────────────────────────────────────────────────

/**
 * Dependencies for the NodeDispatcher.
 */
export interface NodeDispatcherDeps {
  bus: IEventBus
  classifier: IEmbeddingClassifier
  fallbackAgent: ILLMFallbackAgent
  /** Lock watchdog interval in ms (default: 1000) */
  watchdogIntervalMs?: number
  /**
   * Callback invoked when the lock watchdog fires.
   * In production, this scans for expired locks and times out tasks.
   */
  onWatchdogTick?: () => Promise<void>

  // ── Sprint 5.1: Speculative execution ──────────────────────────────────

  /** Speculative cache instance. When provided, enables SPEECH_PARTIAL handling. */
  speculativeCache?: SpeculativeCache
  /**
   * Resolves intent_id → tool safety level.
   * Required when speculativeCache is provided.
   */
  intentToolResolver?: IntentToolResolver
  /**
   * Executes a SAFE tool speculatively (before the user finishes speaking).
   * Required when speculativeCache is provided.
   */
  speculativeExecutor?: SpeculativeExecutor
  /** TTL for speculative SAFE tool results in ms (default: 30_000). */
  speculativeTtlMs?: number
  /** TTL for speculative hints (PROTECTED/RESTRICTED) in ms (default: 10_000). */
  speculativeHintTtlMs?: number
}

/**
 * NodeDispatcher orchestrates all dispatcher workers concurrently.
 *
 * Workers:
 * - **speechListener** — subscribes to `bus:SPEECH_FINAL`, classifies text,
 *   publishes confident results as `bus:TASK_AVAILABLE` or low-confidence
 *   ones as `bus:DISPATCH_FALLBACK`
 * - **partialListener** — (when speculativeCache is provided) subscribes to
 *   `bus:SPEECH_PARTIAL`, classifies partial text and pre-executes SAFE tools
 * - **fallbackAgent** — started via `ILLMFallbackAgent.start()`
 * - **intentReloader** — subscribes to `bus:INTENT_UPDATED`, calls
 *   `classifier.reloadIntent()`
 * - **lockWatchdog** — periodic interval for expired lock detection
 *
 * The CapabilityRouter from `@fitalyagents/core` should be started
 * separately — it subscribes to `bus:TASK_AVAILABLE` on its own.
 *
 * @example
 * ```typescript
 * const dispatcher = new NodeDispatcher({
 *   bus,
 *   classifier,
 *   fallbackAgent,
 *   speculativeCache,
 *   intentToolResolver: (id) => toolRegistry.getMeta(id),
 *   speculativeExecutor: (id, sid) => executor.run(id, sid),
 * })
 * await dispatcher.start()
 * // ... later
 * dispatcher.dispose()
 * ```
 */
export class NodeDispatcher {
  private readonly bus: IEventBus
  private readonly classifier: IEmbeddingClassifier
  private readonly fallbackAgent: ILLMFallbackAgent
  private readonly watchdogIntervalMs: number
  private readonly onWatchdogTick?: () => Promise<void>

  // Speculative execution
  private readonly speculativeCache: SpeculativeCache | null
  private readonly intentToolResolver: IntentToolResolver | null
  private readonly speculativeExecutor: SpeculativeExecutor | null
  private readonly speculativeTtlMs: number
  private readonly speculativeHintTtlMs: number

  private unsubs: Unsubscribe[] = []
  private watchdogTimer: number | null = null
  private started = false

  constructor(deps: NodeDispatcherDeps) {
    this.bus = deps.bus
    this.classifier = deps.classifier
    this.fallbackAgent = deps.fallbackAgent
    this.watchdogIntervalMs = deps.watchdogIntervalMs ?? 1000
    this.onWatchdogTick = deps.onWatchdogTick

    // Speculative
    this.speculativeCache = deps.speculativeCache ?? null
    this.intentToolResolver = deps.intentToolResolver ?? null
    this.speculativeExecutor = deps.speculativeExecutor ?? null
    this.speculativeTtlMs = deps.speculativeTtlMs ?? 30_000
    this.speculativeHintTtlMs = deps.speculativeHintTtlMs ?? 10_000
  }

  // ── Start all workers ─────────────────────────────────────────────────

  async start(): Promise<void> {
    if (this.started) throw new Error('NodeDispatcher already started')
    this.started = true

    // Initialize classifier (loads intents, embeds them)
    await this.classifier.init()

    // Worker 1: Speech listener
    this.startSpeechListener()

    // Worker 2: Fallback agent
    this.fallbackAgent.start()

    // Worker 3: Intent reloader
    this.startIntentReloader()

    // Worker 4: Lock watchdog
    this.startLockWatchdog()

    // Worker 5: Partial speech → speculative execution
    if (this.speculativeCache) {
      this.startPartialListener()
    }
  }

  // ── Dispose ───────────────────────────────────────────────────────────

  dispose(): void {
    for (const unsub of this.unsubs) unsub()
    this.unsubs = []

    this.fallbackAgent.dispose()
    this.classifier.dispose()

    if (this.watchdogTimer) {
      clearInterval(this.watchdogTimer)
      this.watchdogTimer = null
    }

    this.started = false
  }

  get isStarted(): boolean {
    return this.started
  }

  // ── Workers ───────────────────────────────────────────────────────────

  private startSpeechListener(): void {
    const unsub = this.bus.subscribe('bus:SPEECH_FINAL', (data) => {
      const event = data as SpeechFinalEvent
      void this.handleSpeech(event)
    })
    this.unsubs.push(unsub)
  }

  private startPartialListener(): void {
    const unsub = this.bus.subscribe('bus:SPEECH_PARTIAL', (data) => {
      const event = data as SpeechPartialEvent
      void this.handlePartial(event)
    })
    this.unsubs.push(unsub)
  }

  private startIntentReloader(): void {
    const unsub = this.bus.subscribe('bus:INTENT_UPDATED', (data) => {
      const event = data as { intent_id: string }
      void this.classifier.reloadIntent(event.intent_id)
    })
    this.unsubs.push(unsub)
  }

  private startLockWatchdog(): void {
    if (!this.onWatchdogTick) return

    const tick = this.onWatchdogTick
    this.watchdogTimer = setInterval(() => {
      void tick()
    }, this.watchdogIntervalMs)
  }

  // ── Core dispatch logic ───────────────────────────────────────────────

  private async handleSpeech(event: SpeechFinalEvent): Promise<void> {
    const result: ClassifyResult = await this.classifier.classify(event.text)

    if (result.type === 'confident' && result.confidence >= CONFIDENCE_THRESHOLD) {
      // Fast dispatch: publish directly to task queue
      await this.bus.publish('bus:TASK_AVAILABLE', {
        event: 'TASK_AVAILABLE',
        task_id: `speech_${Date.now()}`,
        session_id: event.session_id,
        intent_id: result.intent_id,
        domain_required: result.domain_required,
        scope_hint: result.scope_hint,
        capabilities_required: result.capabilities_required,
        slots: {},
        priority: 5,
        source: 'classifier',
        classifier_confidence: result.confidence,
        timeout_ms: 8000,
        created_at: Date.now(),
      })
    } else {
      // Low confidence: publish fallback request
      await this.bus.publish('bus:DISPATCH_FALLBACK', {
        event: 'DISPATCH_FALLBACK',
        session_id: event.session_id,
        text: event.text,
        classifier_confidence: result.confidence,
        top_candidates: result.type === 'fallback' ? result.top_candidates : result.candidates,
        timestamp: Date.now(),
      })
    }
  }

  // ── Speculative execution logic ───────────────────────────────────────

  /**
   * Handle SPEECH_PARTIAL: classify partial text, and if confident enough,
   * pre-execute SAFE tools or cache hints for PROTECTED/RESTRICTED.
   *
   * Thresholds are stricter than SPEECH_FINAL because we're speculating:
   * - confidence ≥ 0.90 (vs 0.85 for FINAL)
   * - margin (1st - 2nd candidate) ≥ 0.15
   */
  private async handlePartial(event: SpeechPartialEvent): Promise<void> {
    if (!this.speculativeCache) return

    const result = await this.classifier.classify(event.text)

    if (result.type !== 'confident') return
    if (result.confidence < SPECULATIVE_CONFIDENCE_MIN) return

    // Check margin between top candidates
    const margin = this.computeMargin(result)
    if (margin < SPECULATIVE_MARGIN_MIN) return

    // Already cached? Skip.
    const existing = this.speculativeCache.get(event.session_id, result.intent_id)
    if (existing) return

    // Resolve tool safety level
    const toolMeta = this.intentToolResolver?.(result.intent_id)
    if (!toolMeta) return

    await this.speculate(event.session_id, result.intent_id, toolMeta, result.confidence)
  }

  /**
   * Execute speculative action based on safety level.
   */
  private async speculate(
    sessionId: string,
    intentId: string,
    toolMeta: SpeculativeToolMeta,
    confidence: number,
  ): Promise<void> {
    if (!this.speculativeCache) return

    switch (toolMeta.safety) {
      case 'safe': {
        // Pre-execute the tool
        if (!this.speculativeExecutor) return
        try {
          const toolResult = await this.speculativeExecutor(intentId, sessionId)
          this.speculativeCache.set(sessionId, intentId, toolResult, this.speculativeTtlMs)

          // Notify the bus that we have a speculative result
          await this.bus.publish('bus:SPECULATIVE_HIT', {
            event: 'SPECULATIVE_HIT',
            session_id: sessionId,
            intent_id: intentId,
            type: 'tool_result',
            timestamp: Date.now(),
          })
        } catch {
          // Speculative execution failed — not critical, FINAL will handle normally
        }
        break
      }

      case 'staged': {
        // For staged tools, we cache a hint (no pre-execution, draft creation
        // should happen only after FINAL confirmation)
        this.speculativeCache.setHint(sessionId, intentId, confidence, this.speculativeHintTtlMs)
        break
      }

      case 'protected':
      case 'restricted': {
        // Cache a hint only — no pre-execution for protected/restricted
        this.speculativeCache.setHint(sessionId, intentId, confidence, this.speculativeHintTtlMs)
        break
      }
    }
  }

  /**
   * Compute the margin between the top candidate and the second-best.
   * Returns 1.0 if there is only one candidate.
   */
  private computeMargin(result: ClassifyResult): number {
    if (result.type === 'fallback') return 0

    const candidates = result.candidates
    if (!candidates || candidates.length < 2) return 1.0

    // Candidates are sorted by score descending
    const sorted = [...candidates].sort((a, b) => b.score - a.score)
    return sorted[0]!.score - sorted[1]!.score
  }
}
