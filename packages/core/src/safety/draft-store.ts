import type { IEventBus } from '../types/index.js'

// ── Draft types ───────────────────────────────────────────────────────────────

export type DraftStatus = 'draft' | 'confirmed' | 'cancelled'

export interface DraftHistoryEntry {
  changes: Record<string, unknown>
  timestamp: number
}

export interface Draft {
  id: string
  session_id: string
  intent_id: string
  status: DraftStatus
  items: Record<string, unknown>
  total?: number
  ttl_seconds: number
  history: DraftHistoryEntry[]
  created_at: number
  updated_at: number
}

export interface DraftInput {
  intent_id: string
  items: Record<string, unknown>
  total?: number
  ttl_seconds?: number
}

// ── IDraftStore interface ─────────────────────────────────────────────────────

export interface IDraftStore {
  create(sessionId: string, input: DraftInput): Promise<string>
  update(draftId: string, changes: Record<string, unknown>): Promise<Draft>
  confirm(draftId: string): Promise<void>
  cancel(draftId: string): Promise<void>
  rollback(draftId: string): Promise<Draft>
  get(draftId: string): Promise<Draft | null>
  getBySession(sessionId: string): Promise<Draft | null>
  dispose(): void
}

// ── InMemoryDraftStore ────────────────────────────────────────────────────────

let draftCounter = 0

/**
 * InMemoryDraftStore — manages draft lifecycle with auto-expiry via TTL.
 *
 * Drafts are mutable previews that clients can modify N times before confirming.
 * When a draft expires (TTL), it publishes `bus:DRAFT_CANCELLED`.
 *
 * @example
 * ```typescript
 * const store = new InMemoryDraftStore({ bus })
 *
 * const draftId = await store.create('session-1', {
 *   intent_id: 'order_create',
 *   items: { product: 'Nike Air', size: 42 },
 *   total: 15000,
 * })
 *
 * await store.update(draftId, { color: 'red' })
 * await store.confirm(draftId)
 * ```
 */
export class InMemoryDraftStore implements IDraftStore {
  private readonly bus: IEventBus
  private readonly drafts: Map<string, Draft> = new Map()
  private readonly sessionIndex: Map<string, string> = new Map()
  private readonly timers: Map<string, ReturnType<typeof setTimeout>> = new Map()

  constructor(deps: { bus: IEventBus }) {
    this.bus = deps.bus
  }

  async create(sessionId: string, input: DraftInput): Promise<string> {
    const id = `draft_${++draftCounter}_${Date.now()}`
    const ttl = input.ttl_seconds ?? 300

    const draft: Draft = {
      id,
      session_id: sessionId,
      intent_id: input.intent_id,
      status: 'draft',
      items: { ...input.items },
      total: input.total,
      ttl_seconds: ttl,
      history: [],
      created_at: Date.now(),
      updated_at: Date.now(),
    }

    this.drafts.set(id, draft)
    this.sessionIndex.set(sessionId, id)
    this.startTtlTimer(id, ttl)

    await this.bus.publish('bus:DRAFT_CREATED', {
      event: 'DRAFT_CREATED',
      draft_id: id,
      session_id: sessionId,
      intent_id: input.intent_id,
      summary: input.items,
      ttl,
    })

    return id
  }

  async update(draftId: string, changes: Record<string, unknown>): Promise<Draft> {
    const draft = this.drafts.get(draftId)
    if (!draft) throw new Error(`Draft not found: ${draftId}`)
    if (draft.status !== 'draft')
      throw new Error(`Draft ${draftId} is ${draft.status}, cannot update`)

    // Save current state to history
    draft.history.push({
      changes: { ...draft.items },
      timestamp: Date.now(),
    })

    // Apply changes
    Object.assign(draft.items, changes)
    if (changes.total !== undefined) {
      draft.total = changes.total as number
    }
    draft.updated_at = Date.now()

    // Renew TTL
    this.clearTimer(draftId)
    this.startTtlTimer(draftId, draft.ttl_seconds)

    return { ...draft }
  }

  async confirm(draftId: string): Promise<void> {
    const draft = this.drafts.get(draftId)
    if (!draft) throw new Error(`Draft not found: ${draftId}`)
    if (draft.status !== 'draft')
      throw new Error(`Draft ${draftId} is ${draft.status}, cannot confirm`)

    this.clearTimer(draftId)
    draft.status = 'confirmed'
    draft.updated_at = Date.now()

    // Clean session index
    this.sessionIndex.delete(draft.session_id)

    await this.bus.publish('bus:DRAFT_CONFIRMED', {
      event: 'DRAFT_CONFIRMED',
      draft_id: draftId,
      session_id: draft.session_id,
      intent_id: draft.intent_id,
      items: draft.items,
      total: draft.total,
    })
  }

  async cancel(draftId: string): Promise<void> {
    const draft = this.drafts.get(draftId)
    if (!draft) throw new Error(`Draft not found: ${draftId}`)

    this.clearTimer(draftId)
    draft.status = 'cancelled'
    draft.updated_at = Date.now()

    this.sessionIndex.delete(draft.session_id)
    this.drafts.delete(draftId)

    await this.bus.publish('bus:DRAFT_CANCELLED', {
      event: 'DRAFT_CANCELLED',
      draft_id: draftId,
      session_id: draft.session_id,
      reason: 'cancelled_by_user',
    })
  }

  async rollback(draftId: string): Promise<Draft> {
    const draft = this.drafts.get(draftId)
    if (!draft) throw new Error(`Draft not found: ${draftId}`)
    if (draft.status !== 'draft')
      throw new Error(`Draft ${draftId} is ${draft.status}, cannot rollback`)
    if (draft.history.length === 0)
      throw new Error(`Draft ${draftId} has no history to rollback to`)

    const previousState = draft.history.pop()!
    draft.items = { ...previousState.changes }
    draft.updated_at = Date.now()

    return { ...draft }
  }

  async get(draftId: string): Promise<Draft | null> {
    return this.drafts.get(draftId) ?? null
  }

  async getBySession(sessionId: string): Promise<Draft | null> {
    const draftId = this.sessionIndex.get(sessionId)
    if (!draftId) return null
    return this.drafts.get(draftId) ?? null
  }

  dispose(): void {
    for (const timer of this.timers.values()) {
      clearTimeout(timer)
    }
    this.timers.clear()
    this.drafts.clear()
    this.sessionIndex.clear()
  }

  // ── Private ──────────────────────────────────────────────────────────

  private startTtlTimer(draftId: string, ttlSeconds: number): void {
    const timer = setTimeout(() => {
      void this.handleExpiry(draftId)
    }, ttlSeconds * 1000)

    if (typeof timer === 'object' && 'unref' in timer) {
      timer.unref()
    }

    this.timers.set(draftId, timer)
  }

  private async handleExpiry(draftId: string): Promise<void> {
    const draft = this.drafts.get(draftId)
    if (!draft || draft.status !== 'draft') return

    draft.status = 'cancelled'
    draft.updated_at = Date.now()
    this.timers.delete(draftId)
    this.sessionIndex.delete(draft.session_id)
    this.drafts.delete(draftId)

    await this.bus.publish('bus:DRAFT_CANCELLED', {
      event: 'DRAFT_CANCELLED',
      draft_id: draftId,
      session_id: draft.session_id,
      reason: 'ttl_expired',
    })
  }

  private clearTimer(draftId: string): void {
    const timer = this.timers.get(draftId)
    if (timer) {
      clearTimeout(timer)
      this.timers.delete(draftId)
    }
  }
}
