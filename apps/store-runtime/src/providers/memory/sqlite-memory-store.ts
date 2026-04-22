import type {
  IMemoryStore,
  MemoryEntry,
  MemoryHit,
  MemoryQueryOptions,
} from '@fitalyagents/dispatcher'
import { getDb } from '../../storage/db.js'

export class SqliteMemoryStore implements IMemoryStore {
  constructor(private readonly options: { path: string; dimensions?: number }) {}

  async write(entry: MemoryEntry): Promise<void> {
    const db = getDb(this.options.path)
    const embedding = entry.embedding ?? createHashedEmbedding(entry.text, this.options.dimensions)
    const buffer = Buffer.from(embedding.buffer, embedding.byteOffset, embedding.byteLength)

    db.prepare(
      `
        INSERT INTO memory_entries (text, wing, room, embedding, created_at)
        VALUES (?, ?, ?, ?, ?)
      `,
    ).run(entry.text, entry.wing, entry.room, buffer, Date.now())
  }

  async query(text: string, opts: MemoryQueryOptions = {}): Promise<MemoryHit[]> {
    const db = getDb(this.options.path)
    const queryEmbedding = createHashedEmbedding(text, this.options.dimensions)

    const filters: string[] = []
    const values: Array<string | number> = []

    if (opts.wing) {
      filters.push('wing = ?')
      values.push(opts.wing)
    }

    if (opts.room) {
      filters.push('room = ?')
      values.push(opts.room)
    }

    const whereClause = filters.length > 0 ? `WHERE ${filters.join(' AND ')}` : ''
    const rows = db
      .prepare(
        `SELECT text, wing, room, embedding FROM memory_entries ${whereClause} ORDER BY created_at DESC`,
      )
      .all(...values) as Array<{
      text: string
      wing: string
      room: string
      embedding: Buffer
    }>

    return rows
      .map((row) => ({
        text: row.text,
        wing: row.wing,
        room: row.room,
        similarity: cosineSimilarity(queryEmbedding, bufferToFloat32Array(row.embedding)),
      }))
      .filter((row) => row.similarity > 0)
      .sort((left, right) => right.similarity - left.similarity)
      .slice(0, opts.n ?? 3)
  }

  dispose(): void {}
}

function createHashedEmbedding(text: string, dimensions = 256): Float32Array {
  const vector = new Float32Array(dimensions)
  const tokens = text
    .toLowerCase()
    .normalize('NFKD')
    .replace(/[^\p{L}\p{N}\s]/gu, ' ')
    .split(/\s+/)
    .filter((token) => token.length > 1)

  for (const token of tokens) {
    const primary = hashToken(token, dimensions)
    vector[primary] += 1

    if (token.length > 4) {
      const secondary = hashToken(`${token}:${token.length}`, dimensions)
      vector[secondary] += 0.5
    }
  }

  return normalize(vector)
}

function hashToken(token: string, dimensions: number): number {
  let hash = 2166136261

  for (let index = 0; index < token.length; index += 1) {
    hash ^= token.charCodeAt(index)
    hash = Math.imul(hash, 16777619)
  }

  return (hash >>> 0) % dimensions
}

function normalize(vector: Float32Array): Float32Array {
  let magnitudeSquared = 0
  for (let index = 0; index < vector.length; index += 1) {
    magnitudeSquared += vector[index]! * vector[index]!
  }

  if (magnitudeSquared === 0) {
    return vector
  }

  const magnitude = Math.sqrt(magnitudeSquared)
  for (let index = 0; index < vector.length; index += 1) {
    vector[index] = vector[index]! / magnitude
  }

  return vector
}

function bufferToFloat32Array(buffer: Buffer): Float32Array {
  const bytes = buffer.byteLength / Float32Array.BYTES_PER_ELEMENT
  return new Float32Array(
    buffer.buffer.slice(buffer.byteOffset, buffer.byteOffset + buffer.byteLength),
    0,
    bytes,
  )
}

function cosineSimilarity(left: Float32Array, right: Float32Array): number {
  if (left.length !== right.length) {
    return 0
  }

  let dot = 0
  let magLeft = 0
  let magRight = 0

  for (let index = 0; index < left.length; index += 1) {
    dot += left[index]! * right[index]!
    magLeft += left[index]! * left[index]!
    magRight += right[index]! * right[index]!
  }

  if (magLeft === 0 || magRight === 0) {
    return 0
  }

  return dot / (Math.sqrt(magLeft) * Math.sqrt(magRight))
}
