import type { IEventBus, Unsubscribe } from '../types/index.js'
import type {
  IApprovalChannel,
  ApprovalRequest,
  ApprovalResponse,
  ApprovalOrchestratorDeps,
  ChannelConfig,
  HumanProfile,
  ApprovalStrategy,
  QuorumConfig,
  HumanRole,
} from './channels/types.js'
import type { IPresenceManager } from '../presence/types.js'

interface ActiveChannel {
  channel: IApprovalChannel
  config: ChannelConfig
}

interface QuorumAssignment extends ActiveChannel {
  approver: HumanProfile
  request: ApprovalRequest
}

interface PendingApproval {
  request: ApprovalRequest
  channels: ChannelConfig[]
  strategy: ApprovalStrategy
  fallbackApprover: HumanProfile
  resolve: (value: ApprovalResponse | null) => void
}

interface QuorumOutcome {
  response: ApprovalResponse | null
  partialApprovals: number
}

const ROLE_RANK: Record<HumanRole, number> = {
  customer: 0,
  user: 0,
  staff: 1,
  agent: 1,
  cashier: 2,
  operator: 2,
  manager: 3,
  supervisor: 3,
  owner: 4,
}

/**
 * ApprovalOrchestrator — coordinates approval channels for RESTRICTED actions.
 *
 * Listens for `bus:ORDER_PENDING_APPROVAL` events and orchestrates one or more
 * approval channels (voice, webhook, external) in parallel, sequential, or quorum mode.
 *
 * - **parallel**: all channels race — first response wins, others cancelled.
 * - **sequential**: channels tried in order — if one times out, next is tried.
 * - **quorum**: multiple eligible humans are asked; a configured approval count wins.
 *
 * @example
 * ```typescript
 * const orchestrator = new ApprovalOrchestrator({
 *   bus,
 *   channelRegistry: new Map([
 *     ['voice', voiceChannel],
 *     ['webhook', webhookChannel],
 *   ]),
 * })
 *
 * const unsub = orchestrator.start()
 * // Now listening for ORDER_PENDING_APPROVAL events
 * ```
 */
export class ApprovalOrchestrator {
  private readonly bus: IEventBus
  private readonly channelRegistry: Map<string, IApprovalChannel>
  private readonly presenceManager: IPresenceManager | undefined
  private readonly defaultTimeoutMs: number
  private readonly pendingNoApprover = new Map<string, PendingApproval>()
  private unsubs: Unsubscribe[] = []

  constructor(deps: ApprovalOrchestratorDeps) {
    this.bus = deps.bus
    this.channelRegistry = deps.channelRegistry
    this.presenceManager = deps.presenceManager
    this.defaultTimeoutMs = deps.defaultTimeoutMs ?? 120_000
  }

  /**
   * Start listening for `bus:ORDER_PENDING_APPROVAL` events.
   */
  start(): Unsubscribe {
    const unsub = this.bus.subscribe('bus:ORDER_PENDING_APPROVAL', (data) => {
      const event = data as {
        request: ApprovalRequest
        channels: ChannelConfig[]
        strategy: ApprovalStrategy
        approver: HumanProfile
      }

      void this.orchestrate(
        event.request,
        event.channels,
        event.strategy ?? 'parallel',
        event.approver,
      ).catch(() => {
        void this.publishTimeout(event.request)
      })
    })

    const presenceUnsub = this.bus.subscribe('bus:HUMAN_PRESENCE_CHANGED', () => {
      void this.drainPendingApprovals()
    })

    this.unsubs.push(unsub)
    this.unsubs.push(presenceUnsub)
    return () => this.dispose()
  }

  /**
   * Coordinate approval channels.
   */
  async orchestrate(
    request: ApprovalRequest,
    channels: ChannelConfig[],
    strategy: ApprovalStrategy = 'parallel',
    approver: HumanProfile,
  ): Promise<ApprovalResponse | null> {
    if (channels.length === 0) {
      await this.publishTimeout(request)
      return null
    }

    if (strategy === 'quorum') {
      return this.orchestrateWithQuorumRouting(request, channels, approver)
    }

    const availableApprover = await this.resolveAvailableApprover(request, approver)
    if (!availableApprover) {
      return this.queueNoApprover(request, channels, strategy, approver)
    }

    try {
      return await this.runOrchestration(request, channels, strategy, availableApprover)
    } finally {
      await this.releaseApprover(availableApprover)
    }
  }

  dispose(): void {
    for (const unsub of this.unsubs) {
      unsub()
    }
    this.unsubs = []

    for (const pending of this.pendingNoApprover.values()) {
      pending.resolve(null)
    }
    this.pendingNoApprover.clear()
  }

  // ── Private ──────────────────────────────────────────────────────────

  private async runOrchestration(
    request: ApprovalRequest,
    channels: ChannelConfig[],
    strategy: ApprovalStrategy,
    approver: HumanProfile,
    quorumApprovers?: HumanProfile[],
  ): Promise<ApprovalResponse | null> {
    if (channels.length === 0) {
      await this.publishTimeout(request)
      return null
    }

    let result: ApprovalResponse | null
    let partialApprovals: number | undefined

    if (strategy === 'quorum') {
      const outcome = await this.orchestrateQuorum(
        request,
        channels,
        this.normalizeQuorumConfig(request.quorum),
        quorumApprovers ?? [approver],
      )
      result = outcome.response
      partialApprovals = outcome.partialApprovals
    } else {
      result =
        strategy === 'parallel'
          ? await this.orchestrateParallel(request, channels, approver)
          : await this.orchestrateSequential(request, channels, approver)
    }

    if (result) {
      await this.bus.publish('bus:APPROVAL_RESOLVED', {
        event: 'APPROVAL_RESOLVED',
        request_id: request.id,
        draft_id: request.draft_id,
        session_id: request.session_id,
        approved: result.approved,
        approver_id: result.approver_id,
        approvers: result.approvers ?? [result.approver_id],
        channel_used: result.channel_used,
        strategy,
        timestamp: Date.now(),
      })

      if (result.approved) {
        await this.bus.publish('bus:ORDER_APPROVED', {
          event: 'ORDER_APPROVED',
          draft_id: request.draft_id,
          session_id: request.session_id,
          approved_by: result.approver_id,
          approvers: result.approvers ?? [result.approver_id],
          channel_used: result.channel_used,
          strategy,
        })
      }
    } else {
      await this.publishTimeout(request, partialApprovals)
    }

    return result
  }

  private async orchestrateWithQuorumRouting(
    request: ApprovalRequest,
    channels: ChannelConfig[],
    fallbackApprover: HumanProfile,
  ): Promise<ApprovalResponse | null> {
    const quorum = this.normalizeQuorumConfig(request.quorum)
    if (!quorum) {
      await this.publishTimeout(request)
      return null
    }

    const quorumRequest = { ...request, quorum }
    const approvers = this.resolveQuorumApprovers(quorumRequest, fallbackApprover, quorum)
    if (approvers.length < quorum.required) {
      if (this.presenceManager) {
        return this.queueNoApprover(quorumRequest, channels, 'quorum', fallbackApprover)
      }

      await this.publishTimeout(quorumRequest)
      return null
    }

    this.markApproversBusy(approvers)
    try {
      return await this.runOrchestration(
        quorumRequest,
        channels,
        'quorum',
        fallbackApprover,
        approvers,
      )
    } finally {
      await this.releaseApprovers(approvers)
    }
  }

  private async orchestrateParallel(
    request: ApprovalRequest,
    configs: ChannelConfig[],
    approver: HumanProfile,
  ): Promise<ApprovalResponse | null> {
    const activeChannels: ActiveChannel[] = []

    for (const config of configs) {
      const channel = this.channelRegistry.get(config.type)
      if (channel) {
        activeChannels.push({ channel, config })
      }
    }

    if (activeChannels.length === 0) return null

    const notifiedChannels = (
      await Promise.all(
        activeChannels.map(async (entry) => {
          try {
            await entry.channel.notify(request, approver)
            return entry
          } catch {
            entry.channel.cancel(request.id)
            return null
          }
        }),
      )
    ).filter(isActiveChannel)

    if (notifiedChannels.length === 0) return null

    return this.waitForFirstApprovalResponse(request, notifiedChannels)
  }

  private async orchestrateSequential(
    request: ApprovalRequest,
    configs: ChannelConfig[],
    approver: HumanProfile,
  ): Promise<ApprovalResponse | null> {
    for (const config of configs) {
      const channel = this.channelRegistry.get(config.type)
      if (!channel) continue

      let result: ApprovalResponse | null = null
      try {
        await channel.notify(request, approver)
        result = await channel.waitForResponse(request, config.timeout_ms ?? this.defaultTimeoutMs)
      } catch {
        channel.cancel(request.id)
        continue
      }

      if (result) {
        return result
      }
      // If null (timeout), try next channel
    }

    return null
  }

  private async orchestrateQuorum(
    request: ApprovalRequest,
    configs: ChannelConfig[],
    quorum: QuorumConfig | null | undefined,
    approvers: HumanProfile[],
  ): Promise<QuorumOutcome> {
    if (!quorum) return { response: null, partialApprovals: 0 }

    const assignments = this.buildQuorumAssignments(request, configs, approvers)
    const notifiedAssignments = (
      await Promise.all(
        assignments.map(async (assignment) => {
          try {
            await assignment.channel.notify(assignment.request, assignment.approver)
            return assignment
          } catch {
            assignment.channel.cancel(assignment.request.id)
            return null
          }
        }),
      )
    ).filter(isQuorumAssignment)

    if (notifiedAssignments.length === 0) {
      return { response: null, partialApprovals: 0 }
    }

    return this.waitForQuorumResponses(quorum, notifiedAssignments)
  }

  private async publishTimeout(request: ApprovalRequest, partialApprovals?: number): Promise<void> {
    const event: Record<string, unknown> = {
      event: 'ORDER_APPROVAL_TIMEOUT',
      draft_id: request.draft_id,
      session_id: request.session_id,
      request_id: request.id,
    }

    if (partialApprovals !== undefined) {
      event.partial_approvals = partialApprovals
    }

    if (request.quorum) {
      event.quorum_required = request.quorum.required
    }

    await this.bus.publish('bus:ORDER_APPROVAL_TIMEOUT', event)
  }

  private async waitForFirstApprovalResponse(
    request: ApprovalRequest,
    activeChannels: ActiveChannel[],
  ): Promise<ApprovalResponse | null> {
    return new Promise<ApprovalResponse | null>((resolve) => {
      let settled = false
      let pendingCount = activeChannels.length

      const settle = (result: ApprovalResponse | null) => {
        if (settled) return
        settled = true

        for (const { channel } of activeChannels) {
          channel.cancel(request.id)
        }

        resolve(result)
      }

      for (const { channel, config } of activeChannels) {
        Promise.resolve()
          .then(() => channel.waitForResponse(request, config.timeout_ms ?? this.defaultTimeoutMs))
          .then((result) => {
            if (settled) return

            if (result) {
              settle(result)
              return
            }

            pendingCount -= 1
            if (pendingCount === 0) {
              settle(null)
            }
          })
          .catch(() => {
            if (settled) return

            pendingCount -= 1
            if (pendingCount === 0) {
              settle(null)
            }
          })
      }
    })
  }

  private buildQuorumAssignments(
    request: ApprovalRequest,
    configs: ChannelConfig[],
    approvers: HumanProfile[],
  ): QuorumAssignment[] {
    const assignments: QuorumAssignment[] = []

    for (const approver of approvers) {
      for (const config of configs) {
        const channel = this.channelRegistry.get(config.type)
        if (!channel) continue

        assignments.push({
          channel,
          config,
          approver,
          request: {
            ...request,
            id: `${request.id}:quorum:${approver.id}:${config.type}`,
            context: {
              ...request.context,
              quorum_parent_request_id: request.id,
              quorum_approver_id: approver.id,
              expected_approver_id: approver.id,
            },
          },
        })
      }
    }

    return assignments
  }

  private async waitForQuorumResponses(
    quorum: QuorumConfig,
    assignments: QuorumAssignment[],
  ): Promise<QuorumOutcome> {
    return new Promise<QuorumOutcome>((resolve) => {
      let settled = false
      let pendingCount = assignments.length
      const approvedResponses: ApprovalResponse[] = []
      const approvedBy = new Set<string>()
      const rejectOnAnyNo = quorum.reject_on_any_no ?? true

      const settle = (response: ApprovalResponse | null) => {
        if (settled) return
        settled = true

        for (const assignment of assignments) {
          assignment.channel.cancel(assignment.request.id)
        }

        resolve({
          response,
          partialApprovals: approvedBy.size,
        })
      }

      const maybeComplete = () => {
        if (approvedBy.size >= quorum.required) {
          const first = approvedResponses[0]!
          settle({
            approved: true,
            approver_id: first.approver_id,
            approvers: approvedResponses.map((response) => response.approver_id),
            channel_used: first.channel_used,
            timestamp: Date.now(),
          })
          return
        }

        if (pendingCount === 0) {
          settle(null)
        }
      }

      for (const assignment of assignments) {
        Promise.resolve()
          .then(() =>
            assignment.channel.waitForResponse(
              assignment.request,
              assignment.config.timeout_ms ?? this.defaultTimeoutMs,
            ),
          )
          .then((result) => {
            if (settled) return
            pendingCount -= 1

            if (!result) {
              maybeComplete()
              return
            }

            if (result.approver_id !== assignment.approver.id) {
              maybeComplete()
              return
            }

            if (!result.approved && rejectOnAnyNo) {
              settle({
                ...result,
                approvers: [result.approver_id],
                timestamp: Date.now(),
              })
              return
            }

            if (result.approved && !approvedBy.has(result.approver_id)) {
              approvedBy.add(result.approver_id)
              approvedResponses.push(result)
            }

            maybeComplete()
          })
          .catch(() => {
            if (settled) return
            pendingCount -= 1
            maybeComplete()
          })
      }

      if (assignments.length === 0) {
        settle(null)
      }
    })
  }

  private async resolveAvailableApprover(
    request: ApprovalRequest,
    fallbackApprover: HumanProfile,
  ): Promise<HumanProfile | null> {
    if (!this.presenceManager) return fallbackApprover

    const storeId =
      typeof request.context.store_id === 'string'
        ? request.context.store_id
        : fallbackApprover.store_id
    const available = this.presenceManager.getAvailable(request.required_role, storeId)
    const approver = available[0]
    if (!approver) return null

    this.presenceManager.markBusy(approver.id)
    return approver
  }

  private resolveQuorumApprovers(
    request: ApprovalRequest,
    fallbackApprover: HumanProfile,
    quorum: QuorumConfig,
  ): HumanProfile[] {
    if (!this.presenceManager) {
      return quorum.required <= 1 && this.isEligibleForQuorum(fallbackApprover, quorum)
        ? [fallbackApprover]
        : []
    }

    const storeId =
      typeof request.context.store_id === 'string'
        ? request.context.store_id
        : fallbackApprover.store_id
    const approversById = new Map<string, HumanProfile>()

    for (const role of quorum.eligible_roles) {
      for (const approver of this.presenceManager.getAvailable(role, storeId)) {
        approversById.set(approver.id, approver)
      }
    }

    return [...approversById.values()]
  }

  private isEligibleForQuorum(approver: HumanProfile, quorum: QuorumConfig): boolean {
    return quorum.eligible_roles.some((role) => ROLE_RANK[approver.role] >= ROLE_RANK[role])
  }

  private normalizeQuorumConfig(quorum: QuorumConfig | undefined): QuorumConfig | null {
    if (!quorum) return null

    const required = Math.floor(quorum.required)
    if (!Number.isFinite(required) || required < 1) return null

    const configuredRoles = Array.isArray(quorum.eligible_roles) ? quorum.eligible_roles : []
    const eligibleRoles = [...new Set(configuredRoles)].filter((role) =>
      Object.prototype.hasOwnProperty.call(ROLE_RANK, role),
    )
    if (eligibleRoles.length === 0) return null

    return {
      required,
      eligible_roles: eligibleRoles,
      reject_on_any_no: quorum.reject_on_any_no ?? true,
    }
  }

  private markApproversBusy(approvers: HumanProfile[]): void {
    for (const approver of approvers) {
      this.presenceManager?.markBusy(approver.id)
    }
  }

  private async releaseApprover(approver: HumanProfile): Promise<void> {
    this.presenceManager?.markFree(approver.id)
  }

  private async releaseApprovers(approvers: HumanProfile[]): Promise<void> {
    for (const approver of approvers) {
      await this.releaseApprover(approver)
    }
  }

  private async queueNoApprover(
    request: ApprovalRequest,
    channels: ChannelConfig[],
    strategy: ApprovalStrategy,
    fallbackApprover: HumanProfile,
  ): Promise<ApprovalResponse | null> {
    const queued = new Promise<ApprovalResponse | null>((resolve) => {
      this.pendingNoApprover.set(request.id, {
        request,
        channels,
        strategy,
        fallbackApprover,
        resolve,
      })
    })

    await this.bus.publish('bus:ORDER_QUEUED_NO_APPROVER', {
      event: 'ORDER_QUEUED_NO_APPROVER',
      request_id: request.id,
      draft_id: request.draft_id,
      session_id: request.session_id,
      required_role: request.required_role,
      quorum_required: request.quorum?.required,
      eligible_roles: request.quorum?.eligible_roles,
      queued_at: Date.now(),
    })

    void this.drainPendingApprovals()

    return queued
  }

  private async drainPendingApprovals(): Promise<void> {
    if (!this.presenceManager) return

    for (const [requestId, pending] of [...this.pendingNoApprover.entries()]) {
      if (pending.strategy === 'quorum') {
        const quorum = pending.request.quorum
        if (!quorum) {
          this.pendingNoApprover.delete(requestId)
          await this.publishTimeout(pending.request)
          pending.resolve(null)
          continue
        }

        const approvers = this.resolveQuorumApprovers(
          pending.request,
          pending.fallbackApprover,
          quorum,
        )
        if (approvers.length < quorum.required) continue

        this.pendingNoApprover.delete(requestId)
        this.markApproversBusy(approvers)
        try {
          const result = await this.runOrchestration(
            pending.request,
            pending.channels,
            pending.strategy,
            pending.fallbackApprover,
            approvers,
          )
          pending.resolve(result)
        } finally {
          await this.releaseApprovers(approvers)
        }
        continue
      }

      const approver = await this.resolveAvailableApprover(
        pending.request,
        pending.fallbackApprover,
      )
      if (!approver) continue

      this.pendingNoApprover.delete(requestId)
      try {
        const result = await this.runOrchestration(
          pending.request,
          pending.channels,
          pending.strategy,
          approver,
        )
        pending.resolve(result)
      } finally {
        await this.releaseApprover(approver)
      }
    }
  }
}

function isActiveChannel(entry: ActiveChannel | null): entry is ActiveChannel {
  return entry !== null
}

function isQuorumAssignment(entry: QuorumAssignment | null): entry is QuorumAssignment {
  return entry !== null
}
