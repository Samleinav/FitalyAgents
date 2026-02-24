// ── Lock types ──────────────────────────────────────────────────────────────

/**
 * Represents a currently held lock.
 */
export interface LockValue {
  /** The task ID that is locked */
  taskId: string
  /** The agent ID that holds the lock */
  agentId: string
  /** When the lock was acquired (ms since epoch) */
  acquiredAt: number
  /** When the lock expires (ms since epoch) */
  expiresAt: number
}

/**
 * Callback invoked by the watchdog when an expired lock is detected.
 * Used to re-enqueue the task or perform other recovery actions.
 */
export type OnLockExpired = (lock: LockValue) => void | Promise<void>

/**
 * Interface for distributed lock management.
 *
 * Ensures that at most one agent can claim a given task at a time.
 * Implementations can be backed by in-memory Maps (testing) or
 * Redis SET NX PX (production).
 */
export interface ILockManager {
  /**
   * Attempt to acquire a lock on a task.
   * Returns `true` if the lock was acquired, `false` if already held.
   *
   * @param taskId  - The task to lock
   * @param agentId - The agent requesting the lock
   * @param ttlMs   - Lock time-to-live in milliseconds
   */
  acquire(taskId: string, agentId: string, ttlMs: number): Promise<boolean>

  /**
   * Release a lock, but only if the specified agent is the current owner.
   * No-op if the lock doesn't exist or belongs to a different agent.
   */
  release(taskId: string, agentId: string): Promise<void>

  /**
   * Release ALL locks held by a specific agent.
   * Used for crash recovery / agent timeout cleanup.
   */
  releaseAll(agentId: string): Promise<void>

  /**
   * Get the current lock info for a task, or null if unlocked.
   */
  get(taskId: string): Promise<LockValue | null>

  /**
   * Check whether a task is currently locked.
   */
  isLocked(taskId: string): Promise<boolean>

  /**
   * Start a watchdog that periodically scans for expired locks.
   * When an expired lock is found, it is released and `onExpired` is called.
   *
   * @param intervalMs - How often to scan (default: 1000ms)
   * @param onExpired  - Callback for each expired lock
   */
  startWatchdog(intervalMs: number, onExpired: OnLockExpired): void

  /**
   * Stop the watchdog timer.
   */
  stopWatchdog(): void
}
