import type { IEventBus, Unsubscribe } from '../../types/index.js'
import type { IApprovalChannel, ApprovalRequest, ApprovalResponse, HumanProfile } from './types.js'

export interface ExternalToolChannelConfig {
  url: string
  method: 'POST' | 'GET'
  auth?: string
}

/**
 * ExternalToolChannel — calls an external API to request approval.
 *
 * Notify: makes an HTTP request to the configured endpoint with the ApprovalRequest.
 * Listen: subscribes to `bus:APPROVAL_EXTERNAL_RESPONSE` and matches by request_id.
 *
 * The external system is responsible for notifying the approver and
 * posting back via the bus (e.g. through a webhook endpoint that publishes
 * to `bus:APPROVAL_EXTERNAL_RESPONSE`).
 */
export class ExternalToolChannel implements IApprovalChannel {
  readonly id: string
  readonly type = 'external_tool' as const

  private readonly bus: IEventBus
  private readonly config: ExternalToolChannelConfig
  private readonly fetchFn: typeof globalThis.fetch
  private activeWaits: Map<
    string,
    {
      resolve: (value: ApprovalResponse | null) => void
      unsub: Unsubscribe
      timer: ReturnType<typeof setTimeout>
    }
  > = new Map()

  constructor(deps: {
    bus: IEventBus
    config: ExternalToolChannelConfig
    id?: string
    fetchFn?: typeof globalThis.fetch
  }) {
    this.bus = deps.bus
    this.config = deps.config
    this.id = deps.id ?? 'external_tool'
    this.fetchFn = deps.fetchFn ?? globalThis.fetch
  }

  async notify(request: ApprovalRequest, _approver: HumanProfile): Promise<void> {
    const headers: Record<string, string> = {
      'Content-Type': 'application/json',
    }

    if (this.config.auth) {
      headers['Authorization'] = this.config.auth
    }

    const payload = {
      request_id: request.id,
      draft_id: request.draft_id,
      action: request.action,
      amount: request.amount,
      session_id: request.session_id,
      required_role: request.required_role,
      timeout_ms: request.timeout_ms,
      context: request.context,
    }

    await this.fetchFn(this.config.url, {
      method: this.config.method,
      headers,
      body: JSON.stringify(payload),
    })

    await this.bus.publish('bus:APPROVAL_EXTERNAL_REQUEST', {
      event: 'APPROVAL_EXTERNAL_REQUEST',
      request_id: request.id,
      draft_id: request.draft_id,
      payload,
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

      const unsub = this.bus.subscribe('bus:APPROVAL_EXTERNAL_RESPONSE', (data) => {
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
          channel_used: 'external_tool',
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
