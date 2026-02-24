import type { ILockManager } from '../locks/types.js'
import type { IEventBus } from '../types/index.js'

// ── Task lifecycle statuses ─────────────────────────────────────────────────

/**
 * Internal task lifecycle statuses used by the TaskQueue state machine.
 *
 * Lifecycle: AVAILABLE → LOCKED → RUNNING → COMPLETED | FAILED | TIMED_OUT
 *                                        → WAITING_HUMAN → COMPLETED | FAILED
 *            AVAILABLE → CANCELLED (only before RUNNING)
 */
export type QueueTaskStatus =
  | 'AVAILABLE'
  | 'LOCKED'
  | 'RUNNING'
  | 'COMPLETED'
  | 'FAILED'
  | 'CANCELLED'
  | 'TIMED_OUT'
  | 'WAITING_HUMAN'

// ── Task input & task ────────────────────────────────────────────────────────

/**
 * Input for publishing a new task to the queue.
 */
export interface TaskInput {
  /** Unique task identifier */
  taskId: string
  /** Session this task belongs to */
  sessionId: string
  /** Intent that triggered this task (e.g. 'SEARCH', 'BOOK_FLIGHT') */
  intentId: string
  /** Slot values for the intent */
  slots: Record<string, unknown>
  /** Context snapshot at publish time */
  contextSnapshot: Record<string, unknown>
  /** Priority (0–10, higher = more important) */
  priority: number
  /** Timeout in milliseconds */
  timeoutMs: number
  /** Cancel token for this task (null if not cancellable) */
  cancelToken?: string | null
  /** Channel to send results to */
  replyTo: string
  /** Task IDs that must complete before this one can run */
  dependsOn?: string[]
}

/**
 * A task in the queue with its full state.
 */
export interface Task {
  /** Unique task identifier */
  taskId: string
  /** Session this task belongs to */
  sessionId: string
  /** Intent that triggered this task */
  intentId: string
  /** Slot values for the intent */
  slots: Record<string, unknown>
  /** Context snapshot at publish time */
  contextSnapshot: Record<string, unknown>
  /** Priority (0–10) */
  priority: number
  /** Timeout in milliseconds */
  timeoutMs: number
  /** Cancel token */
  cancelToken: string | null
  /** Channel to send results to */
  replyTo: string
  /** Current status in the lifecycle */
  status: QueueTaskStatus
  /** Agent that currently holds the lock (null if unclaimed) */
  claimedBy: string | null
  /** When the task was created (ms since epoch) */
  createdAt: number
  /** When the task started running (ms since epoch) */
  startedAt: number | null
  /** When the task completed/failed (ms since epoch) */
  finishedAt: number | null
  /** Result data (set on complete) */
  result?: unknown
  /** Error message (set on fail) */
  error?: string
  /** Task IDs that must complete before this one */
  dependsOn: string[]
}

// ── TaskQueue interface ─────────────────────────────────────────────────────

/**
 * Interface for task lifecycle management and orchestration.
 *
 * Manages the full task lifecycle from publication through completion,
 * integrating with LockManager for mutual exclusion and IEventBus
 * for event-driven communication.
 */
export interface ITaskQueue {
  /**
   * Publish a new task → status: AVAILABLE
   * Emits TASK_AVAILABLE event on the bus.
   */
  publish(input: TaskInput): Promise<Task>

  /**
   * An agent claims a task → status: LOCKED
   * Acquires a lock via LockManager.
   * Returns null if the task doesn't exist, isn't AVAILABLE, or lock fails.
   */
  claim(agentId: string, taskId: string): Promise<Task | null>

  /**
   * Mark a claimed task as running → status: RUNNING
   */
  start(taskId: string): Promise<void>

  /**
   * Mark a task as completed → status: COMPLETED
   * Releases the lock and publishes dependents.
   */
  complete(taskId: string, result: unknown): Promise<void>

  /**
   * Mark a task as failed → status: FAILED
   * Releases the lock.
   */
  fail(taskId: string, error: string): Promise<void>

  /**
   * Cancel a task → status: CANCELLED (only if pre-RUNNING)
   * Returns false if the task is already RUNNING or beyond.
   */
  cancel(taskId: string, cancelToken: string): Promise<boolean>

  /**
   * Mark a task as timed out → status: TIMED_OUT
   * Releases the lock and re-publishes the task as AVAILABLE.
   */
  timeout(taskId: string): Promise<void>

  /**
   * Pause a task for human approval → status: WAITING_HUMAN
   */
  waitHumanApproval(taskId: string): Promise<void>

  /**
   * Publish dependent tasks that were waiting on a completed task.
   */
  publishDependents(completedTaskId: string): Promise<void>

  /**
   * Get the current status of a task.
   */
  getStatus(taskId: string): Promise<QueueTaskStatus | null>

  /**
   * Get a task by ID.
   */
  getTask(taskId: string): Promise<Task | null>
}

/**
 * Dependencies for constructing a TaskQueue.
 */
export interface TaskQueueDeps {
  lockManager: ILockManager
  bus: IEventBus
}
