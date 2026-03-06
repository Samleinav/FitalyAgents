import { StreamAgent } from './stream-agent.js'
import type { IEventBus } from '../types/index.js'
import type { IContextStore } from '../context/types.js'

// ── Types ────────────────────────────────────────────────────────────────────

export interface ConversationTurn {
  role: 'user' | 'assistant'
  content: string
  timestamp: number
}

export interface ConversationContext {
  session_id: string
  conversation_history: ConversationTurn[]
  last_product_mentioned: string | null
  pending_draft: { draft_id: string; intent_id: string; items: Record<string, unknown> } | null
  action_history: Array<{ intent_id: string; result: unknown; timestamp: number }>
  ambient_context: Record<string, unknown>
}

export interface ContextBuilderConfig {
  /** Maximum number of conversation turns to keep. Default: 20. */
  maxTurns?: number
  /** Maximum number of action history entries to keep. Default: 10. */
  maxActions?: number
}

// ── ContextBuilderAgent ──────────────────────────────────────────────────────

/**
 * ContextBuilderAgent — maintains enriched conversation context per session.
 *
 * Subscribes to:
 * - SPEECH_FINAL: captures user utterances
 * - AMBIENT_CONTEXT: environmental signals (noise, speaker changes, etc.)
 * - ACTION_COMPLETED: tool execution results
 * - DRAFT_CREATED: new draft orders
 * - DRAFT_CONFIRMED: confirmed orders
 * - DRAFT_CANCELLED: cancelled/expired orders
 *
 * Stores per session:
 * - conversation_history (latest N turns)
 * - last_product_mentioned
 * - pending_draft
 * - action_history
 * - ambient_context
 *
 * @example
 * ```typescript
 * const ctxAgent = new ContextBuilderAgent({
 *   bus,
 *   contextStore,
 *   config: { maxTurns: 20, maxActions: 10 },
 * })
 *
 * await ctxAgent.start()
 * const ctx = await ctxAgent.getEnrichedContext('session-1')
 * ```
 */
export class ContextBuilderAgent extends StreamAgent {
  private readonly contextStore: IContextStore
  private readonly maxTurns: number
  private readonly maxActions: number

  protected get channels(): string[] {
    return [
      'bus:SPEECH_FINAL',
      'bus:AMBIENT_CONTEXT',
      'bus:ACTION_COMPLETED',
      'bus:DRAFT_CREATED',
      'bus:DRAFT_CONFIRMED',
      'bus:DRAFT_CANCELLED',
    ]
  }

  constructor(deps: {
    bus: IEventBus
    contextStore: IContextStore
    config?: ContextBuilderConfig
  }) {
    super(deps.bus)
    this.contextStore = deps.contextStore
    this.maxTurns = deps.config?.maxTurns ?? 20
    this.maxActions = deps.config?.maxActions ?? 10
  }

  async onEvent(channel: string, payload: unknown): Promise<void> {
    const data = payload as Record<string, unknown>
    const sessionId = data.session_id as string | undefined
    if (!sessionId) return

    switch (channel) {
      case 'bus:SPEECH_FINAL':
        await this.handleSpeechFinal(sessionId, data)
        break
      case 'bus:AMBIENT_CONTEXT':
        await this.handleAmbientContext(sessionId, data)
        break
      case 'bus:ACTION_COMPLETED':
        await this.handleActionCompleted(sessionId, data)
        break
      case 'bus:DRAFT_CREATED':
        await this.handleDraftCreated(sessionId, data)
        break
      case 'bus:DRAFT_CONFIRMED':
        await this.handleDraftConfirmed(sessionId)
        break
      case 'bus:DRAFT_CANCELLED':
        await this.handleDraftCancelled(sessionId)
        break
    }
  }

  /**
   * Get the full enriched conversation context for a session.
   * Returns all accumulated state for use by InteractionAgent.
   */
  async getEnrichedContext(sessionId: string): Promise<ConversationContext> {
    const history =
      (await this.contextStore.get<ConversationTurn[]>(sessionId, 'conversation_history')) ?? []

    const lastProduct =
      (await this.contextStore.get<string>(sessionId, 'last_product_mentioned')) ?? null

    const pendingDraft =
      (await this.contextStore.get<ConversationContext['pending_draft']>(
        sessionId,
        'pending_draft',
      )) ?? null

    const actions =
      (await this.contextStore.get<ConversationContext['action_history']>(
        sessionId,
        'action_history',
      )) ?? []

    const ambient =
      (await this.contextStore.get<Record<string, unknown>>(sessionId, 'ambient_context')) ?? {}

    return {
      session_id: sessionId,
      conversation_history: history,
      last_product_mentioned: lastProduct,
      pending_draft: pendingDraft,
      action_history: actions,
      ambient_context: ambient,
    }
  }

  // ── Event handlers ─────────────────────────────────────────────────────

  private async handleSpeechFinal(sessionId: string, data: Record<string, unknown>): Promise<void> {
    const text = data.text as string | undefined
    if (!text) return

    const history =
      (await this.contextStore.get<ConversationTurn[]>(sessionId, 'conversation_history')) ?? []

    history.push({ role: 'user', content: text, timestamp: Date.now() })

    // Trim to max turns
    while (history.length > this.maxTurns) {
      history.shift()
    }

    await this.contextStore.set(sessionId, 'conversation_history', history)

    // Detect product references (simple heuristic)
    const productMatch = this.extractProductMention(text)
    if (productMatch) {
      await this.contextStore.set(sessionId, 'last_product_mentioned', productMatch)
    }
  }

  private async handleAmbientContext(
    sessionId: string,
    data: Record<string, unknown>,
  ): Promise<void> {
    const existing =
      (await this.contextStore.get<Record<string, unknown>>(sessionId, 'ambient_context')) ?? {}

    // Merge new ambient data
    const { session_id: _sid, event: _evt, ...ambient } = data
    const merged = { ...existing, ...ambient, updated_at: Date.now() }

    await this.contextStore.set(sessionId, 'ambient_context', merged)
  }

  private async handleActionCompleted(
    sessionId: string,
    data: Record<string, unknown>,
  ): Promise<void> {
    const actions =
      (await this.contextStore.get<ConversationContext['action_history']>(
        sessionId,
        'action_history',
      )) ?? []

    actions.push({
      intent_id: (data.intent_id as string) ?? 'unknown',
      result: data.result,
      timestamp: Date.now(),
    })

    // Trim to max actions
    while (actions.length > this.maxActions) {
      actions.shift()
    }

    await this.contextStore.set(sessionId, 'action_history', actions)

    // Also add assistant turn if there's text in the result
    const resultText =
      typeof data.result === 'string'
        ? data.result
        : ((data.result as Record<string, unknown>)?.text as string | undefined)

    if (resultText) {
      const history =
        (await this.contextStore.get<ConversationTurn[]>(sessionId, 'conversation_history')) ?? []

      history.push({ role: 'assistant', content: resultText, timestamp: Date.now() })

      while (history.length > this.maxTurns) {
        history.shift()
      }

      await this.contextStore.set(sessionId, 'conversation_history', history)
    }
  }

  private async handleDraftCreated(
    sessionId: string,
    data: Record<string, unknown>,
  ): Promise<void> {
    await this.contextStore.set(sessionId, 'pending_draft', {
      draft_id: data.draft_id as string,
      intent_id: data.intent_id as string,
      items: (data.summary as Record<string, unknown>) ?? {},
    })
  }

  private async handleDraftConfirmed(sessionId: string): Promise<void> {
    await this.contextStore.set(sessionId, 'pending_draft', null)
  }

  private async handleDraftCancelled(sessionId: string): Promise<void> {
    await this.contextStore.set(sessionId, 'pending_draft', null)
  }

  // ── Helpers ────────────────────────────────────────────────────────────

  /**
   * Simple heuristic for extracting product mentions.
   * Override for domain-specific product detection.
   */
  protected extractProductMention(text: string): string | null {
    // Match common patterns: "tenis Nike", "camisa azul", "iPhone 15"
    const patterns = [
      /(?:busco|quiero|necesito|muéstrame|tiene[ns]?)\s+(.+?)(?:\s*[?.,!]|$)/i,
      /(?:el|la|los|las|un|una)\s+(\w+\s+\w+)/i,
    ]

    for (const pattern of patterns) {
      const match = text.match(pattern)
      if (match?.[1] && match[1].length > 2 && match[1].length < 50) {
        return match[1].trim()
      }
    }

    return null
  }
}
