import type { IEventBus, BusHandler } from '../types/index.js'

/**
 * StreamAgent — base class for agents that live on the event bus.
 *
 * Provides a clean, stream-oriented lifecycle:
 * - subscribe/unsubscribe to bus channels
 * - start/stop/dispose lifecycle
 * - configurable heartbeat
 *
 * Subclasses implement `onEvent()` to handle incoming messages.
 *
 * @example
 * ```typescript
 * class MyAgent extends StreamAgent {
 *   protected channels = ['bus:SPEECH_FINAL']
 *
 *   async onEvent(channel: string, payload: unknown): Promise<void> {
 *     // handle event
 *   }
 * }
 * ```
 */
export abstract class StreamAgent {
  protected readonly bus: IEventBus
  private subscriptions: Array<() => void> = []
  private heartbeatTimer: ReturnType<typeof setInterval> | null = null
  private started = false

  constructor(bus: IEventBus) {
    this.bus = bus
  }

  /**
   * Channels this agent listens on. Override in subclass.
   */
  protected abstract get channels(): string[]

  /**
   * Handle an incoming event from one of the subscribed channels.
   */
  abstract onEvent(channel: string, payload: unknown): Promise<void>

  /**
   * Start the agent — subscribes to all configured channels.
   */
  async start(): Promise<void> {
    if (this.started) return
    this.started = true

    for (const channel of this.channels) {
      const handler: BusHandler = (data) => {
        this.onEvent(channel, data).catch(() => {})
      }
      const unsub = this.bus.subscribe(channel, handler)
      this.subscriptions.push(unsub)
    }
  }

  /**
   * Stop the agent — unsubscribe from all channels and stop heartbeat.
   */
  async stop(): Promise<void> {
    if (!this.started) return
    this.started = false

    for (const unsub of this.subscriptions) {
      unsub()
    }
    this.subscriptions = []

    if (this.heartbeatTimer) {
      clearInterval(this.heartbeatTimer)
      this.heartbeatTimer = null
    }
  }

  /**
   * Dispose — stop + full cleanup.
   */
  dispose(): void {
    this.stop().catch(() => {})
  }

  /**
   * Start publishing heartbeats at the given interval.
   */
  protected publishHeartbeat(intervalMs: number): void {
    if (this.heartbeatTimer) {
      clearInterval(this.heartbeatTimer)
    }

    this.heartbeatTimer = setInterval(async () => {
      await this.bus.publish('bus:HEARTBEAT', {
        event: 'HEARTBEAT' as const,
        agent_id: this.constructor.name,
        status: 'idle',
        current_tasks: 0,
        max_tasks: 1,
        timestamp: Date.now(),
      })
    }, intervalMs)

    if (typeof this.heartbeatTimer === 'object' && 'unref' in this.heartbeatTimer) {
      this.heartbeatTimer.unref()
    }
  }
}
