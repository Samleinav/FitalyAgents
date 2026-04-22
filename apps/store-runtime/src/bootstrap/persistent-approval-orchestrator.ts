import {
  ApprovalOrchestrator,
  type IEventBus,
  type Unsubscribe,
  type ApprovalRequest,
  type ApprovalResponse,
  type ApprovalStrategy,
  type ChannelConfig,
  type HumanProfile,
} from 'fitalyagents'
import type { ApprovalRepository } from '../storage/repositories/approvals.js'

export class PersistentApprovalOrchestrator extends ApprovalOrchestrator {
  constructor(
    deps: ConstructorParameters<typeof ApprovalOrchestrator>[0] & {
      repository: ApprovalRepository
    },
  ) {
    super(deps)
    this.eventBus = deps.bus
    this.repository = deps.repository
  }

  private readonly eventBus: IEventBus
  private readonly repository: ApprovalRepository
  private extraUnsub: Unsubscribe | null = null

  override start(): Unsubscribe {
    super.start()
    this.extraUnsub = this.repositorySyncSubscription()

    return () => this.dispose()
  }

  override async orchestrate(
    request: ApprovalRequest,
    channels: ChannelConfig[],
    strategy: ApprovalStrategy = 'parallel',
    approver: HumanProfile,
  ): Promise<ApprovalResponse | null> {
    this.repository.insert({
      id: request.id,
      draft_id: request.draft_id,
      session_id: request.session_id,
      action: request.action,
      required_role: request.required_role,
      strategy,
      quorum_required: request.quorum?.required ?? null,
      status: 'pending',
      approvers: [],
      context: request.context,
      timeout_ms: request.timeout_ms,
      created_at: Date.now(),
      resolved_at: null,
    })

    try {
      const response = await super.orchestrate(request, channels, strategy, approver)

      if (response?.approved) {
        this.repository.updateStatus(
          request.id,
          'approved',
          response.approvers ?? [response.approver_id],
          response.timestamp,
        )
      } else if (response?.approved === false) {
        this.repository.updateStatus(
          request.id,
          'rejected',
          response.approvers ?? [response.approver_id],
          response.timestamp,
        )
      } else {
        this.repository.updateStatus(request.id, 'timeout', [], Date.now())
      }

      return response
    } catch (error) {
      this.repository.updateStatus(request.id, 'timeout', [], Date.now())
      throw error
    }
  }

  override dispose(): void {
    this.extraUnsub?.()
    this.extraUnsub = null
    super.dispose()
  }

  private repositorySyncSubscription(): Unsubscribe {
    return this.eventBus.subscribe('bus:ORDER_QUEUED_NO_APPROVER', (payload) => {
      const event = payload as { request_id?: string }
      if (event.request_id) {
        this.repository.updateStatus(event.request_id, 'queued')
      }
    })
  }
}
