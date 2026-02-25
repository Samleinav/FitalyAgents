import type { IEventBus, Unsubscribe } from '../types/index.js'

/**
 * Options for SimpleRouter.
 */
export interface SimpleRouterOptions {
  bus: IEventBus
  /**
   * Maps intent_id to the agent_id that handles it.
   *
   * @example
   * ```typescript
   * routes: {
   *   product_search: 'work-agent',
   *   order_create:   'order-agent',
   * }
   * ```
   */
  routes: Record<string, string>
  /**
   * Agent IDs that receive a copy of every task, regardless of intent.
   * Useful for interaction/voice agents that need to start a filler response
   * while the primary agent processes the task.
   *
   * The copy uses `task_id: '<agentId>_<originalTaskId>'` to avoid collisions.
   *
   * @example
   * ```typescript
   * alwaysNotify: ['interaction-agent']
   * ```
   */
  alwaysNotify?: string[]
  /** Default timeout in ms for routed tasks. Default: 8000 */
  defaultTimeoutMs?: number
}

/**
 * SimpleRouter — subscribes to `bus:TASK_AVAILABLE` and routes tasks to agent
 * inboxes via `bus.lpush`.
 *
 * Drop-in replacement for the `createSimpleRouter` helper pattern. In production,
 * use `CapabilityRouter` (which integrates with TaskQueue and LockManager).
 *
 * Agent inbox channel: `queue:<agent-id>:inbox`
 * Agent outbox channel: `queue:<agent-id>:outbox`
 *
 * @example
 * ```typescript
 * const router = new SimpleRouter({
 *   bus,
 *   routes: {
 *     product_search: 'work-agent',
 *     order_create:   'order-agent',
 *   },
 *   alwaysNotify: ['interaction-agent'],
 * })
 *
 * const stop = router.start()
 * // ...later
 * stop()
 * ```
 */
export class SimpleRouter {
  private readonly bus: IEventBus
  private readonly routes: Record<string, string>
  private readonly alwaysNotify: string[]
  private readonly defaultTimeoutMs: number
  private unsub: Unsubscribe | null = null

  constructor(options: SimpleRouterOptions) {
    this.bus = options.bus
    this.routes = options.routes
    this.alwaysNotify = options.alwaysNotify ?? []
    this.defaultTimeoutMs = options.defaultTimeoutMs ?? 8000
  }

  /**
   * Start listening to `bus:TASK_AVAILABLE` and route tasks to agent inboxes.
   * Returns an unsubscribe function that stops routing.
   */
  start(): Unsubscribe {
    if (this.unsub) {
      throw new Error('SimpleRouter already started. Call dispose() first.')
    }

    this.unsub = this.bus.subscribe('bus:TASK_AVAILABLE', (data) => {
      void this.handleTaskAvailable(data)
    })

    return () => this.dispose()
  }

  /**
   * Stop listening and clean up.
   */
  dispose(): void {
    if (this.unsub) {
      this.unsub()
      this.unsub = null
    }
  }

  // ── Private ──────────────────────────────────────────────────────────────

  private async handleTaskAvailable(data: unknown): Promise<void> {
    const event = data as {
      task_id: string
      session_id: string
      intent_id: string
      slots?: Record<string, unknown>
      timeout_ms?: number
    }

    const agentId = this.routes[event.intent_id]

    // Route to primary agent if a route exists for this intent
    if (agentId) {
      await this.bus.lpush(
        `queue:${agentId}:inbox`,
        this.buildPayload(event, agentId, event.task_id),
      )
    }

    // Broadcast a copy to all alwaysNotify agents
    for (const notifyAgentId of this.alwaysNotify) {
      const broadcastTaskId = `${notifyAgentId}_${event.task_id}`
      await this.bus.lpush(
        `queue:${notifyAgentId}:inbox`,
        this.buildPayload(event, notifyAgentId, broadcastTaskId),
      )
    }
  }

  private buildPayload(
    event: {
      task_id: string
      session_id: string
      intent_id: string
      slots?: Record<string, unknown>
      timeout_ms?: number
    },
    agentId: string,
    taskId: string,
  ): object {
    return {
      event: 'TASK_PAYLOAD',
      task_id: taskId,
      session_id: event.session_id,
      intent_id: event.intent_id,
      slots: event.slots ?? {},
      context_snapshot: {},
      cancel_token: null,
      timeout_ms: event.timeout_ms ?? this.defaultTimeoutMs,
      reply_to: `queue:${agentId}:outbox`,
    }
  }
}
