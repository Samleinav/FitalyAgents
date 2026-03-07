import type { CircuitBreakerConfig } from '../types/index.js'

export type CircuitState = 'CLOSED' | 'OPEN' | 'HALF_OPEN'

export interface CircuitBreakerCallbacks {
  /** Called when the circuit opens (tool disabled). */
  onOpen?: (toolId: string, failures: number) => void
  /** Called when the circuit closes (tool re-enabled). */
  onClose?: (toolId: string) => void
}

/**
 * Circuit breaker — three-state FSM per tool.
 *
 * - **CLOSED** (normal): requests pass through, failures counted.
 * - **OPEN** (tripped): all requests rejected immediately until `reset_timeout_ms` elapses.
 * - **HALF_OPEN** (probe): one request allowed through; success → CLOSED, failure → OPEN.
 *
 * @example
 * ```typescript
 * const cb = new CircuitBreaker('search', { failure_threshold: 5, reset_timeout_ms: 30_000 }, {
 *   onOpen: (id, n) => console.log(`Circuit ${id} opened after ${n} failures`),
 *   onClose: (id) => console.log(`Circuit ${id} closed`),
 * })
 *
 * if (!cb.allowRequest()) return { status: 'circuit_open' }
 *
 * try {
 *   const result = await executeRequest()
 *   cb.recordSuccess()
 *   return result
 * } catch (err) {
 *   cb.recordFailure()
 *   throw err
 * }
 * ```
 */
export class CircuitBreaker {
  private state: CircuitState = 'CLOSED'
  private consecutiveFailures = 0
  private openedAt: number | null = null

  private readonly threshold: number
  private readonly resetTimeoutMs: number
  private readonly callbacks: CircuitBreakerCallbacks

  constructor(
    private readonly toolId: string,
    config: CircuitBreakerConfig,
    callbacks: CircuitBreakerCallbacks = {},
  ) {
    this.threshold = config.failure_threshold
    this.resetTimeoutMs = config.reset_timeout_ms
    this.callbacks = callbacks
  }

  /**
   * Returns `true` if the request should be allowed through, `false` if the circuit is open.
   */
  allowRequest(now = Date.now()): boolean {
    if (this.state === 'CLOSED') return true

    if (this.state === 'OPEN') {
      if (this.openedAt !== null && now - this.openedAt >= this.resetTimeoutMs) {
        this.state = 'HALF_OPEN'
        return true // probe request
      }
      return false
    }

    // HALF_OPEN — only one probe allowed at a time
    return true
  }

  /** Record a successful execution. May close an open circuit. */
  recordSuccess(): void {
    this.consecutiveFailures = 0
    if (this.state === 'HALF_OPEN') {
      this.state = 'CLOSED'
      this.openedAt = null
      this.callbacks.onClose?.(this.toolId)
    }
  }

  /** Record a failed execution. May open the circuit. */
  recordFailure(now = Date.now()): void {
    this.consecutiveFailures++

    if (this.state === 'HALF_OPEN') {
      // Probe failed — back to OPEN, reset timer
      this.state = 'OPEN'
      this.openedAt = now
      this.callbacks.onOpen?.(this.toolId, this.consecutiveFailures)
      return
    }

    if (this.state === 'CLOSED' && this.consecutiveFailures >= this.threshold) {
      this.state = 'OPEN'
      this.openedAt = now
      this.callbacks.onOpen?.(this.toolId, this.consecutiveFailures)
    }
  }

  get currentState(): CircuitState {
    return this.state
  }

  get failureCount(): number {
    return this.consecutiveFailures
  }
}
