export interface MemoryScope {
  wing: string
  room: string
}

export interface MemoryScopeResolveInput {
  session_id: string
  text: string
  timestamp: number
  locale?: string
  speaker_id?: string
  role?: string | null
  actor_type?: string | null
  store_id?: string
  group_id?: string
}

export type MemoryScopeResolver = (
  input: MemoryScopeResolveInput,
) => MemoryScope | null | Promise<MemoryScope | null>

export function createDefaultMemoryScope(sessionId: string): MemoryScope {
  return {
    wing: 'session',
    room: sessionId,
  }
}
