import type { IEventBus, Unsubscribe, ITracer } from 'fitalyagents'
import { NoopTracer } from 'fitalyagents'
import type {
  IEmbeddingClassifier,
  ILLMFallbackAgent,
  SpeechFinalEvent,
  SpeechPartialEvent,
  ClassifyResult,
} from '../types/index.js'
import type { SpeculativeCache } from '../speculative-cache.js'
import { CONFIDENCE_THRESHOLD } from '../types/index.js'
import type { IMemoryStore, MemoryHit } from '../memory/types.js'
import type {
  MemoryScope,
  MemoryScopeResolveInput,
  MemoryScopeResolver,
} from '../memory/scope-resolver.js'
import { createDefaultMemoryScope } from '../memory/scope-resolver.js'

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
const PENDING_FALLBACK_TTL_MS = 60_000
const MAX_PENDING_FALLBACKS_PER_SESSION = 32

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

interface TaskAvailableLike {
  session_id: string
  source?: string
  slots?: Record<string, unknown>
}

interface PendingFallbackMemory {
  text: string
  scope: MemoryScope
  createdAt: number
}

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
  /** Optional observability tracer. Defaults to NoopTracer. */
  tracer?: ITracer
  /** Optional semantic memory store used to enrich fallback requests. */
  memoryStore?: IMemoryStore
  /** Optional resolver that maps events to a memory scope (actor, group, store, or session). */
  memoryScopeResolver?: MemoryScopeResolver
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

  private readonly tracer: ITracer
  private readonly memoryStore: IMemoryStore | null
  private readonly memoryScopeResolver: MemoryScopeResolver | null

  private unsubs: Unsubscribe[] = []
  private watchdogTimer: number | null = null
  private started = false
  private readonly pendingFallbacks = new Map<string, PendingFallbackMemory[]>()

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
    this.tracer = deps.tracer ?? new NoopTracer()
    this.memoryStore = deps.memoryStore ?? null
    this.memoryScopeResolver = deps.memoryScopeResolver ?? null
  }

  // ── Start all workers ─────────────────────────────────────────────────

  async start(): Promise<void> {
    if (this.started) throw new Error('NodeDispatcher already started')
    this.started = true

    // Initialize classifier (loads intents, embeds them)
    await this.classifier.init()

    // Worker 1: Speech listener
    this.startSpeechListener()

    // Worker 2: Observe resolved fallback tasks for memory writes
    this.startTaskAvailableListener()

    // Worker 3: Fallback agent
    this.fallbackAgent.start()

    // Worker 4: Intent reloader
    this.startIntentReloader()

    // Worker 5: Lock watchdog
    this.startLockWatchdog()

    // Worker 6: Partial speech → speculative execution
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
    this.memoryStore?.dispose?.()
    this.pendingFallbacks.clear()

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

  private startTaskAvailableListener(): void {
    const unsub = this.bus.subscribe('bus:TASK_AVAILABLE', (data) => {
      const event = data as TaskAvailableLike
      void this.handleTaskAvailable(event)
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

    const trace = this.tracer.startTrace('dispatcher_classify', {
      sessionId: event.session_id,
      input: { text: event.text },
    })

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
      this.scheduleMemoryWrite(event)
      trace.score('classifier_confidence', result.confidence)
      trace.score('classifier_hit', 1)
      trace.end({ intent_id: result.intent_id, outcome: 'hit' })
    } else {
      const scope = await this.resolveMemoryScope(event)
      const memoryHits = await this.queryMemoryContext(event, scope)
      this.registerPendingFallback(event, scope)

      // Low confidence: publish fallback request
      await this.bus.publish('bus:DISPATCH_FALLBACK', {
        event: 'DISPATCH_FALLBACK',
        session_id: event.session_id,
        text: event.text,
        classifier_confidence: result.confidence,
        top_candidates: result.type === 'fallback' ? result.top_candidates : result.candidates,
        ...(memoryHits.length > 0 ? { memory_context: memoryHits } : {}),
        timestamp: Date.now(),
      })
      trace.score('classifier_confidence', result.confidence)
      trace.score('classifier_hit', 0, 'fell back to LLM')
      trace.end({ outcome: 'fallback' })
    }
  }

  private async handleTaskAvailable(event: TaskAvailableLike): Promise<void> {
    if (!this.memoryStore) return
    if (event.source !== 'llm_fallback') return

    const pending = this.consumePendingFallback(
      event.session_id,
      this.extractRawTextFromTask(event),
      this.memoryScopeResolver !== null,
    )

    if (pending) {
      await this.writeMemoryEntry(pending.text, pending.scope)
      return
    }

    // If no custom resolver is configured, falling back to session scope is safe.
    if (this.memoryScopeResolver) return

    const rawText = this.extractRawTextFromTask(event)
    if (!rawText) return

    await this.writeMemoryEntry(rawText, createDefaultMemoryScope(event.session_id))
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

  private async queryMemoryContext(
    event: SpeechFinalEvent,
    scope: MemoryScope,
  ): Promise<MemoryHit[]> {
    if (!this.memoryStore) return []

    try {
      return await this.memoryStore.query(event.text, {
        wing: scope.wing,
        room: scope.room,
        n: 3,
      })
    } catch {
      return []
    }
  }

  private scheduleMemoryWrite(event: SpeechFinalEvent): void {
    if (!this.memoryStore || event.text.trim().length === 0) return

    void this.resolveMemoryScope(event)
      .then((scope) => this.writeMemoryEntry(event.text, scope))
      .catch(() => {
        // Memory must never break dispatch flow.
      })
  }

  private async writeMemoryEntry(text: string, scope: MemoryScope): Promise<void> {
    if (!this.memoryStore || text.trim().length === 0) return

    await this.memoryStore.write({
      text,
      wing: scope.wing,
      room: scope.room,
    })
  }

  private async resolveMemoryScope(event: SpeechFinalEvent): Promise<MemoryScope> {
    if (!this.memoryScopeResolver) {
      return createDefaultMemoryScope(event.session_id)
    }

    try {
      const resolved = await this.memoryScopeResolver(this.toMemoryScopeInput(event))
      if (resolved) return resolved
    } catch {
      // Fall back to the session scope when the custom resolver fails.
    }

    return createDefaultMemoryScope(event.session_id)
  }

  private toMemoryScopeInput(event: SpeechFinalEvent): MemoryScopeResolveInput {
    return {
      session_id: event.session_id,
      text: event.text,
      locale: event.locale,
      speaker_id: event.speaker_id,
      role: event.role,
      actor_type: event.actor_type,
      store_id: event.store_id,
      group_id: event.group_id,
      timestamp: event.timestamp,
    }
  }

  private registerPendingFallback(event: SpeechFinalEvent, scope: MemoryScope): void {
    if (!this.memoryStore || event.text.trim().length === 0) return

    const entries = this.pendingFallbacks.get(event.session_id) ?? []
    const fresh = this.pruneExpiredPending(entries)

    fresh.push({
      text: event.text,
      scope,
      createdAt: Date.now(),
    })

    if (fresh.length > MAX_PENDING_FALLBACKS_PER_SESSION) {
      fresh.splice(0, fresh.length - MAX_PENDING_FALLBACKS_PER_SESSION)
    }

    this.pendingFallbacks.set(event.session_id, fresh)
  }

  private consumePendingFallback(
    sessionId: string,
    rawText?: string,
    strictMatch = false,
  ): PendingFallbackMemory | null {
    const entries = this.pendingFallbacks.get(sessionId)
    if (!entries || entries.length === 0) return null

    const fresh = this.pruneExpiredPending(entries)
    if (fresh.length === 0) {
      this.pendingFallbacks.delete(sessionId)
      return null
    }

    let index = -1
    if (rawText) {
      index = fresh.findIndex((entry) => entry.text === rawText)
    }

    if (index === -1 && !strictMatch) {
      index = 0
    }

    if (index === -1) {
      this.pendingFallbacks.set(sessionId, fresh)
      return null
    }

    const [matched] = fresh.splice(index, 1)
    if (fresh.length === 0) {
      this.pendingFallbacks.delete(sessionId)
    } else {
      this.pendingFallbacks.set(sessionId, fresh)
    }

    return matched ?? null
  }

  private pruneExpiredPending(entries: PendingFallbackMemory[]): PendingFallbackMemory[] {
    const cutoff = Date.now() - PENDING_FALLBACK_TTL_MS
    return entries.filter((entry) => entry.createdAt >= cutoff)
  }

  private extractRawTextFromTask(event: TaskAvailableLike): string | undefined {
    const raw = event.slots?.raw_text
    return typeof raw === 'string' && raw.trim().length > 0 ? raw : undefined
  }
}
