import type { RateLimitConfig } from '../types/index.js'

/**
 * Sliding-window RateLimiter.
 *
 * Tracks request timestamps within the last 1-second window.
 * `tryAcquire()` returns `true` if the request is allowed, `false` if rate-limited.
 *
 * @example
 * ```typescript
 * const limiter = new RateLimiter({ requests_per_second: 10 })
 * if (!limiter.tryAcquire()) throw new Error('rate_limited')
 * ```
 */
export class RateLimiter {
  private readonly maxRps: number
  private readonly windowMs = 1000
  private timestamps: number[] = []

  constructor(config: RateLimitConfig) {
    this.maxRps = config.requests_per_second
  }

  /**
   * Attempt to acquire a slot. Returns `true` if allowed, `false` if rate-limited.
   */
  tryAcquire(now = Date.now()): boolean {
    const windowStart = now - this.windowMs

    // Evict timestamps outside the sliding window
    this.timestamps = this.timestamps.filter((t) => t > windowStart)

    if (this.timestamps.length >= this.maxRps) {
      return false
    }

    this.timestamps.push(now)
    return true
  }

  /** Number of requests in the current sliding window. */
  get currentCount(): number {
    const windowStart = Date.now() - this.windowMs
    return this.timestamps.filter((t) => t > windowStart).length
  }

  /** Maximum requests per second. */
  get limit(): number {
    return this.maxRps
  }
}
