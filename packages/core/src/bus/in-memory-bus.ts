import type { IEventBus, BusHandler, PatternBusHandler, Unsubscribe } from '../types/index.js'

/**
 * In-memory implementation of IEventBus for testing.
 *
 * Simulates Redis pub/sub and list operations entirely in-memory.
 * Pattern subscriptions use simple glob matching (supports `*`).
 *
 * @example
 * ```typescript
 * const bus = new InMemoryBus()
 * const unsub = bus.subscribe('bus:HEARTBEAT', (data) => console.log(data))
 * await bus.publish('bus:HEARTBEAT', { event: 'HEARTBEAT', agent_id: 'a1' })
 * unsub()
 * ```
 */
export class InMemoryBus implements IEventBus {
  private handlers: Map<string, Set<BusHandler>> = new Map()
  private patternHandlers: Map<string, Set<PatternBusHandler>> = new Map()
  private queues: Map<string, unknown[]> = new Map()
  private queueWaiters: Map<string, Array<(value: unknown | null) => void>> = new Map()

  async publish(channel: string, payload: unknown): Promise<void> {
    // Exact channel subscribers
    const channelHandlers = this.handlers.get(channel)
    if (channelHandlers) {
      for (const handler of channelHandlers) {
        handler(payload)
      }
    }

    // Pattern subscribers
    for (const [pattern, pHandlers] of this.patternHandlers) {
      if (this.matchPattern(pattern, channel)) {
        for (const handler of pHandlers) {
          handler(channel, payload)
        }
      }
    }
  }

  subscribe(channel: string, handler: BusHandler): Unsubscribe {
    if (!this.handlers.has(channel)) {
      this.handlers.set(channel, new Set())
    }
    this.handlers.get(channel)!.add(handler)

    return () => {
      const set = this.handlers.get(channel)
      if (set) {
        set.delete(handler)
        if (set.size === 0) this.handlers.delete(channel)
      }
    }
  }

  psubscribe(pattern: string, handler: PatternBusHandler): Unsubscribe {
    if (!this.patternHandlers.has(pattern)) {
      this.patternHandlers.set(pattern, new Set())
    }
    this.patternHandlers.get(pattern)!.add(handler)

    return () => {
      const set = this.patternHandlers.get(pattern)
      if (set) {
        set.delete(handler)
        if (set.size === 0) this.patternHandlers.delete(pattern)
      }
    }
  }

  async lpush(key: string, payload: unknown): Promise<void> {
    // Check if there's a waiter for this queue
    const waiters = this.queueWaiters.get(key)
    if (waiters && waiters.length > 0) {
      const resolve = waiters.shift()!
      if (waiters.length === 0) this.queueWaiters.delete(key)
      resolve(payload)
      return
    }

    // Otherwise push to the queue
    if (!this.queues.has(key)) {
      this.queues.set(key, [])
    }
    this.queues.get(key)!.push(payload)
  }

  async brpop(key: string, timeoutSeconds: number): Promise<unknown | null> {
    // Check if there's already something in the queue
    const queue = this.queues.get(key)
    if (queue && queue.length > 0) {
      return queue.shift()!
    }

    // Wait for an item or timeout
    return new Promise<unknown | null>((resolve) => {
      if (!this.queueWaiters.has(key)) {
        this.queueWaiters.set(key, [])
      }
      this.queueWaiters.get(key)!.push(resolve)

      const timer = setTimeout(() => {
        const waiters = this.queueWaiters.get(key)
        if (waiters) {
          const idx = waiters.indexOf(resolve)
          if (idx !== -1) {
            waiters.splice(idx, 1)
            if (waiters.length === 0) this.queueWaiters.delete(key)
            resolve(null)
          }
        }
      }, timeoutSeconds * 1000)

      if (typeof timer === 'object' && 'unref' in timer) {
        timer.unref()
      }
    })
  }

  async disconnect(): Promise<void> {
    this.handlers.clear()
    this.patternHandlers.clear()
    this.queues.clear()
    // Resolve all pending waiters with null
    for (const [, waiters] of this.queueWaiters) {
      for (const resolve of waiters) {
        resolve(null)
      }
    }
    this.queueWaiters.clear()
  }

  // ── Private ──────────────────────────────────────────────────────────

  /**
   * Simple glob pattern matching for psubscribe.
   * Only supports `*` as a wildcard.
   */
  private matchPattern(pattern: string, channel: string): boolean {
    const regex = new RegExp(
      '^' + pattern.replace(/[.+^${}()|[\]\\]/g, '\\$&').replace(/\*/g, '.*') + '$',
    )
    return regex.test(channel)
  }
}
