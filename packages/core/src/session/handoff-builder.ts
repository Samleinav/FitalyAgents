import type { IContextStore } from '../context/types.js'
import type { IDraftStore } from '../safety/draft-store.js'
import type {
  SessionHandoff,
  SessionHandoffConversationTurn,
  SessionHandoffMemoryHit,
} from '../types/index.js'

export interface HandoffMemoryQueryOptions {
  wing?: string
  room?: string
  n?: number
}

export interface HandoffMemoryStore {
  query(text: string, opts?: HandoffMemoryQueryOptions): Promise<SessionHandoffMemoryHit[]>
}

export interface HandoffBuilderDeps {
  contextStore: IContextStore
  draftStore?: Pick<IDraftStore, 'getBySession'>
  memoryStore?: HandoffMemoryStore
  maxConversationTurns?: number
  maxMemoryHits?: number
}

const DEFAULT_MAX_CONVERSATION_TURNS = 10
const DEFAULT_MAX_MEMORY_HITS = 3

export class HandoffBuilder {
  private readonly contextStore: IContextStore
  private readonly draftStore: Pick<IDraftStore, 'getBySession'> | undefined
  private readonly memoryStore: HandoffMemoryStore | undefined
  private readonly maxConversationTurns: number
  private readonly maxMemoryHits: number

  constructor(deps: HandoffBuilderDeps) {
    this.contextStore = deps.contextStore
    this.draftStore = deps.draftStore
    this.memoryStore = deps.memoryStore
    this.maxConversationTurns = Math.max(
      1,
      deps.maxConversationTurns ?? DEFAULT_MAX_CONVERSATION_TURNS,
    )
    this.maxMemoryHits = Math.max(1, deps.maxMemoryHits ?? DEFAULT_MAX_MEMORY_HITS)
  }

  async build(
    session_id: string,
    to_human_id: string | null | undefined,
    to_role: string,
    from_agent_id: string,
    pendingDraft?: unknown,
  ): Promise<SessionHandoff> {
    const contextSnapshot = await this.contextStore.getSnapshot(session_id, ['*'])
    const ambient = await this.contextStore.getAmbient(session_id)
    const conversationSummary = this.buildConversationSummary(contextSnapshot, ambient)
    const resolvedDraft = pendingDraft ?? (await this.resolvePendingDraft(session_id))
    const memoryContext = await this.queryMemory(session_id, contextSnapshot, conversationSummary)

    const handoff: SessionHandoff = {
      event: 'SESSION_HANDOFF',
      session_id,
      from_agent_id,
      to_human_id,
      to_role,
      context_snapshot: contextSnapshot,
      conversation_summary: conversationSummary,
      timestamp: Date.now(),
    }

    if (resolvedDraft !== undefined && resolvedDraft !== null) {
      handoff.pending_draft = resolvedDraft
    }

    if (memoryContext && memoryContext.length > 0) {
      handoff.memory_context = memoryContext
    }

    return handoff
  }

  private buildConversationSummary(
    contextSnapshot: Record<string, unknown>,
    ambient: Awaited<ReturnType<IContextStore['getAmbient']>>,
  ): SessionHandoffConversationTurn[] {
    const turns: SessionHandoffConversationTurn[] = []
    const now = Date.now()

    const existingTurns = contextSnapshot.conversation_summary
    if (Array.isArray(existingTurns)) {
      for (const turn of existingTurns) {
        const normalized = normalizeConversationTurn(turn)
        if (normalized) turns.push(normalized)
      }
    }

    if (ambient) {
      for (const snippet of ambient.conversation_snippets) {
        turns.push({
          role: 'customer',
          text: snippet.text,
          timestamp: snippet.timestamp,
        })
      }
    }

    const lastUserText = readString(contextSnapshot.last_user_text)
    if (lastUserText) {
      turns.push({
        role: 'customer',
        text: lastUserText,
        timestamp: readNumber(contextSnapshot.last_user_timestamp) ?? now - 1,
      })
    }

    const lastResponse = readString(contextSnapshot.last_response)
    if (lastResponse) {
      turns.push({
        role: 'agent',
        text: lastResponse,
        timestamp: readNumber(contextSnapshot.last_response_timestamp) ?? now,
      })
    }

    return dedupeTurns(turns)
      .sort((a, b) => a.timestamp - b.timestamp)
      .slice(-this.maxConversationTurns)
  }

  private async resolvePendingDraft(sessionId: string): Promise<unknown | null> {
    if (!this.draftStore) return null

    try {
      return await this.draftStore.getBySession(sessionId)
    } catch {
      return null
    }
  }

  private async queryMemory(
    sessionId: string,
    contextSnapshot: Record<string, unknown>,
    conversationSummary: SessionHandoffConversationTurn[],
  ): Promise<SessionHandoffMemoryHit[] | undefined> {
    if (!this.memoryStore) return undefined

    const queryText = this.buildMemoryQueryText(contextSnapshot, conversationSummary)
    if (!queryText) return undefined

    try {
      const hits = await this.memoryStore.query(queryText, {
        room: sessionId,
        n: this.maxMemoryHits,
      })
      return hits.slice(0, this.maxMemoryHits)
    } catch {
      return undefined
    }
  }

  private buildMemoryQueryText(
    contextSnapshot: Record<string, unknown>,
    conversationSummary: SessionHandoffConversationTurn[],
  ): string {
    const parts = [
      ...conversationSummary.map((turn) => turn.text),
      readString(contextSnapshot.customer_id),
      readString(contextSnapshot.store_id),
      readString(contextSnapshot.sentiment_alert_level),
    ].filter((part): part is string => Boolean(part && part.trim().length > 0))

    return parts.join('\n').trim()
  }
}

function normalizeConversationTurn(value: unknown): SessionHandoffConversationTurn | null {
  if (!isRecord(value)) return null

  const role = value.role
  const text = value.text
  const timestamp = value.timestamp

  if (role !== 'agent' && role !== 'customer' && role !== 'staff') return null
  if (typeof text !== 'string' || text.trim().length === 0) return null
  if (typeof timestamp !== 'number' || !Number.isFinite(timestamp)) return null

  return { role, text, timestamp }
}

function dedupeTurns(turns: SessionHandoffConversationTurn[]): SessionHandoffConversationTurn[] {
  const seen = new Set<string>()
  const result: SessionHandoffConversationTurn[] = []

  for (const turn of turns) {
    const key = `${turn.role}:${turn.timestamp}:${turn.text}`
    if (seen.has(key)) continue
    seen.add(key)
    result.push(turn)
  }

  return result
}

function readString(value: unknown): string | null {
  return typeof value === 'string' && value.trim().length > 0 ? value : null
}

function readNumber(value: unknown): number | null {
  return typeof value === 'number' && Number.isFinite(value) ? value : null
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null
}
