import { StreamAgent } from './stream-agent.js'
import type { IEventBus } from '../types/index.js'
import type { IContextStore } from '../context/types.js'

// ── Types ────────────────────────────────────────────────────────────────────

export type ProactiveReason =
  | 'idle_customer'
  | 'out_of_stock'
  | 'draft_expired'
  | 'unanswered_question'
  | 'sentiment_alert'

export interface ProactiveTrigger {
  session_id: string
  reason: ProactiveReason
  context: Record<string, unknown>
  timestamp: number
}

export interface ProactiveAgentConfig {
  /** Idle timeout in ms before triggering idle_customer. Default: 30_000 (30s). */
  idleTimeoutMs?: number
  /** Whether to enable idle detection. Default: true. */
  enableIdleDetection?: boolean
}

// ── ProactiveAgent ───────────────────────────────────────────────────────────

/**
 * ProactiveAgent — detects situations requiring proactive engagement.
 *
 * Monitors:
 * - Customer idle time (no SPEECH_FINAL for N seconds)
 * - Out-of-stock from ACTION_COMPLETED results
 * - Draft expiry from DRAFT_CANCELLED with ttl_expired
 * - Session sentiment alerts from SentimentGuard
 *
 * Emits bus:PROACTIVE_TRIGGER for InteractionAgent to decide
 * whether to speak (avoiding being intrusive).
 *
 * @example
 * ```typescript
 * const proactive = new ProactiveAgent({
 *   bus,
 *   contextStore,
 *   config: { idleTimeoutMs: 30_000 },
 * })
 *
 * await proactive.start()
 * // When customer is idle for 30s, publishes:
 * // bus:PROACTIVE_TRIGGER { reason: 'idle_customer', ... }
 * ```
 */
export class ProactiveAgent extends StreamAgent {
  private readonly contextStore: IContextStore
  private readonly idleTimeoutMs: number
  private readonly enableIdleDetection: boolean
  private readonly idleTimers = new Map<string, ReturnType<typeof setTimeout>>()

  protected get channels(): string[] {
    return [
      'bus:SPEECH_FINAL',
      'bus:ACTION_COMPLETED',
      'bus:DRAFT_CANCELLED',
      'bus:SESSION_SENTIMENT_ALERT',
    ]
  }

  constructor(deps: {
    bus: IEventBus
    contextStore: IContextStore
    config?: ProactiveAgentConfig
  }) {
    super(deps.bus)
    this.contextStore = deps.contextStore
    this.idleTimeoutMs = deps.config?.idleTimeoutMs ?? 30_000
    this.enableIdleDetection = deps.config?.enableIdleDetection ?? true
  }

  async onEvent(channel: string, payload: unknown): Promise<void> {
    const data = payload as Record<string, unknown>
    const sessionId = data.session_id as string | undefined
    if (!sessionId) return

    switch (channel) {
      case 'bus:SPEECH_FINAL':
        this.handleSpeechFinal(sessionId)
        break
      case 'bus:ACTION_COMPLETED':
        await this.handleActionCompleted(sessionId, data)
        break
      case 'bus:DRAFT_CANCELLED':
        await this.handleDraftCancelled(sessionId, data)
        break
      case 'bus:SESSION_SENTIMENT_ALERT':
        await this.handleSentimentAlert(sessionId, data)
        break
    }
  }

  /**
   * Stop idle timers and agent.
   */
  async stop(): Promise<void> {
    this.clearAllTimers()
    await super.stop()
  }

  // ── Event handlers ─────────────────────────────────────────────────────

  private handleSpeechFinal(sessionId: string): void {
    // Reset idle timer — customer just spoke
    this.resetIdleTimer(sessionId)
  }

  private async handleActionCompleted(
    sessionId: string,
    data: Record<string, unknown>,
  ): Promise<void> {
    // Check for out-of-stock signals
    const result = data.result as Record<string, unknown> | undefined
    if (!result) return

    const isOutOfStock =
      result.stock === 0 ||
      result.in_stock === false ||
      (Array.isArray(result.products) && result.products.length === 0)

    if (isOutOfStock) {
      await this.publishTrigger(sessionId, 'out_of_stock', {
        intent_id: data.intent_id,
        result,
      })
    }
  }

  private async handleDraftCancelled(
    sessionId: string,
    data: Record<string, unknown>,
  ): Promise<void> {
    if (data.reason === 'ttl_expired') {
      await this.publishTrigger(sessionId, 'draft_expired', {
        draft_id: data.draft_id,
      })
    }
  }

  private async handleSentimentAlert(
    sessionId: string,
    data: Record<string, unknown>,
  ): Promise<void> {
    await this.publishTrigger(sessionId, 'sentiment_alert', {
      level: data.level,
      consecutive_count: data.consecutive_count,
      trigger_text: data.trigger_text,
      speaker_id: data.speaker_id,
    })
  }

  // ── Idle detection ─────────────────────────────────────────────────────

  private resetIdleTimer(sessionId: string): void {
    if (!this.enableIdleDetection) return

    // Clear existing timer
    const existing = this.idleTimers.get(sessionId)
    if (existing) clearTimeout(existing)

    // Start new timer
    const timer = setTimeout(() => {
      this.idleTimers.delete(sessionId)
      void this.publishTrigger(sessionId, 'idle_customer', {
        idle_ms: this.idleTimeoutMs,
      })
    }, this.idleTimeoutMs)

    if (typeof timer === 'object' && 'unref' in timer) {
      timer.unref()
    }

    this.idleTimers.set(sessionId, timer)
  }

  private clearAllTimers(): void {
    for (const timer of this.idleTimers.values()) {
      clearTimeout(timer)
    }
    this.idleTimers.clear()
  }

  // ── Publish ────────────────────────────────────────────────────────────

  private async publishTrigger(
    sessionId: string,
    reason: ProactiveReason,
    context: Record<string, unknown>,
  ): Promise<void> {
    const trigger: ProactiveTrigger = {
      session_id: sessionId,
      reason,
      context,
      timestamp: Date.now(),
    }

    await this.bus.publish('bus:PROACTIVE_TRIGGER', {
      event: 'PROACTIVE_TRIGGER',
      ...trigger,
    })
  }
}
