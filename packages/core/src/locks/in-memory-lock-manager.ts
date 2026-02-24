import type { ILockManager, LockValue, OnLockExpired } from './types.js'

/**
 * In-memory implementation of ILockManager.
 *
 * Locks are stored in a Map with automatic TTL expiry tracked manually
 * (expired locks are cleanup on access or by the watchdog). Suitable
 * for testing and single-node deployments.
 *
 * In production, use a Redis-backed implementation with `SET NX PX`
 * for true distributed locking.
 *
 * @example
 * ```typescript
 * const locks = new InMemoryLockManager()
 * const acquired = await locks.acquire('task_1', 'agent_A', 5000)
 * console.log(acquired) // true
 * ```
 */
export class InMemoryLockManager implements ILockManager {
  private locks: Map<string, LockValue> = new Map()
  private watchdogTimer: ReturnType<typeof setInterval> | null = null

  // ── Core API ──────────────────────────────────────────────────────────

  async acquire(taskId: string, agentId: string, ttlMs: number): Promise<boolean> {
    // Clean up expired lock if present
    this.evictIfExpired(taskId)

    // If already locked by someone, deny
    if (this.locks.has(taskId)) {
      return false
    }

    const now = Date.now()
    this.locks.set(taskId, {
      taskId,
      agentId,
      acquiredAt: now,
      expiresAt: now + ttlMs,
    })

    return true
  }

  async release(taskId: string, agentId: string): Promise<void> {
    const lock = this.locks.get(taskId)
    if (!lock) return

    // Only the owner can release
    if (lock.agentId === agentId) {
      this.locks.delete(taskId)
    }
  }

  async releaseAll(agentId: string): Promise<void> {
    const toDelete: string[] = []

    for (const [taskId, lock] of this.locks.entries()) {
      if (lock.agentId === agentId) {
        toDelete.push(taskId)
      }
    }

    for (const taskId of toDelete) {
      this.locks.delete(taskId)
    }
  }

  async get(taskId: string): Promise<LockValue | null> {
    this.evictIfExpired(taskId)
    return this.locks.get(taskId) ?? null
  }

  async isLocked(taskId: string): Promise<boolean> {
    this.evictIfExpired(taskId)
    return this.locks.has(taskId)
  }

  // ── Watchdog ──────────────────────────────────────────────────────────

  startWatchdog(intervalMs: number, onExpired: OnLockExpired): void {
    // Stop any existing watchdog
    this.stopWatchdog()

    this.watchdogTimer = setInterval(() => {
      this.scanExpired(onExpired)
    }, intervalMs)

    // Don't prevent process exit
    if (typeof this.watchdogTimer === 'object' && 'unref' in this.watchdogTimer) {
      this.watchdogTimer.unref()
    }
  }

  stopWatchdog(): void {
    if (this.watchdogTimer !== null) {
      clearInterval(this.watchdogTimer)
      this.watchdogTimer = null
    }
  }

  // ── Cleanup ───────────────────────────────────────────────────────────

  /**
   * Dispose all locks and stop the watchdog.
   * Call in test teardown to prevent leaked handles.
   */
  dispose(): void {
    this.stopWatchdog()
    this.locks.clear()
  }

  // ── Private ───────────────────────────────────────────────────────────

  private evictIfExpired(taskId: string): void {
    const lock = this.locks.get(taskId)
    if (lock && Date.now() >= lock.expiresAt) {
      this.locks.delete(taskId)
    }
  }

  private scanExpired(onExpired: OnLockExpired): void {
    const now = Date.now()
    const expired: LockValue[] = []

    for (const lock of this.locks.values()) {
      if (now >= lock.expiresAt) {
        expired.push(lock)
      }
    }

    for (const lock of expired) {
      this.locks.delete(lock.taskId)
      // Fire callback — intentionally catch errors to not break the watchdog
      try {
        const result = onExpired(lock)
        if (result instanceof Promise) {
          result.catch(() => {
            /* swallow async errors in watchdog callback */
          })
        }
      } catch {
        /* swallow sync errors in watchdog callback */
      }
    }
  }
}
