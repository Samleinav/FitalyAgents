import Redis from 'ioredis'
import type {
  IEventBus,
  BusHandler,
  PatternBusHandler,
  Unsubscribe,
  BusOptions,
} from '../types/index.js'

/**
 * Redis-backed implementation of IEventBus using ioredis.
 *
 * Uses separate connections for publishing and subscribing (required by Redis).
 * Supports both pub/sub channels and list-based queues (LPUSH/BRPOP).
 *
 * @example
 * ```typescript
 * const bus = new RedisBus({ redisUrl: 'redis://localhost:6379' })
 * bus.subscribe('bus:HEARTBEAT', (data) => console.log(data))
 * await bus.publish('bus:HEARTBEAT', { event: 'HEARTBEAT', agent_id: 'a1' })
 * await bus.disconnect()
 * ```
 */
export class RedisBus implements IEventBus {
  private pub: Redis
  private sub: Redis
  private cmd: Redis // For LPUSH/BRPOP and general commands

  private channelHandlers: Map<string, Set<BusHandler>> = new Map()
  private patternHandlerMap: Map<string, Set<PatternBusHandler>> = new Map()

  constructor(options: BusOptions) {
    const url = options.redisUrl ?? 'redis://localhost:6379'
    this.pub = new Redis(url, { lazyConnect: true, maxRetriesPerRequest: 3 })
    this.sub = new Redis(url, { lazyConnect: true, maxRetriesPerRequest: 3 })
    this.cmd = new Redis(url, { lazyConnect: true, maxRetriesPerRequest: 3 })

    // Wire up ioredis message events to our handlers
    this.sub.on('message', (channel: string, message: string) => {
      const handlers = this.channelHandlers.get(channel)
      if (!handlers) return
      try {
        const data = JSON.parse(message)
        for (const handler of handlers) {
          void Promise.resolve(handler(data)).catch(() => {})
        }
      } catch {
        // Ignore malformed messages
      }
    })

    this.sub.on('pmessage', (pattern: string, channel: string, message: string) => {
      const handlers = this.patternHandlerMap.get(pattern)
      if (!handlers) return
      try {
        const data = JSON.parse(message)
        for (const handler of handlers) {
          void Promise.resolve(handler(channel, data)).catch(() => {})
        }
      } catch {
        // Ignore malformed messages
      }
    })
  }

  /**
   * Connect all Redis clients. Must be called before using the bus.
   */
  async connect(): Promise<void> {
    await Promise.all([this.pub.connect(), this.sub.connect(), this.cmd.connect()])
  }

  async publish(channel: string, payload: unknown): Promise<void> {
    await this.pub.publish(channel, JSON.stringify(payload))
  }

  subscribe(channel: string, handler: BusHandler): Unsubscribe {
    if (!this.channelHandlers.has(channel)) {
      this.channelHandlers.set(channel, new Set())
      // Subscribe on the Redis sub client (fire-and-forget)
      this.sub.subscribe(channel).catch(() => {
        /* reconnection will resubscribe */
      })
    }
    this.channelHandlers.get(channel)!.add(handler)

    return () => {
      const set = this.channelHandlers.get(channel)
      if (set) {
        set.delete(handler)
        if (set.size === 0) {
          this.channelHandlers.delete(channel)
          this.sub.unsubscribe(channel).catch(() => {})
        }
      }
    }
  }

  psubscribe(pattern: string, handler: PatternBusHandler): Unsubscribe {
    if (!this.patternHandlerMap.has(pattern)) {
      this.patternHandlerMap.set(pattern, new Set())
      this.sub.psubscribe(pattern).catch(() => {})
    }
    this.patternHandlerMap.get(pattern)!.add(handler)

    return () => {
      const set = this.patternHandlerMap.get(pattern)
      if (set) {
        set.delete(handler)
        if (set.size === 0) {
          this.patternHandlerMap.delete(pattern)
          this.sub.punsubscribe(pattern).catch(() => {})
        }
      }
    }
  }

  async lpush(key: string, payload: unknown): Promise<void> {
    await this.cmd.lpush(key, JSON.stringify(payload))
  }

  async brpop(key: string, timeoutSeconds: number): Promise<unknown | null> {
    const result = await this.cmd.brpop(key, timeoutSeconds)
    if (!result) return null
    // brpop returns [key, value]
    try {
      return JSON.parse(result[1])
    } catch {
      return result[1]
    }
  }

  async disconnect(): Promise<void> {
    this.channelHandlers.clear()
    this.patternHandlerMap.clear()
    await Promise.all([
      this.pub.quit().catch(() => {}),
      this.sub.quit().catch(() => {}),
      this.cmd.quit().catch(() => {}),
    ])
  }
}

/**
 * Factory function to create a bus instance.
 *
 * @param options - Bus configuration. If `redisUrl` is provided, creates a RedisBus.
 *                  Otherwise creates an InMemoryBus.
 */
export async function createBus(options?: BusOptions): Promise<IEventBus> {
  if (options?.redisUrl) {
    const bus = new RedisBus(options)
    await bus.connect()
    return bus
  }
  // Lazy import to avoid loading InMemoryBus when RedisBus is used
  const { InMemoryBus } = await import('./in-memory-bus.js')
  return new InMemoryBus()
}
