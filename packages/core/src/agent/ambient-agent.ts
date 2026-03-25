import { StreamAgent } from './stream-agent.js'
import type { IEventBus } from '../types/index.js'
import type { IStreamingLLM } from './interaction-agent.js'
import type { IContextStore, AmbientContext } from '../context/types.js'

// ── Types ────────────────────────────────────────────────────────────────────

export interface AmbientAnalysis {
  product: string | null
  sentiment: string | null
  purchase_intent: boolean
  language: string | null
}

export interface AmbientAgentConfig {
  /** Maximum fragments to process per minute. Default: 10 */
  maxFragmentsPerMinute?: number
  /** System prompt for ambient analysis LLM. */
  systemPrompt?: string
}

export interface AmbientAgentDeps {
  bus: IEventBus
  llm: IStreamingLLM
  contextStore: IContextStore
  config?: AmbientAgentConfig
}

// ── Constants ────────────────────────────────────────────────────────────────

const DEFAULT_MAX_FRAGMENTS_PER_MINUTE = 10

const DEFAULT_SYSTEM_PROMPT =
  'Analiza este fragmento de conversación ambiental en una tienda. ' +
  'Extrae en JSON: { "product": string|null, "sentiment": string|null, "purchase_intent": boolean, "language": string|null }. ' +
  'Si no hay información relevante, retorna { "product": null, "sentiment": null, "purchase_intent": false, "language": null }. ' +
  'Retorna SOLO JSON, sin markdown.'

// ── AmbientAgent ─────────────────────────────────────────────────────────────

/**
 * AmbientAgent — analyzes ambient (overheard) speech with LLM 8B
 * and silently enriches the ContextStore.
 *
 * **No bus publishing** — only updates context silently so that
 * InteractionAgent can use enriched context on the next turn.
 *
 * Features:
 * - Subscribes to `bus:AMBIENT_CONTEXT`
 * - Sends text to LLM 8B for product/sentiment/intent extraction
 * - Stores results in `contextStore.setAmbient()`
 * - Rate limits: max N fragments per minute (default 10)
 * - Gracefully handles LLM errors and invalid JSON
 *
 * @example
 * ```typescript
 * const ambient = new AmbientAgent({
 *   bus,
 *   llm: groq8B,
 *   contextStore,
 *   config: { maxFragmentsPerMinute: 10 },
 * })
 *
 * await ambient.start()
 * // bus:AMBIENT_CONTEXT → LLM analysis → contextStore.setAmbient()
 * ```
 */
export class AmbientAgent extends StreamAgent {
  private readonly llm: IStreamingLLM
  private readonly contextStore: IContextStore
  private readonly maxFragmentsPerMinute: number
  private readonly systemPrompt: string

  /**
   * Rate-limit tracking: timestamps of processed fragments within the
   * current sliding window (1 minute).
   */
  private readonly processedTimestamps: number[] = []

  protected get channels(): string[] {
    return ['bus:AMBIENT_CONTEXT']
  }

  constructor(deps: AmbientAgentDeps) {
    super(deps.bus)
    this.llm = deps.llm
    this.contextStore = deps.contextStore
    this.maxFragmentsPerMinute =
      deps.config?.maxFragmentsPerMinute ?? DEFAULT_MAX_FRAGMENTS_PER_MINUTE
    this.systemPrompt = deps.config?.systemPrompt ?? DEFAULT_SYSTEM_PROMPT
  }

  // ── StreamAgent lifecycle ──────────────────────────────────────────────────

  async onEvent(channel: string, payload: unknown): Promise<void> {
    if (channel !== 'bus:AMBIENT_CONTEXT') return

    const data = payload as {
      session_id?: string
      speaker_id?: string
      text?: string
      timestamp?: number
    }

    const { session_id, speaker_id, text } = data
    if (!session_id || !text) return

    // ── Rate limit check ────────────────────────────────────────────────────
    if (!this.canProcess()) return

    this.recordProcessed()

    // ── LLM analysis ────────────────────────────────────────────────────────
    let analysis: AmbientAnalysis

    try {
      analysis = await this.analyzeFragment(text)
    } catch {
      // LLM error — don't crash, just skip this fragment
      return
    }

    // Only update context if we found something relevant
    if (!analysis.product) return

    // ── Update ContextStore ─────────────────────────────────────────────────
    const existing = await this.contextStore.getAmbient(session_id)

    const ambientCtx: AmbientContext = {
      last_product_mentioned: analysis.product,
      conversation_snippets: [
        ...(existing?.conversation_snippets ?? []),
        {
          speaker_id,
          text,
          timestamp: data.timestamp ?? Date.now(),
        },
      ],
      timestamp: Date.now(),
    }

    await this.contextStore.setAmbient(session_id, ambientCtx)
  }

  // ── LLM analysis ──────────────────────────────────────────────────────────

  /**
   * Send the text fragment to the LLM and parse the JSON response.
   *
   * @throws if the LLM fails to stream or returns unparseable output
   */
  private async analyzeFragment(text: string): Promise<AmbientAnalysis> {
    let rawResponse = ''

    for await (const chunk of this.llm.stream({
      system: this.systemPrompt,
      messages: [{ role: 'user', content: text }],
    })) {
      if (chunk.type === 'text') rawResponse += chunk.text
    }

    return this.parseAnalysis(rawResponse)
  }

  /**
   * Attempt to parse the LLM's JSON output. Returns a safe default
   * if the response is malformed.
   */
  private parseAnalysis(raw: string): AmbientAnalysis {
    const jsonMatch = raw.trim().match(/\{[\s\S]*\}/)
    if (!jsonMatch) {
      return { product: null, sentiment: null, purchase_intent: false, language: null }
    }

    try {
      const parsed = JSON.parse(jsonMatch[0]) as Partial<AmbientAnalysis>
      return {
        product: typeof parsed.product === 'string' ? parsed.product : null,
        sentiment: typeof parsed.sentiment === 'string' ? parsed.sentiment : null,
        purchase_intent: parsed.purchase_intent === true,
        language: typeof parsed.language === 'string' ? parsed.language : null,
      }
    } catch {
      return { product: null, sentiment: null, purchase_intent: false, language: null }
    }
  }

  // ── Rate limiting ─────────────────────────────────────────────────────────

  /**
   * Check whether we can process another fragment within the rate limit.
   * Uses a sliding 60-second window.
   */
  private canProcess(): boolean {
    const now = Date.now()
    const windowStart = now - 60_000

    // Purge old timestamps
    while (this.processedTimestamps.length > 0 && this.processedTimestamps[0] < windowStart) {
      this.processedTimestamps.shift()
    }

    return this.processedTimestamps.length < this.maxFragmentsPerMinute
  }

  private recordProcessed(): void {
    this.processedTimestamps.push(Date.now())
  }

  // ── Public getters for testing ─────────────────────────────────────────────

  /** Current number of fragments processed in the sliding window. */
  get currentWindowCount(): number {
    const now = Date.now()
    const windowStart = now - 60_000
    return this.processedTimestamps.filter((t) => t >= windowStart).length
  }
}
