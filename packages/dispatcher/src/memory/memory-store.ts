import type { IMemoryStore, MemoryEntry, MemoryHit, MemoryQueryOptions } from './types.js'
import type { AaakDialectLike } from './aaak-dialect.js'

export interface MemoryEmbedder {
  embed(text: string): Float32Array | Promise<Float32Array>
}

export interface InMemoryMemoryStoreOptions {
  dimensions?: number
  embedder?: MemoryEmbedder | ((text: string) => Float32Array | Promise<Float32Array>)
  dialect?: AaakDialectLike
  textTransform?: (text: string) => string
}

interface StoredMemory extends MemoryEntry {
  embedding: Float32Array
}

const DEFAULT_DIMENSIONS = 256

/**
 * Lightweight semantic memory store backed by an in-process vector index.
 *
 * The default embedder uses hashed token vectors so the store works out of the
 * box in tests and local development, while still allowing a real embedder to
 * be injected for production use.
 */
export class InMemoryMemoryStore implements IMemoryStore {
  private readonly dimensions: number
  private readonly dialect: AaakDialectLike | null
  private readonly textTransform: ((text: string) => string) | null
  private readonly embed: (text: string) => Promise<Float32Array>
  private readonly entries: StoredMemory[] = []

  constructor(options: InMemoryMemoryStoreOptions = {}) {
    this.dimensions = options.dimensions ?? DEFAULT_DIMENSIONS
    this.dialect = options.dialect ?? null
    this.textTransform = options.textTransform ?? null
    this.embed = this.createEmbedder(options.embedder)
  }

  async write(entry: MemoryEntry): Promise<void> {
    const embedding = entry.embedding ?? (await this.embed(this.prepareText(entry.text)))

    this.entries.push({
      text: entry.text,
      wing: entry.wing,
      room: entry.room,
      embedding,
    })
  }

  async query(text: string, opts: MemoryQueryOptions = {}): Promise<MemoryHit[]> {
    const queryEmbedding = await this.embed(this.prepareText(text))
    const limit = opts.n ?? 3

    return this.entries
      .filter((entry) => (opts.wing ? entry.wing === opts.wing : true))
      .filter((entry) => (opts.room ? entry.room === opts.room : true))
      .map((entry) => ({
        text: entry.text,
        wing: entry.wing,
        room: entry.room,
        similarity: Math.max(0, cosineSimilarity(queryEmbedding, entry.embedding)),
      }))
      .filter((hit) => hit.similarity > 0)
      .sort((a, b) => b.similarity - a.similarity)
      .slice(0, limit)
  }

  dispose(): void {
    this.entries.length = 0
  }

  private prepareText(text: string): string {
    const normalized = this.textTransform ? this.textTransform(text) : text
    return this.dialect ? this.dialect.compress(normalized) : normalized
  }

  private createEmbedder(
    embedder?: MemoryEmbedder | ((text: string) => Float32Array | Promise<Float32Array>),
  ): (text: string) => Promise<Float32Array> {
    if (!embedder) {
      return async (text) => createHashedEmbedding(text, this.dimensions)
    }

    if (typeof embedder === 'function') {
      return async (text) => ensureFloat32Array(await embedder(text))
    }

    return async (text) => ensureFloat32Array(await embedder.embed(text))
  }
}

function createHashedEmbedding(text: string, dimensions: number): Float32Array {
  const vector = new Float32Array(dimensions)
  const tokens = tokenize(text)

  for (const token of tokens) {
    const primary = hashToken(token, dimensions)
    vector[primary] += 1

    // Spread longer tokens to a second bucket to reduce collisions a bit.
    if (token.length > 4) {
      const secondary = hashToken(`${token}:${token.length}`, dimensions)
      vector[secondary] += 0.5
    }
  }

  return normalizeVector(vector)
}

function tokenize(text: string): string[] {
  return text
    .toLowerCase()
    .normalize('NFKD')
    .replace(/[^\p{L}\p{N}\s]/gu, ' ')
    .split(/\s+/)
    .filter((token) => token.length > 1)
}

function hashToken(token: string, dimensions: number): number {
  let hash = 2166136261

  for (let i = 0; i < token.length; i++) {
    hash ^= token.charCodeAt(i)
    hash = Math.imul(hash, 16777619)
  }

  return (hash >>> 0) % dimensions
}

function normalizeVector(vector: Float32Array): Float32Array {
  let magnitudeSquared = 0

  for (let i = 0; i < vector.length; i++) {
    magnitudeSquared += vector[i]! * vector[i]!
  }

  if (magnitudeSquared === 0) return vector

  const magnitude = Math.sqrt(magnitudeSquared)
  for (let i = 0; i < vector.length; i++) {
    vector[i] = vector[i]! / magnitude
  }

  return vector
}

function cosineSimilarity(a: Float32Array, b: Float32Array): number {
  if (a.length !== b.length) return 0

  let dot = 0
  let magA = 0
  let magB = 0

  for (let i = 0; i < a.length; i++) {
    dot += a[i]! * b[i]!
    magA += a[i]! * a[i]!
    magB += b[i]! * b[i]!
  }

  if (magA === 0 || magB === 0) return 0

  return dot / (Math.sqrt(magA) * Math.sqrt(magB))
}

function ensureFloat32Array(value: Float32Array): Float32Array {
  if (value instanceof Float32Array) return value
  return new Float32Array(value)
}
