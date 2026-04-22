import { InMemoryDraftStore } from 'fitalyagents'
import type { IEventBus } from 'fitalyagents'
import type { DraftRepository } from '../storage/repositories/drafts.js'
import type { ToolRegistry } from '../tools/registry.js'

export class PersistentDraftStore extends InMemoryDraftStore {
  private readonly unsub: () => void

  constructor(deps: { bus: IEventBus; repository: DraftRepository; toolRegistry: ToolRegistry }) {
    super({ bus: deps.bus })

    this.unsub = deps.bus.subscribe('bus:DRAFT_CANCELLED', (payload) => {
      const event = payload as { draft_id?: string }
      if (event.draft_id) {
        deps.repository.updateStatus(event.draft_id, 'cancelled')
      }
    })

    this.repository = deps.repository
    this.toolRegistry = deps.toolRegistry
  }

  private readonly repository: DraftRepository
  private readonly toolRegistry: ToolRegistry

  override async create(
    sessionId: string,
    input: {
      intent_id: string
      items: Record<string, unknown>
      total?: number
      ttl_seconds?: number
    },
  ): Promise<string> {
    const draftId = await super.create(sessionId, input)
    const draft = await this.get(draftId)
    const tool = this.toolRegistry.get(input.intent_id)

    if (draft) {
      this.repository.upsert({
        id: draft.id,
        session_id: draft.session_id,
        tool_id: draft.intent_id,
        params: draft.items,
        status: 'pending',
        safety_level: tool?.safety ?? 'staged',
        created_at: draft.created_at,
        updated_at: draft.updated_at,
      })
    }

    return draftId
  }

  override async update(draftId: string, changes: Record<string, unknown>) {
    const draft = await super.update(draftId, changes)
    const tool = this.toolRegistry.get(draft.intent_id)

    this.repository.upsert({
      id: draft.id,
      session_id: draft.session_id,
      tool_id: draft.intent_id,
      params: draft.items,
      status: 'pending',
      safety_level: tool?.safety ?? 'staged',
      created_at: draft.created_at,
      updated_at: draft.updated_at,
    })

    return draft
  }

  override async confirm(draftId: string): Promise<void> {
    await super.confirm(draftId)
    this.repository.updateStatus(draftId, 'confirmed')
  }

  override async cancel(draftId: string): Promise<void> {
    await super.cancel(draftId)
    this.repository.updateStatus(draftId, 'cancelled')
  }

  override dispose(): void {
    this.unsub()
    super.dispose()
  }
}
