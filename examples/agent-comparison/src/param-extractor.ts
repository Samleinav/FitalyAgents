/**
 * param-extractor — STT-tolerant parameter extraction.
 *
 * Separated from intent classification because the two problems are different:
 *   - Classification: semantic similarity (embedding space)
 *   - Extraction: structured value from noisy text (pattern matching + normalization)
 *
 * STT errors this handles:
 *   - Product IDs: "P cero cero uno" / "pe001" / "P-001" → "P001"
 *   - Brand names: "mike" → "Nike", "adida" → "Adidas"
 *   - Numbers as words: "cero", "zero", "oh" → "0"
 */

import type { Intent } from './dispatcher.js'

// ─── Known brand variants (STT errors + common misspellings) ─────────────────

const BRAND_VARIANTS: Record<string, string> = {
  mike: 'Nike',
  nikes: 'Nike',
  naike: 'Nike',
  adida: 'Adidas',
  adidas: 'Adidas',
  adidass: 'Adidas',
  puma: 'Puma',
  pumma: 'Puma',
}

// ─── Digit word normalization ─────────────────────────────────────────────────

const DIGIT_WORDS: Record<string, string> = {
  // English
  zero: '0',
  oh: '0',
  o: '0',
  one: '1',
  two: '2',
  three: '3',
  four: '4',
  five: '5',
  six: '6',
  seven: '7',
  eight: '8',
  nine: '9',
  // Spanish
  cero: '0',
  uno: '1',
  dos: '2',
  tres: '3',
  cuatro: '4',
  cinco: '5',
  seis: '6',
  siete: '7',
  ocho: '8',
  nueve: '9',
}

const DIGIT_WORD_PATTERN = new RegExp(`\\b(${Object.keys(DIGIT_WORDS).join('|')})\\b`, 'gi')

/**
 * Normalizes spoken product IDs to canonical form.
 * Handles: "P cero cero uno", "pe 001", "P-001", "product P zero zero one"
 */
function normalizeProductId(text: string): string | null {
  // Step 1: replace digit words with digits
  const normalized = text.replace(DIGIT_WORD_PATTERN, (m) => DIGIT_WORDS[m.toLowerCase()] ?? m)

  // Step 2: look for P + digits pattern (with optional separators)
  const match = normalized.match(/\b[Pp][\s\-_]?(\d{1,4})\b/)
  if (!match) return null

  const digits = match[1].padStart(3, '0')
  return `P${digits}`
}

/**
 * Normalizes brand names: corrects STT variants and ensures proper casing.
 */
function normalizeBrands(text: string): string {
  return text.replace(/\b\w+\b/g, (word) => BRAND_VARIANTS[word.toLowerCase()] ?? word)
}

/**
 * Strips query filler words common in retail voice queries.
 */
function stripFiller(text: string): string {
  return (
    text
      // English filler
      .replace(
        /\b(do you have|have you got|show me|find me|looking for|can you find|what do you|search for|are there any|do you carry|i need|i want|got any)\b/gi,
        '',
      )
      .replace(/\b(please|thanks|thank you|the|a|an|any|some|me)\b/gi, '')
      // Spanish filler
      .replace(
        /\b(tienes|tienen|busco|me puedes mostrar|muéstrame|muestrame|hay algo en|qué tienen de|quiero|necesito|me das|me puedes dar|tienen algo en)\b/gi,
        '',
      )
      .replace(/\b(por favor|gracias|un|una|unos|unas|algo)\b/gi, '')
      .trim()
      .replace(/\s+/g, ' ')
  )
}

// ─── Public API ───────────────────────────────────────────────────────────────

export function extractParams(intent: Intent, query: string): Record<string, string> {
  if (intent === 'product_detail') {
    const id = normalizeProductId(query)
    if (id) return { product_id: id }
    // fallback: try after digit-word replacement on full query
    return {}
  }

  if (intent === 'product_search') {
    const withNormalizedBrands = normalizeBrands(query)
    const stripped = stripFiller(withNormalizedBrands)
    return { query: stripped || query.trim() }
  }

  return {}
}
