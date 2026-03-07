import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest'
import { RateLimiter } from './rate-limiter.js'

describe('RateLimiter', () => {
  beforeEach(() => {
    vi.useFakeTimers()
  })

  afterEach(() => {
    vi.useRealTimers()
  })

  it('allows requests up to the limit', () => {
    const limiter = new RateLimiter({ requests_per_second: 3 })
    expect(limiter.tryAcquire()).toBe(true)
    expect(limiter.tryAcquire()).toBe(true)
    expect(limiter.tryAcquire()).toBe(true)
    expect(limiter.tryAcquire()).toBe(false) // 4th exceeds limit
  })

  it('resets after the sliding window passes', () => {
    const limiter = new RateLimiter({ requests_per_second: 2 })
    const t0 = Date.now()
    expect(limiter.tryAcquire(t0)).toBe(true)
    expect(limiter.tryAcquire(t0)).toBe(true)
    expect(limiter.tryAcquire(t0)).toBe(false)

    // Advance 1001ms — both timestamps are now outside the window
    const t1 = t0 + 1001
    expect(limiter.tryAcquire(t1)).toBe(true)
    expect(limiter.tryAcquire(t1)).toBe(true)
    expect(limiter.tryAcquire(t1)).toBe(false)
  })

  it('sliding window is accurate (partial reset)', () => {
    const limiter = new RateLimiter({ requests_per_second: 2 })
    const t0 = 1000
    expect(limiter.tryAcquire(t0)).toBe(true) // at 1000

    const t1 = 1500
    expect(limiter.tryAcquire(t1)).toBe(true) // at 1500 — 2nd slot used

    // At t=2001: t0=1000 is evicted (> 1000ms ago), t1=1500 still in window
    const t2 = 2001
    expect(limiter.tryAcquire(t2)).toBe(true) // slot freed by t0 eviction
    expect(limiter.tryAcquire(t2)).toBe(false) // t1 + t2 fill window
  })

  it('exposes limit and currentCount', () => {
    const limiter = new RateLimiter({ requests_per_second: 5 })
    expect(limiter.limit).toBe(5)
    limiter.tryAcquire()
    limiter.tryAcquire()
    expect(limiter.currentCount).toBe(2)
  })

  it('single request per second limit works', () => {
    const limiter = new RateLimiter({ requests_per_second: 1 })
    const t0 = Date.now()
    expect(limiter.tryAcquire(t0)).toBe(true)
    expect(limiter.tryAcquire(t0 + 1)).toBe(false)
    expect(limiter.tryAcquire(t0 + 1001)).toBe(true)
  })
})
