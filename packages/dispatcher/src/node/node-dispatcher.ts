import type { IEventBus, Unsubscribe } from 'fitalyagents'
import type {
  IEmbeddingClassifier,
  ILLMFallbackAgent,
  SpeechFinalEvent,
  ClassifyResult,
} from '../types/index.js'
import { CONFIDENCE_THRESHOLD } from '../types/index.js'

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
}

/**
 * NodeDispatcher orchestrates all dispatcher workers concurrently.
 *
 * Workers:
 * - **speechListener** — subscribes to `bus:SPEECH_FINAL`, classifies text,
 *   publishes confident results as `bus:TASK_AVAILABLE` or low-confidence
 *   ones as `bus:DISPATCH_FALLBACK`
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

  private unsubs: Unsubscribe[] = []
  private watchdogTimer: ReturnType<typeof setInterval> | null = null
  private started = false

  constructor(deps: NodeDispatcherDeps) {
    this.bus = deps.bus
    this.classifier = deps.classifier
    this.fallbackAgent = deps.fallbackAgent
    this.watchdogIntervalMs = deps.watchdogIntervalMs ?? 1000
    this.onWatchdogTick = deps.onWatchdogTick
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
}
