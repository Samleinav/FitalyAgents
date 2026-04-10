import { StreamAgent } from './stream-agent.js'
import type { IEventBus } from '../types/index.js'

// ── Types ────────────────────────────────────────────────────────────────────

export interface UIUpdatePayload {
  component: string
  action: 'show' | 'hide' | 'update' | 'confirmed'
  data?: Record<string, unknown>
}

/**
 * Optional callback fired on every UI update, before the bus publish.
 * Useful for SSE/WebSocket broadcasting to connected clients.
 */
export type UIEventHandler = (update: UIUpdatePayload) => void

export interface UIAgentDeps {
  bus: IEventBus
  /** Optional callback for every UI update (e.g. SSE push to browser). */
  onUpdate?: UIEventHandler
}

// ── UIAgent ──────────────────────────────────────────────────────────────────

/**
 * UIAgent — observes bus events and publishes UI_UPDATE instructions.
 *
 * **No LLM** — pure reactive logic (event → UI update mapping).
 * Designed to drive a dashboard/tablet/screen in a store.
 *
 * Subscriptions:
 * - `DRAFT_CREATED`         → order_panel show
 * - `DRAFT_CONFIRMED`       → order_panel confirmed
 * - `DRAFT_CANCELLED`       → order_panel hide
 * - `TOOL_RESULT`           → product_grid show (if product_search)
 * - `TARGET_GROUP_CHANGED`  → queue_status update
 * - `APPROVAL_RESOLVED`     → approval_bar update
 * - `ORDER_QUEUED_NO_APPROVER` → approval_queue show
 * - `SESSION_HANDOFF`       → handoff_panel show
 * - `SESSION_RESUMED`       → handoff_panel hide
 * - `PROACTIVE_TRIGGER`     → suggestion show
 * - `STAFF_COMMAND`         → staff_bar show
 *
 * @example
 * ```typescript
 * const ui = new UIAgent({
 *   bus,
 *   onUpdate: (update) => sseClients.forEach(c => c.write(JSON.stringify(update))),
 * })
 * await ui.start()
 * // bus:DRAFT_CREATED → UI_UPDATE { component: 'order_panel', action: 'show' }
 * ```
 */
export class UIAgent extends StreamAgent {
  private readonly onUpdate: UIEventHandler

  protected get channels(): string[] {
    return [
      'bus:DRAFT_CREATED',
      'bus:DRAFT_CONFIRMED',
      'bus:DRAFT_CANCELLED',
      'bus:TOOL_RESULT',
      'bus:TARGET_GROUP_CHANGED',
      'bus:APPROVAL_RESOLVED',
      'bus:ORDER_QUEUED_NO_APPROVER',
      'bus:SESSION_HANDOFF',
      'bus:SESSION_RESUMED',
      'bus:PROACTIVE_TRIGGER',
      'bus:STAFF_COMMAND',
    ]
  }

  constructor(deps: UIAgentDeps) {
    super(deps.bus)
    this.onUpdate = deps.onUpdate ?? (() => {})
  }

  async onEvent(channel: string, payload: unknown): Promise<void> {
    const data = payload as Record<string, unknown>
    let update: UIUpdatePayload | null = null

    switch (channel) {
      case 'bus:DRAFT_CREATED':
        update = {
          component: 'order_panel',
          action: 'show',
          data: {
            draft_id: data.draft_id,
            intent_id: data.intent_id,
            summary: data.summary,
            ttl: data.ttl,
          },
        }
        break

      case 'bus:DRAFT_CONFIRMED':
        update = {
          component: 'order_panel',
          action: 'confirmed',
          data: {
            draft_id: data.draft_id,
            items: data.items,
            total: data.total,
            message: '✅ Orden confirmada',
          },
        }
        break

      case 'bus:DRAFT_CANCELLED':
        update = {
          component: 'order_panel',
          action: 'hide',
          data: {
            draft_id: data.draft_id,
            reason: data.reason,
          },
        }
        break

      case 'bus:TOOL_RESULT': {
        const toolName = String(data.tool_name ?? data.tool_id ?? '')
        if (toolName.includes('product_search')) {
          update = {
            component: 'product_grid',
            action: 'show',
            data: {
              results: data.result ?? data.results,
              query: data.query,
            },
          }
        }
        break
      }

      case 'bus:TARGET_GROUP_CHANGED':
        update = {
          component: 'queue_status',
          action: 'update',
          data: {
            store_id: data.store_id,
            primary: data.primary,
            queued: data.queued,
            ambient: data.ambient,
            speakers: data.speakers,
          },
        }
        break

      case 'bus:APPROVAL_RESOLVED':
        update = {
          component: 'approval_bar',
          action: 'update',
          data: {
            request_id: data.request_id,
            draft_id: data.draft_id,
            approved: data.approved,
            approver_id: data.approver_id,
            channel_used: data.channel_used,
          },
        }
        break

      case 'bus:ORDER_QUEUED_NO_APPROVER':
        update = {
          component: 'approval_queue',
          action: 'show',
          data: {
            request_id: data.request_id,
            draft_id: data.draft_id,
            session_id: data.session_id,
            required_role: data.required_role,
            queued_at: data.queued_at,
          },
        }
        break

      case 'bus:SESSION_HANDOFF':
        update = {
          component: 'handoff_panel',
          action: 'show',
          data: {
            session_id: data.session_id,
            from_agent_id: data.from_agent_id,
            to_human_id: data.to_human_id,
            to_role: data.to_role,
            context_snapshot: data.context_snapshot,
            conversation_summary: data.conversation_summary,
            pending_draft: data.pending_draft,
            memory_context: data.memory_context,
            timestamp: data.timestamp,
          },
        }
        break

      case 'bus:SESSION_RESUMED':
        update = {
          component: 'handoff_panel',
          action: 'hide',
          data: {
            session_id: data.session_id,
            resumed_by: data.resumed_by,
            resumed_by_role: data.resumed_by_role,
            notes: data.notes,
            timestamp: data.timestamp,
          },
        }
        break

      case 'bus:PROACTIVE_TRIGGER':
        update = {
          component: 'suggestion',
          action: 'show',
          data: {
            session_id: data.session_id,
            reason: data.reason,
            context: data.context,
          },
        }
        break

      case 'bus:STAFF_COMMAND':
        update = {
          component: 'staff_bar',
          action: 'show',
          data: {
            session_id: data.session_id,
            command: data.command,
            staff_id: data.staff_id,
            params: data.params,
            result: data.result,
          },
        }
        break
    }

    if (update) {
      // Fire callback (for SSE/WS broadcasting)
      this.onUpdate(update)

      // Publish to bus
      await this.bus.publish('bus:UI_UPDATE', {
        event: 'UI_UPDATE',
        ...update,
      })
    }
  }
}
