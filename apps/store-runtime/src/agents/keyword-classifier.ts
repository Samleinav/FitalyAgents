import type { IEmbeddingClassifier, ClassifyResult } from '@fitalyagents/dispatcher'

/**
 * Intent IDs produced by the keyword classifier.
 * These are stable string keys used by NodeDispatcher to emit bus:SPEECH_PROBABLE.
 */
export const RETAIL_KEYWORD_INTENT = {
  CHECKOUT: 'retail.checkout',
  CANCEL: 'retail.cancel',
  FRESH_BROWSE: 'retail.fresh_browse',
  CORRECTION: 'retail.correction',
  FAREWELL: 'retail.farewell',
} as const

/**
 * Keyword-based classifier that wraps the retail intent regexes.
 * Interim implementation of IEmbeddingClassifier — no model, no network calls.
 * Replace with an embedding-based classifier once a model is available.
 *
 * Confidence is fixed at 0.95 on match (above SPEECH_PROBABLE_CONFIDENCE_MIN = 0.92)
 * with a margin of 1.0 (single candidate), so NodeDispatcher will emit SPEECH_PROBABLE
 * for any matched partial.
 */
export class RetailKeywordClassifier implements IEmbeddingClassifier {
  async init(): Promise<void> {}

  async classify(text: string): Promise<ClassifyResult> {
    const normalized = normalizeText(text)
    const match = detectIntent(normalized)

    if (match) {
      return {
        type: 'confident',
        intent_id: match,
        confidence: 0.95,
        domain_required: 'retail',
        scope_hint: 'store',
        capabilities_required: [],
        candidates: [{ intent_id: match, score: 0.95 }],
      }
    }

    return {
      type: 'fallback',
      confidence: 0.1,
      top_candidates: [],
    }
  }

  async reloadIntent(_intentId: string): Promise<void> {}

  dispose(): void {}
}

// ── Intent detection ──────────────────────────────────────────────────────────

function detectIntent(normalized: string): string | null {
  if (isCheckout(normalized)) return RETAIL_KEYWORD_INTENT.CHECKOUT
  if (isCancel(normalized)) return RETAIL_KEYWORD_INTENT.CANCEL
  if (isCorrection(normalized)) return RETAIL_KEYWORD_INTENT.CORRECTION
  if (isFarewell(normalized)) return RETAIL_KEYWORD_INTENT.FAREWELL
  if (isFreshBrowse(normalized)) return RETAIL_KEYWORD_INTENT.FRESH_BROWSE
  return null
}

function isCheckout(n: string): boolean {
  return /\b(pagar|pago|pagamos|cobrar|cobro|checkout|finalizar|cerrar|datafono|tarjeta|efectivo|cash)\b/.test(
    n,
  )
}

function isCancel(n: string): boolean {
  return /^(cancela|cancelar|cancelo|anula|anular|olvida|olvida eso|dejalo|no importa|no gracias olvida)\b/.test(
    n,
  )
}

function isCorrection(n: string): boolean {
  return /\b(mejor el otro|cambia al|prefiero el otro|no ese|no esa|quiero el otro|ese no)\b/.test(
    n,
  )
}

function isFarewell(n: string): boolean {
  return (
    /^(gracias|muchas gracias|listo gracias|eso es todo|hasta luego|adios|chao|bye)\b/.test(n) ||
    /\b(nada mas|eso es todo)\b/.test(n)
  )
}

function isFreshBrowse(n: string): boolean {
  if (/(agrega|agregar|anade|anadir|comprar|compra|pedido|orden|carrito|confirm)/.test(n)) {
    return false
  }
  return (
    /^(quiero ver|me puedes mostrar|puedes mostrar|muestrame|mostrar|busco|buscar|ver)\b/.test(n) &&
    /(producto|productos|catalogo|tenis|zapato|zapatos|zapatilla|zapatillas|nike|adidas|puma|talla)/.test(
      n,
    )
  )
}

function normalizeText(text: string): string {
  return text
    .normalize('NFD')
    .replace(/[̀-ͯ]/g, '')
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, ' ')
    .trim()
}
