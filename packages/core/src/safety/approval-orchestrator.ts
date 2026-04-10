import type { IEventBus, Unsubscribe } from '../types/index.js'
import type {
  IApprovalChannel,
  ApprovalRequest,
  ApprovalResponse,
  ApprovalOrchestratorDeps,
  ChannelConfig,
  HumanProfile,
} from './channels/types.js'
import type { IPresenceManager } from '../presence/types.js'

type ApprovalStrategy = 'parallel' | 'sequential'

interface PendingApproval {
  request: ApprovalRequest
  channels: ChannelConfig[]
  strategy: ApprovalStrategy
  fallbackApprover: HumanProfile
  resolve: (value: ApprovalResponse | null) => void
}

/**
 * ApprovalOrchestrator — coordinates approval channels for RESTRICTED actions.
 *
 * Listens for `bus:ORDER_PENDING_APPROVAL` events and orchestrates one or more
 * approval channels (voice, webhook, external) in parallel or sequential mode.
 *
 * - **parallel**: all channels race — first response wins, others cancelled.
 * - **sequential**: channels tried in order — if one times out, next is tried.
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
  ): Promise<ApprovalResponse | null> {
    if (channels.length === 0) {
      await this.publishTimeout(request)
      return null
    }

    const result =
      strategy === 'parallel'
        ? await this.orchestrateParallel(request, channels, approver)
        : await this.orchestrateSequential(request, channels, approver)

    if (result) {
      await this.bus.publish('bus:APPROVAL_RESOLVED', {
        event: 'APPROVAL_RESOLVED',
        request_id: request.id,
        draft_id: request.draft_id,
        approved: result.approved,
        approver_id: result.approver_id,
        channel_used: result.channel_used,
        timestamp: Date.now(),
      })

      if (result.approved) {
        await this.bus.publish('bus:ORDER_APPROVED', {
          event: 'ORDER_APPROVED',
          draft_id: request.draft_id,
          session_id: request.session_id,
          approved_by: result.approver_id,
          channel_used: result.channel_used,
        })
      }
    } else {
      await this.publishTimeout(request)
    }

    return result
  }

  private async orchestrateParallel(
    request: ApprovalRequest,
    configs: ChannelConfig[],
    approver: HumanProfile,
  ): Promise<ApprovalResponse | null> {
    const activeChannels: Array<{ channel: IApprovalChannel; config: ChannelConfig }> = []

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

  private async publishTimeout(request: ApprovalRequest): Promise<void> {
    await this.bus.publish('bus:ORDER_APPROVAL_TIMEOUT', {
      event: 'ORDER_APPROVAL_TIMEOUT',
      draft_id: request.draft_id,
      session_id: request.session_id,
      request_id: request.id,
    })
  }

  private async waitForFirstApprovalResponse(
    request: ApprovalRequest,
    activeChannels: Array<{ channel: IApprovalChannel; config: ChannelConfig }>,
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

  private async releaseApprover(approver: HumanProfile): Promise<void> {
    this.presenceManager?.markFree(approver.id)
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
      queued_at: Date.now(),
    })

    void this.drainPendingApprovals()

    return queued
  }

  private async drainPendingApprovals(): Promise<void> {
    if (!this.presenceManager) return

    for (const [requestId, pending] of [...this.pendingNoApprover.entries()]) {
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

function isActiveChannel(
  entry: { channel: IApprovalChannel; config: ChannelConfig } | null,
): entry is { channel: IApprovalChannel; config: ChannelConfig } {
  return entry !== null
}
