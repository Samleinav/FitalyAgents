import type { IEventBus } from '../types/index.js'
import type {
  AgentManifest,
  HeartbeatStatus,
  TaskPayloadEvent,
  TaskResultEvent,
} from '../types/index.js'

export interface NexusAgentOptions {
  /** The event bus to communicate through. */
  bus: IEventBus
  /** The agent's manifest declaring its capabilities. */
  manifest: AgentManifest
}

/**
 * NexusAgent — the base class for all FitalyAgents Layer 1 agents.
 *
 * @deprecated Use StreamAgent instead. Will be removed in v2.0.0 (Sprint 4.1).
 *
 * Handles:
 * - Self-registration on the bus at startup
 * - Heartbeat publishing at configurable intervals
 * - Inbox listening via BRPOP (queue-based, more efficient than pub/sub for tasks)
 * - Error wrapping: if `process()` throws, publishes a `TASK_RESULT` with `status: failed`
 * - Graceful shutdown with `SIGTERM` handling
 *
 * Subclasses implement the abstract `process()` method:
 *
 * @example
 * ```typescript
 * class ProductSearchAgent extends NexusAgent {
 *   async process(task: TaskPayloadEvent): Promise<TaskResultEvent> {
 *     const results = await searchProducts(task.slots)
 *     return {
 *       event: 'TASK_RESULT',
 *       task_id: task.task_id,
 *       session_id: task.session_id,
 *       status: 'completed',
 *       result: results,
 *       context_patch: { last_action: { type: 'PRODUCT_SEARCH', result: results } },
 *       completed_at: Date.now(),
 *     }
 *   }
 * }
 *
 * const agent = new ProductSearchAgent({ bus, manifest })
 * await agent.start()
 * ```
 */
export abstract class NexusAgent {
  protected bus: IEventBus
  protected manifest: AgentManifest
  private heartbeatTimer: ReturnType<typeof setInterval> | null = null
  private running = false
  private currentTasks = 0
  private shutdownHandlers: (() => void)[] = []

  constructor(options: NexusAgentOptions) {
    this.bus = options.bus
    this.manifest = options.manifest
  }

  /**
   * Start the agent:
   * 1. Publish AGENT_REGISTERED event
   * 2. Start heartbeat timer
   * 3. Begin listening on inbox queue
   */
  async start(): Promise<void> {
    this.running = true

    // Publish registration
    await this.bus.publish('bus:AGENT_REGISTERED', {
      event: 'AGENT_REGISTERED' as const,
      ...this.manifest,
    })

    // Start heartbeat
    this.heartbeatTimer = setInterval(async () => {
      await this.publishHeartbeat()
    }, this.manifest.heartbeat_interval_ms)

    if (typeof this.heartbeatTimer === 'object' && 'unref' in this.heartbeatTimer) {
      this.heartbeatTimer.unref()
    }

    // Register SIGTERM handler
    const onSigterm = () => {
      this.shutdown().catch(() => {})
    }
    process.on('SIGTERM', onSigterm)
    this.shutdownHandlers.push(() => process.removeListener('SIGTERM', onSigterm))

    // Start listening on inbox (non-blocking — runs in background)
    this.listenInbox().catch(() => {})
  }

  /**
   * Gracefully shutdown:
   * 1. Stop accepting new tasks
   * 2. Stop heartbeat
   * 3. Publish AGENT_DEREGISTERED
   */
  async shutdown(): Promise<void> {
    this.running = false

    if (this.heartbeatTimer) {
      clearInterval(this.heartbeatTimer)
      this.heartbeatTimer = null
    }

    // Publish deregistration
    await this.bus.publish('bus:AGENT_DEREGISTERED', {
      event: 'AGENT_DEREGISTERED' as const,
      agent_id: this.manifest.agent_id,
      timestamp: Date.now(),
    })

    // Cleanup SIGTERM handlers
    for (const cleanup of this.shutdownHandlers) {
      cleanup()
    }
    this.shutdownHandlers = []
  }

  /**
   * Abstract method — subclasses implement this to handle tasks.
   *
   * @param task - The task payload received from the inbox
   * @returns The task result to publish to the outbox
   */
  abstract process(task: TaskPayloadEvent): Promise<TaskResultEvent>

  // ── Private ──────────────────────────────────────────────────────────

  /**
   * Listen on the agent's inbox queue using BRPOP.
   * Runs continuously until `this.running` is false.
   */
  private async listenInbox(): Promise<void> {
    const inboxKey = this.manifest.input_channel

    while (this.running) {
      try {
        // Block for 1 second, then loop to check running flag
        const payload = await this.bus.brpop(inboxKey, 1)
        if (!payload || !this.running) continue

        const task = payload as TaskPayloadEvent

        // Check concurrency
        if (this.currentTasks >= this.manifest.max_concurrent) {
          // Re-queue the task (put it back at the front)
          await this.bus.lpush(inboxKey, task)
          await new Promise((r) => setTimeout(r, 100))
          continue
        }

        // Process in background (don't block inbox listener)
        this.currentTasks++
        this.processTask(task)
          .catch(() => {})
          .finally(() => {
            this.currentTasks--
          })
      } catch {
        // Connection error — wait and retry
        if (this.running) {
          await new Promise((r) => setTimeout(r, 500))
        }
      }
    }
  }

  /**
   * Process a single task with error handling.
   * Publishes the result (or error) to the outbox.
   */
  private async processTask(task: TaskPayloadEvent): Promise<void> {
    const replyTo = task.reply_to

    try {
      const result = await this.process(task)
      await this.bus.lpush(replyTo, result)
    } catch (error) {
      // Publish a failed result
      const failedResult: TaskResultEvent = {
        event: 'TASK_RESULT',
        task_id: task.task_id,
        session_id: task.session_id,
        status: 'failed',
        context_patch: {},
        error: error instanceof Error ? error.message : String(error),
        completed_at: Date.now(),
      }
      await this.bus.lpush(replyTo, failedResult)
    }
  }

  private async publishHeartbeat(): Promise<void> {
    const status: HeartbeatStatus =
      this.currentTasks >= this.manifest.max_concurrent
        ? 'busy'
        : this.currentTasks > 0
          ? 'idle'
          : 'idle'

    await this.bus.publish('bus:HEARTBEAT', {
      event: 'HEARTBEAT' as const,
      agent_id: this.manifest.agent_id,
      status,
      current_tasks: this.currentTasks,
      max_tasks: this.manifest.max_concurrent,
      timestamp: Date.now(),
    })
  }
}
