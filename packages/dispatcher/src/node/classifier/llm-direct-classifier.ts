import type {
  IEmbeddingClassifier,
  ClassifyResult,
  IIntentLibrary,
  IntentMeta,
} from '../../types/index.js'
import { CONFIDENCE_THRESHOLD } from '../../types/index.js'
import type { LLMProvider } from '../../llm/types.js'

interface LLMClassifyResponse {
  intent_id: string
  confidence: number
  reason?: string
}

/**
 * LLMDirectClassifier — classifies user utterances by asking an LLM directly.
 *
 * Drop-in replacement for `InMemoryEmbeddingClassifier`. Instead of computing
 * embedding similarity, it sends the text and all known intents to the LLM
 * and asks it to pick the best match.
 *
 * **When to use:**
 * - Prototyping — no need to pre-compute embeddings
 * - Low volume — API call per classification is acceptable
 * - Complex intents — the LLM handles edge cases and ambiguous phrasing
 * - Multilingual — works out of the box with any language
 *
 * **When NOT to use:**
 * - High volume (> 100 req/s) — embedding-based classifier is faster and cheaper
 * - Strict latency requirements (< 50ms) — LLM adds 200–500ms per call
 *
 * @example
 * ```typescript
 * import { LLMDirectClassifier, ClaudeLLMProvider } from 'fitalyagents/dispatcher'
 *
 * const classifier = new LLMDirectClassifier({
 *   llm: new ClaudeLLMProvider(),
 *   intentLibrary,
 * })
 *
 * await classifier.init()
 * const result = await classifier.classify("I want to buy Nike shoes")
 * // → { type: 'confident', intent_id: 'product_search', confidence: 0.95, ... }
 * ```
 */
export class LLMDirectClassifier implements IEmbeddingClassifier {
  private readonly llm: LLMProvider
  private readonly intentLibrary: IIntentLibrary
  private intentMetas: Map<string, IntentMeta> = new Map()

  constructor(options: { llm: LLMProvider; intentLibrary: IIntentLibrary }) {
    this.llm = options.llm
    this.intentLibrary = options.intentLibrary
  }

  /**
   * Load all intent metadata from the library.
   * No embeddings are computed — just loads intent IDs and metadata.
   */
  async init(): Promise<void> {
    await this.loadIntentMetas()
  }

  /**
   * Classify a text utterance using the LLM.
   *
   * Builds a prompt listing all known intents with their metadata,
   * then asks the LLM to identify the best matching intent and confidence.
   */
  async classify(text: string): Promise<ClassifyResult> {
    if (this.intentMetas.size === 0) {
      return {
        type: 'fallback',
        confidence: 0,
        top_candidates: [],
      }
    }

    const intentsDesc = this.buildIntentsList()
    const result = await this.askLLM(text, intentsDesc)

    if (!result || result.confidence < CONFIDENCE_THRESHOLD) {
      return {
        type: 'fallback',
        confidence: result?.confidence ?? 0,
        top_candidates: result ? [{ intent_id: result.intent_id, score: result.confidence }] : [],
      }
    }

    const meta = this.intentMetas.get(result.intent_id)
    if (!meta) {
      return {
        type: 'fallback',
        confidence: result.confidence,
        top_candidates: [{ intent_id: result.intent_id, score: result.confidence }],
      }
    }

    return {
      type: 'confident',
      intent_id: result.intent_id,
      confidence: result.confidence,
      domain_required: meta.domain_required,
      scope_hint: meta.scope_hint,
      capabilities_required: meta.capabilities_required,
      candidates: [{ intent_id: result.intent_id, score: result.confidence }],
    }
  }

  /**
   * Reload a single intent's metadata from the library.
   * Called when `bus:INTENT_UPDATED` fires.
   */
  async reloadIntent(intentId: string): Promise<void> {
    const meta = await this.intentLibrary.getMeta(intentId)
    if (meta) {
      this.intentMetas.set(intentId, meta)
    }
  }

  dispose(): void {
    this.intentMetas.clear()
  }

  // ── Private ──────────────────────────────────────────────────────────────

  private async loadIntentMetas(): Promise<void> {
    const intentIds = await this.intentLibrary.listIntentIds()
    for (const id of intentIds) {
      const meta = await this.intentLibrary.getMeta(id)
      if (meta) {
        this.intentMetas.set(id, meta)
      }
    }
  }

  private buildIntentsList(): string {
    const lines: string[] = []
    for (const [id, meta] of this.intentMetas) {
      lines.push(
        `- ${id}: domain=${meta.domain_required}, scope=${meta.scope_hint}, capabilities=${meta.capabilities_required.join(',')}`,
      )
    }
    return lines.join('\n')
  }

  private async askLLM(text: string, intentsDesc: string): Promise<LLMClassifyResponse | null> {
    const system = [
      'You are an intent classifier for a conversational AI system.',
      'Given a user utterance and a list of available intents, identify the best matching intent.',
      'Output ONLY valid JSON — no prose, no markdown, no explanation.',
      'If the utterance does not match any intent well, return confidence below 0.60.',
    ].join('\n')

    const user = [
      `User utterance: "${text}"`,
      '',
      'Available intents:',
      intentsDesc,
      '',
      'Return JSON in this exact format:',
      JSON.stringify({
        intent_id: 'the_matching_intent_id',
        confidence: 0.92,
        reason: 'brief explanation (optional)',
      }),
    ].join('\n')

    const raw = await this.llm.complete(system, user)
    return this.parseResponse(raw)
  }

  private parseResponse(raw: string): LLMClassifyResponse | null {
    const cleaned = raw
      .replace(/^```(?:json)?\n?/m, '')
      .replace(/\n?```$/m, '')
      .trim()

    try {
      const parsed = JSON.parse(cleaned) as {
        intent_id?: string
        confidence?: number
        reason?: string
      }

      if (typeof parsed.intent_id !== 'string' || typeof parsed.confidence !== 'number') {
        return null
      }

      return {
        intent_id: parsed.intent_id,
        confidence: Math.min(1, Math.max(0, parsed.confidence)),
        reason: parsed.reason,
      }
    } catch {
      return null
    }
  }
}
