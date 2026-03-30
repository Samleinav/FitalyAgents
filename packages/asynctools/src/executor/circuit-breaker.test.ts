import { describe, it, expect, vi } from 'vitest'
import { CircuitBreaker } from './circuit-breaker.js'

function makeCb(threshold = 3, resetMs = 5000) {
  const onOpen = vi.fn()
  const onClose = vi.fn()
  const cb = new CircuitBreaker(
    'test_tool',
    { failure_threshold: threshold, reset_timeout_ms: resetMs },
    { onOpen, onClose },
  )
  return { cb, onOpen, onClose }
}

describe('CircuitBreaker', () => {
  describe('CLOSED state', () => {
    it('starts CLOSED and allows all requests', () => {
      const { cb } = makeCb()
      expect(cb.currentState).toBe('CLOSED')
      expect(cb.allowRequest()).toBe(true)
    })

    it('counts failures and opens at threshold', () => {
      const { cb, onOpen } = makeCb(3)
      cb.recordFailure()
      cb.recordFailure()
      expect(cb.currentState).toBe('CLOSED')
      cb.recordFailure()
      expect(cb.currentState).toBe('OPEN')
      expect(onOpen).toHaveBeenCalledOnce()
      expect(onOpen).toHaveBeenCalledWith('test_tool', 3)
    })

    it('resets failure count on success', () => {
      const { cb } = makeCb(3)
      cb.recordFailure()
      cb.recordFailure()
      cb.recordSuccess()
      expect(cb.failureCount).toBe(0)
      expect(cb.currentState).toBe('CLOSED')
    })
  })

  describe('OPEN state', () => {
    it('blocks all requests when OPEN', () => {
      const { cb } = makeCb(1)
      cb.recordFailure() // opens circuit
      expect(cb.currentState).toBe('OPEN')
      expect(cb.allowRequest()).toBe(false)
    })

    it('transitions to HALF_OPEN after reset_timeout_ms', () => {
      const { cb } = makeCb(1, 1000)
      const t0 = Date.now()
      cb.recordFailure(t0)
      expect(cb.allowRequest(t0 + 999)).toBe(false)
      expect(cb.allowRequest(t0 + 1000)).toBe(true) // probe allowed
      expect(cb.currentState).toBe('HALF_OPEN')
    })
  })

  describe('HALF_OPEN state', () => {
    function openThenHalfOpen(threshold = 1, resetMs = 1000) {
      const { cb, onOpen, onClose } = makeCb(threshold, resetMs)
      const t0 = Date.now()
      for (let i = 0; i < threshold; i++) cb.recordFailure(t0)
      cb.allowRequest(t0 + resetMs) // advances to HALF_OPEN
      return { cb, onOpen, onClose, t0 }
    }

    it('closes on probe success', () => {
      const { cb, onClose } = openThenHalfOpen()
      cb.recordSuccess()
      expect(cb.currentState).toBe('CLOSED')
      expect(onClose).toHaveBeenCalledWith('test_tool')
    })

    it('allows only one in-flight probe at a time', () => {
      const { cb } = openThenHalfOpen()

      expect(cb.allowRequest()).toBe(false)

      cb.recordSuccess()
      expect(cb.allowRequest()).toBe(true)
    })

    it('re-opens on probe failure', () => {
      const { cb, onOpen } = openThenHalfOpen()
      cb.recordFailure()
      expect(cb.currentState).toBe('OPEN')
      expect(onOpen).toHaveBeenCalledTimes(2) // once original open, once re-open
    })
  })

  describe('callbacks', () => {
    it('onOpen callback receives toolId and failure count', () => {
      const { cb, onOpen } = makeCb(2)
      cb.recordFailure()
      cb.recordFailure()
      expect(onOpen).toHaveBeenCalledWith('test_tool', 2)
    })

    it('works without callbacks (no crash)', () => {
      const cb = new CircuitBreaker('t', { failure_threshold: 1, reset_timeout_ms: 1000 })
      cb.recordFailure()
      expect(cb.currentState).toBe('OPEN')
    })
  })
})
