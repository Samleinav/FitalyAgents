import type { IEventBus, Unsubscribe } from '../types/index.js'
import type {
  IApprovalChannel,
  ApprovalRequest,
  ApprovalResponse,
  ApprovalOrchestratorDeps,
  ChannelConfig,
  HumanProfile,
} from './channels/types.js'

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
  private readonly defaultTimeoutMs: number
  private unsubs: Unsubscribe[] = []

  constructor(deps: ApprovalOrchestratorDeps) {
    this.bus = deps.bus
    this.channelRegistry = deps.channelRegistry
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
        strategy: 'parallel' | 'sequential'
        approver: HumanProfile
      }

      void this.orchestrate(
        event.request,
        event.channels,
        event.strategy ?? 'parallel',
        event.approver,
      )
    })

    this.unsubs.push(unsub)
    return () => this.dispose()
  }

  /**
   * Coordinate approval channels.
   */
  async orchestrate(
    request: ApprovalRequest,
    channels: ChannelConfig[],
    strategy: 'parallel' | 'sequential' = 'parallel',
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

  dispose(): void {
    for (const unsub of this.unsubs) {
      unsub()
    }
    this.unsubs = []
  }

  // ── Private ──────────────────────────────────────────────────────────

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

    // Notify all channels
    await Promise.all(activeChannels.map(({ channel }) => channel.notify(request, approver)))

    // Race all channels
    const result = await Promise.race(
      activeChannels.map(({ channel, config }) =>
        channel.waitForResponse(request, config.timeout_ms ?? this.defaultTimeoutMs),
      ),
    )

    // Cancel all other channels
    for (const { channel } of activeChannels) {
      channel.cancel(request.id)
    }

    return result
  }

  private async orchestrateSequential(
    request: ApprovalRequest,
    configs: ChannelConfig[],
    approver: HumanProfile,
  ): Promise<ApprovalResponse | null> {
    for (const config of configs) {
      const channel = this.channelRegistry.get(config.type)
      if (!channel) continue

      await channel.notify(request, approver)
      const result = await channel.waitForResponse(
        request,
        config.timeout_ms ?? this.defaultTimeoutMs,
      )

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
}
