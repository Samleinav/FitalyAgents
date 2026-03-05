/**
 * EmbeddingDispatcher — intent classification using all-MiniLM-L6-v2.
 *
 * Improvements over naive centroid approach:
 *   A. Margin-based confidence: `best - second_best` instead of raw cosine score.
 *      A margin < MARGIN_THRESHOLD means "ambiguous — don't dispatch".
 *   B. Top-k voting: keeps all example vectors individually. Finds the k nearest
 *      across all intents and does majority vote. More robust than a single centroid
 *      that collapses diverse phrasings into one average vector.
 *   F. LRU cache: normalised query string → DispatchResult. Free win for repeated
 *      queries within a session.
 */

import { readFileSync, writeFileSync, mkdirSync } from 'fs'
import { dirname } from 'path'
import type { DispatchResult, Intent } from './dispatcher.js'
import { extractParams } from './param-extractor.js'

// ─── Tuning ──────────────────────────────────────────────────────────────────

/** Minimum margin (best_score - second_best_score) to consider a dispatch hit. */
const MARGIN_THRESHOLD = 0.08

/** Number of nearest-neighbor votes used for intent selection. */
const TOP_K = 5

/** LRU cache capacity (normalised query strings). */
const CACHE_SIZE = 128

// ─── Intent training examples ────────────────────────────────────────────────
// Aim for 8–20 diverse phrasings per intent.
// Diversity matters more than quantity — don't duplicate paraphrases.

const INTENT_EXAMPLES: Record<Intent, string[]> = {
  product_search: [
    // English — catalog browse
    'show me shoes',
    'do you have Nike products',
    'what clothes do you carry',
    "I'm looking for sneakers",
    'find me running shoes',
    'show me your catalog',
    'what do you have in stock',
    'any Adidas products available',
    'search for jeans',
    'do you sell t-shirts',
    'what brands do you have',
    'I need something in blue',
    'got any casual shoes',
    'show me everything under fifty dollars',
    'what footwear do you have',
    'looking for athletic wear',
    'do you carry Puma',
    'any denim options',
    // Spanish — retail speech patterns
    'tienes zapatos Nike',
    'qué tienen en stock',
    'me puedes mostrar las zapatillas',
    'busco ropa deportiva',
    'tienen jeans de hombre',
    'qué marcas manejan',
    'hay algo en azul',
    'tienen tenis para correr',
    'muéstrame lo que tienen de Adidas',
    'busco algo casual',
    'tienen playeras',
    'qué ropa tienen disponible',
    'hay zapatillas para mujer',
    'tienen algo en oferta',
  ],
  product_detail: [
    // English — explicit product lookup
    'tell me about P001',
    'get details for P002',
    'what is product P003',
    'show me P004',
    'information about product P005',
    'describe item P001',
    'what are the specs of P002',
    'how much does P003 cost',
    'what does P004 look like',
    'give me the details on P001',
    'price and stock for P002',
    'tell me more about that product P003',
    'what colors does P001 come in',
    // Spanish — product detail
    'cuánto cuesta el P001',
    'dame información del P002',
    'qué es el producto P003',
    'detalles del P004 por favor',
    'cómo es el P001',
    'en qué colores viene el P002',
    'hay stock del P003',
    'dime más sobre el P001',
    'precio del producto P002',
  ],
  none: [
    // English — service opening / greetings
    'hello',
    'hi there',
    'hey',
    'good morning',
    'good afternoon',
    'excuse me',
    'hello can you help me',
    // English — small talk / policy
    'thank you',
    'thanks a lot',
    'goodbye',
    'see you later',
    'what can you do',
    'how does this work',
    'how much does shipping cost',
    'what are your store hours',
    'can I return an item',
    'what is your return policy',
    'do you offer discounts',
    'is there a loyalty program',
    // Spanish — service opening / greetings
    'hola',
    'buenos días',
    'buenas tardes',
    'buenas noches',
    'disculpe',
    'perdón',
    'hola me puedes ayudar',
    'necesito ayuda',
    // Spanish — small talk / policy
    'gracias',
    'muchas gracias',
    'hasta luego',
    'adiós',
    'cómo funciona esto',
    'cuánto cuesta el envío',
    'cuál es el horario',
    'puedo devolver algo',
    'tienen descuentos',
    'hay programa de puntos',
  ],
}

// ─── Minimal LRU cache ───────────────────────────────────────────────────────

class LRUCache<K, V> {
  private map = new Map<K, V>()
  constructor(private maxSize: number) {}

  get(key: K): V | undefined {
    const val = this.map.get(key)
    if (val !== undefined) {
      // Move to end (most recently used)
      this.map.delete(key)
      this.map.set(key, val)
    }
    return val
  }

  set(key: K, val: V): void {
    if (this.map.has(key)) this.map.delete(key)
    else if (this.map.size >= this.maxSize) {
      // Evict least recently used (first entry)
      this.map.delete(this.map.keys().next().value!)
    }
    this.map.set(key, val)
  }

  clear(): void {
    this.map.clear()
  }
}

function normaliseQuery(q: string): string {
  return q
    .toLowerCase()
    .replace(/[^a-z0-9 ]/g, '')
    .replace(/\s+/g, ' ')
    .trim()
}

// ─── Math helpers ─────────────────────────────────────────────────────────────

function cosineSimilarity(a: number[], b: number[]): number {
  let dot = 0,
    normA = 0,
    normB = 0
  for (let i = 0; i < a.length; i++) {
    dot += a[i] * b[i]
    normA += a[i] * a[i]
    normB += b[i] * b[i]
  }
  return normA === 0 || normB === 0 ? 0 : dot / (Math.sqrt(normA) * Math.sqrt(normB))
}

// ─── EmbeddingDispatcher ─────────────────────────────────────────────────────

interface ExampleVec {
  intent: Intent
  vec: number[]
}

export class EmbeddingDispatcher {
  private extractor: any = null
  /** All individual example vectors — NOT collapsed into centroids. */
  private examples: ExampleVec[] = []
  private _initPromise: Promise<void> | null = null
  private cache = new LRUCache<string, DispatchResult>(CACHE_SIZE)

  /** Texts added by teacher — tracked separately for persistence. */
  private teacherAdded: Map<Intent, string[]> = new Map()
  private teacherPath: string | null = null

  constructor(teacherExamplesPath?: string) {
    this.teacherPath = teacherExamplesPath ?? null
  }

  async init(): Promise<void> {
    if (this.extractor) return
    if (this._initPromise) return this._initPromise
    this._initPromise = this._doInit()
    return this._initPromise
  }

  private async _doInit(): Promise<void> {
    const { pipeline } = await import('@xenova/transformers')
    this.extractor = await pipeline('feature-extraction', 'Xenova/all-MiniLM-L6-v2')

    // Embed hardcoded baseline examples
    for (const [intent, phrases] of Object.entries(INTENT_EXAMPLES) as [Intent, string[]][]) {
      const vecs = await Promise.all(phrases.map((p) => this._embed(p)))
      for (const vec of vecs) this.examples.push({ intent, vec })
    }

    // Load and embed teacher-added examples from previous sessions
    if (this.teacherPath) {
      try {
        const raw = readFileSync(this.teacherPath, 'utf-8')
        const stored: Record<string, string[]> = JSON.parse(raw)
        for (const [intent, phrases] of Object.entries(stored) as [Intent, string[]][]) {
          this.teacherAdded.set(intent, phrases)
          const vecs = await Promise.all(phrases.map((p) => this._embed(p)))
          for (const vec of vecs) this.examples.push({ intent, vec })
        }
      } catch {
        /* first run — no teacher file yet */
      }
    }
  }

  /**
   * Add a new example at runtime (teacher-suggested).
   * Immediately embeds the text and inserts it into the live vector store.
   * Invalidates cache entries for similar queries.
   */
  async addExample(intent: Intent, text: string): Promise<void> {
    if (!this.extractor) await this.init()
    const vec = await this._embed(text)
    this.examples.push({ intent, vec })

    const stored = this.teacherAdded.get(intent) ?? []
    stored.push(text)
    this.teacherAdded.set(intent, stored)
    this.cache.clear() // invalidate — distribution has changed

    if (this.teacherPath) this._saveTeacher()
  }

  /** Sample texts from a given intent — used by teacher for dedup context. */
  getExampleTexts(intent: Intent, maxN = 6): string[] {
    const baseline = (INTENT_EXAMPLES[intent] ?? []).slice(0, maxN - 2)
    const teacher = (this.teacherAdded.get(intent) ?? []).slice(-2) // last 2 teacher additions
    return [...baseline, ...teacher].slice(0, maxN)
  }

  /** How many teacher-added examples exist for each intent. */
  getTeacherStats(): Record<string, number> {
    const stats: Record<string, number> = {}
    for (const [intent, arr] of this.teacherAdded) stats[intent] = arr.length
    return stats
  }

  private _saveTeacher(): void {
    if (!this.teacherPath) return
    try {
      mkdirSync(dirname(this.teacherPath), { recursive: true })
      const obj: Record<string, string[]> = {}
      for (const [k, v] of this.teacherAdded) obj[k] = v
      writeFileSync(this.teacherPath, JSON.stringify(obj, null, 2), 'utf-8')
    } catch {
      /* ignore */
    }
  }

  private async _embed(text: string): Promise<number[]> {
    const out = await this.extractor(text, { pooling: 'mean', normalize: true })
    return Array.from(out.data as Float32Array)
  }

  async classify(query: string): Promise<DispatchResult> {
    if (!this.extractor) await this.init()

    // F. Cache check
    const cacheKey = normaliseQuery(query)
    const cached = this.cache.get(cacheKey)
    if (cached) return { ...cached, latencyMs: 0 }

    const t0 = performance.now()
    const queryVec = await this._embed(query)

    // B. Score every individual example vector
    const scored = this.examples
      .map(({ intent, vec }) => ({ intent, score: cosineSimilarity(queryVec, vec) }))
      .sort((a, b) => b.score - a.score)

    // Top-k majority vote
    const topK = scored.slice(0, TOP_K)
    const votes = new Map<Intent, number>()
    for (const { intent } of topK) votes.set(intent, (votes.get(intent) ?? 0) + 1)
    const winner = [...votes.entries()].sort((a, b) => b[1] - a[1])[0][0]

    // A. Margin = top score - best score of a DIFFERENT intent
    const topScore = topK[0].score
    const bestRival = topK.find((t) => t.intent !== topK[0].intent)?.score ?? 0
    const margin = topScore - bestRival

    const result: DispatchResult = {
      intent: margin >= MARGIN_THRESHOLD ? winner : 'none',
      params: margin >= MARGIN_THRESHOLD ? extractParams(winner, query) : {},
      confidence: margin, // margin is now the confidence signal, not raw cosine
      latencyMs: Math.round(performance.now() - t0),
    }

    this.cache.set(cacheKey, result)
    return result
  }
}
