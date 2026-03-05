/**
 * KeywordDispatcher — simulates a trained embedding-based intent classifier.
 *
 * WHY NOT a small generative LLM (Gemma 270M / Qwen 0.5B)?
 * ──────────────────────────────────────────────────────────
 * Generative LLMs need to emit tokens autoregressively (even tiny ones).
 * Even at 100ms TTFT they add latency to the critical path AND they
 * can hallucinate tool parameters.
 *
 * An embedding classifier (e.g. all-MiniLM-L6-v2, 22M params):
 *   • Runs in 1–5ms on CPU (single forward pass, no generation loop)
 *   • Is deterministic — same query always maps to the same intent
 *   • Can be fine-tuned cheaply on your own tool schema
 *   • In Rust + candle it reaches <1ms (see Fase 5 of the roadmap)
 *
 * This class uses keyword matching to *simulate* what that classifier does.
 * Replace `classify()` body with a real onnxruntime / candle call in production.
 */

export type Intent = 'product_search' | 'product_detail' | 'none'

export interface DispatchResult {
  intent: Intent
  params: Record<string, string>
  confidence: number // 0–1
  latencyMs: number
}

const SEARCH_KEYWORDS = [
  // English
  'have',
  'got',
  'show',
  'find',
  'search',
  'looking',
  'need',
  'shoes',
  'shirt',
  'jeans',
  'clothing',
  'clothes',
  'product',
  'nike',
  'adidas',
  'puma',
  'denim',
  'catalog',
  'stock',
  'sneakers',
  'footwear',
  'wear',
  'carry',
  // Spanish
  'tienes',
  'tienen',
  'busco',
  'buscar',
  'muestrame',
  'muéstrame',
  'zapatos',
  'zapatillas',
  'tenis',
  'ropa',
  'playera',
  'jeans',
  'disponible',
  'stock',
  'oferta',
  'marca',
  'marcas',
]

function extractSearchTerms(query: string): string {
  return (
    query
      .replace(
        /\b(do you have|have you got|show me|find me|looking for|can you find|what do you|are there any)\b/gi,
        '',
      )
      .replace(
        /\b(tienes|tienen|busco|me puedes mostrar|muéstrame|muestrame|hay algo en|qué tienen de)\b/gi,
        '',
      )
      .replace(/\b(please|thanks|the|a|an|any|some|por favor|gracias)\b/gi, '')
      .trim()
      .replace(/\s+/g, ' ') || query.trim()
  )
}

export class KeywordDispatcher {
  private latencyMs: number

  constructor(simulatedLatencyMs = 10) {
    this.latencyMs = simulatedLatencyMs
  }

  async classify(query: string): Promise<DispatchResult> {
    const t0 = performance.now()
    // Simulates the inference time of an embedding model forward pass.
    await new Promise((r) => setTimeout(r, this.latencyMs))

    const q = query.toLowerCase()

    // product_detail: explicit product ID (e.g. "P001", "P004")
    const idMatch = q.match(/\b(p\d{3})\b/i)
    if (idMatch) {
      return {
        intent: 'product_detail',
        params: { product_id: idMatch[1].toUpperCase() },
        confidence: 0.95,
        latencyMs: Math.round(performance.now() - t0),
      }
    }

    // product_search: recognizable catalog-lookup language
    const hasSearch = SEARCH_KEYWORDS.some((k) => q.includes(k))
    if (hasSearch) {
      return {
        intent: 'product_search',
        params: { query: extractSearchTerms(query) },
        confidence: 0.82,
        latencyMs: Math.round(performance.now() - t0),
      }
    }

    return {
      intent: 'none',
      params: {},
      confidence: 1.0,
      latencyMs: Math.round(performance.now() - t0),
    }
  }
}
