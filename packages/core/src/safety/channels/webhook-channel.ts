import type { IEventBus, Unsubscribe } from '../../types/index.js'
import type { IApprovalChannel, ApprovalRequest, ApprovalResponse, HumanProfile } from './types.js'

/**
 * WebhookApprovalChannel — sends push notifications to the approver's app.
 *
 * Notify: publishes `bus:APPROVAL_WEBHOOK_REQUEST` for the app/webhook server.
 * Listen: subscribes to `bus:APPROVAL_WEBHOOK_RESPONSE` and matches by request_id.
 */
export class WebhookApprovalChannel implements IApprovalChannel {
  readonly id: string
  readonly type = 'webhook' as const

  private readonly bus: IEventBus
  private activeWaits: Map<
    string,
    {
      resolve: (value: ApprovalResponse | null) => void
      unsub: Unsubscribe
      timer: ReturnType<typeof setTimeout>
    }
  > = new Map()

  constructor(deps: { bus: IEventBus; id?: string }) {
    this.bus = deps.bus
    this.id = deps.id ?? 'webhook'
  }

  async notify(request: ApprovalRequest, approver: HumanProfile): Promise<void> {
    await this.bus.publish('bus:APPROVAL_WEBHOOK_REQUEST', {
      event: 'APPROVAL_WEBHOOK_REQUEST',
      request_id: request.id,
      draft_id: request.draft_id,
      approver_id: approver.id,
      required_role: request.required_role,
      action: request.action,
      amount: request.amount,
      session_id: request.session_id,
    })
  }

  waitForResponse(request: ApprovalRequest, timeoutMs: number): Promise<ApprovalResponse | null> {
    return new Promise<ApprovalResponse | null>((resolve) => {
      const timer = setTimeout(() => {
        this.cleanup(request.id)
        resolve(null)
      }, timeoutMs)

      if (typeof timer === 'object' && 'unref' in timer) {
        timer.unref()
      }

      const unsub = this.bus.subscribe('bus:APPROVAL_WEBHOOK_RESPONSE', (data) => {
        const event = data as {
          request_id: string
          approved: boolean
          approver_id: string
          reason?: string
        }

        if (event.request_id !== request.id) return

        this.cleanup(request.id)
        resolve({
          approved: event.approved,
          approver_id: event.approver_id,
          channel_used: 'webhook',
          reason: event.reason,
          timestamp: Date.now(),
        })
      })

      this.activeWaits.set(request.id, { resolve, unsub, timer })
    })
  }

  cancel(requestId: string): void {
    const wait = this.activeWaits.get(requestId)
    if (wait) {
      this.cleanup(requestId)
      wait.resolve(null)
    }
  }

  private cleanup(requestId: string): void {
    const wait = this.activeWaits.get(requestId)
    if (wait) {
      clearTimeout(wait.timer)
      wait.unsub()
      this.activeWaits.delete(requestId)
    }
  }
}
