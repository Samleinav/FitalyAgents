export interface MemoryHit {
  text: string
  wing: string
  room: string
  similarity: number
}

export interface MemoryEntry {
  text: string
  wing: string
  room: string
  embedding?: Float32Array
}

export interface MemoryQueryOptions {
  wing?: string
  room?: string
  n?: number
}

export interface IMemoryStore {
  write(entry: MemoryEntry): Promise<void>
  query(text: string, opts?: MemoryQueryOptions): Promise<MemoryHit[]>
  dispose?(): void
}

export type { MemoryScope, MemoryScopeResolveInput, MemoryScopeResolver } from './scope-resolver.js'
