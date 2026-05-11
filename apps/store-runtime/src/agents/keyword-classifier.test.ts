import { describe, it, expect } from 'vitest'
import { RetailKeywordClassifier, RETAIL_KEYWORD_INTENT } from './keyword-classifier.js'

describe('RetailKeywordClassifier', () => {
  const classifier = new RetailKeywordClassifier()

  it('matches checkout intent', async () => {
    for (const text of ['quiero pagar', 'cobrar', 'con tarjeta', 'pago en efectivo', 'datafono']) {
      const result = await classifier.classify(text)
      expect(result.type).toBe('confident')
      if (result.type === 'confident') {
        expect(result.intent_id).toBe(RETAIL_KEYWORD_INTENT.CHECKOUT)
        expect(result.confidence).toBeGreaterThanOrEqual(0.92)
      }
    }
  })

  it('matches cancel intent', async () => {
    for (const text of ['cancelar', 'cancela eso', 'olvida', 'no importa']) {
      const result = await classifier.classify(text)
      expect(result.type).toBe('confident')
      if (result.type === 'confident') {
        expect(result.intent_id).toBe(RETAIL_KEYWORD_INTENT.CANCEL)
      }
    }
  })

  it('matches correction intent', async () => {
    for (const text of ['mejor el otro', 'no ese', 'prefiero el otro']) {
      const result = await classifier.classify(text)
      expect(result.type).toBe('confident')
      if (result.type === 'confident') {
        expect(result.intent_id).toBe(RETAIL_KEYWORD_INTENT.CORRECTION)
      }
    }
  })

  it('matches farewell intent', async () => {
    for (const text of ['gracias', 'hasta luego', 'eso es todo', 'chao']) {
      const result = await classifier.classify(text)
      expect(result.type).toBe('confident')
      if (result.type === 'confident') {
        expect(result.intent_id).toBe(RETAIL_KEYWORD_INTENT.FAREWELL)
      }
    }
  })

  it('matches fresh browse intent', async () => {
    for (const text of ['quiero ver zapatos', 'buscar tenis nike', 'mostrar zapatillas']) {
      const result = await classifier.classify(text)
      expect(result.type).toBe('confident')
      if (result.type === 'confident') {
        expect(result.intent_id).toBe(RETAIL_KEYWORD_INTENT.FRESH_BROWSE)
      }
    }
  })

  it('returns fallback for unrecognized text', async () => {
    for (const text of ['hola', 'qué tal', 'cuánto cuesta', 'tienen talla 42']) {
      const result = await classifier.classify(text)
      expect(result.type).toBe('fallback')
    }
  })

  it('handles accented text correctly', async () => {
    const result = await classifier.classify('pagar con débito')
    expect(result.type).toBe('confident')
    if (result.type === 'confident') {
      expect(result.intent_id).toBe(RETAIL_KEYWORD_INTENT.CHECKOUT)
    }
  })

  it('init and dispose are no-ops', async () => {
    await expect(classifier.init()).resolves.toBeUndefined()
    expect(() => classifier.dispose()).not.toThrow()
  })
})
