import type { IEmbeddingClassifier, ClassifyResult, IIntentLibrary } from '../../types/index.js'
import { CONFIDENCE_THRESHOLD } from '../../types/index.js'

/**
 * In-memory embedding classifier for testing.
 *
 * Uses simple keyword overlap as a similarity heuristic instead of
 * real embeddings. The real implementation (`NodeEmbeddingClassifier`)
 * would use `@xenova/transformers` with `all-MiniLM-L6-v2`.
 *
 * Scoring: Jaccard similarity between query tokens and example tokens
 * for each intent. Best score across examples = intent score.
 *
 * @example
 * ```typescript
 * const classifier = new InMemoryEmbeddingClassifier(intentLibrary)
 * await classifier.init()
 * const result = await classifier.classify('find hotels in Cancun')
 * ```
 */
export class InMemoryEmbeddingClassifier implements IEmbeddingClassifier {
  private intentLibrary: IIntentLibrary
  private intentCache: Map<
    string,
    {
      examples: string[][]
      meta: { domain_required: string; scope_hint: string; capabilities_required: string[] }
    }
  > = new Map()

  constructor(intentLibrary: IIntentLibrary) {
    this.intentLibrary = intentLibrary
  }

  async init(): Promise<void> {
    await this.loadAllIntents()
  }

  async classify(text: string): Promise<ClassifyResult> {
    const queryTokens = this.tokenize(text)
    const candidates: Array<{ intent_id: string; score: number }> = []

    for (const [intentId, entry] of this.intentCache) {
      let bestScore = 0
      for (const exampleTokens of entry.examples) {
        const score = this.jaccardSimilarity(queryTokens, exampleTokens)
        if (score > bestScore) bestScore = score
      }
      candidates.push({ intent_id: intentId, score: bestScore })
    }

    candidates.sort((a, b) => b.score - a.score)

    const best = candidates[0]
    if (best && best.score >= CONFIDENCE_THRESHOLD) {
      const entry = this.intentCache.get(best.intent_id)!
      return {
        type: 'confident',
        intent_id: best.intent_id,
        confidence: best.score,
        domain_required: entry.meta.domain_required,
        scope_hint: entry.meta.scope_hint,
        capabilities_required: entry.meta.capabilities_required,
        candidates: candidates.slice(0, 3),
      }
    }

    return {
      type: 'fallback',
      confidence: best?.score ?? 0,
      top_candidates: candidates.slice(0, 3),
    }
  }

  async reloadIntent(intentId: string): Promise<void> {
    const examples = await this.intentLibrary.getExamples(intentId)
    const meta = await this.intentLibrary.getMeta(intentId)
    if (!meta || examples.length === 0) return

    this.intentCache.set(intentId, {
      examples: examples.map((e) => this.tokenize(e)),
      meta: {
        domain_required: meta.domain_required,
        scope_hint: meta.scope_hint,
        capabilities_required: meta.capabilities_required,
      },
    })
  }

  dispose(): void {
    this.intentCache.clear()
  }

  // ── Private ───────────────────────────────────────────────────────────

  private async loadAllIntents(): Promise<void> {
    const intentIds = await this.intentLibrary.listIntentIds()
    for (const id of intentIds) {
      await this.reloadIntent(id)
    }
  }

  private tokenize(text: string): string[] {
    return text
      .toLowerCase()
      .replace(/[^a-záéíóúüñ0-9\s]/g, '')
      .split(/\s+/)
      .filter((t) => t.length > 1)
  }

  private jaccardSimilarity(a: string[], b: string[]): number {
    const setA = new Set(a)
    const setB = new Set(b)
    let intersection = 0
    for (const token of setA) {
      if (setB.has(token)) intersection++
    }
    const union = setA.size + setB.size - intersection
    return union === 0 ? 0 : intersection / union
  }
}
