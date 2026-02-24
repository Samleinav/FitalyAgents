import type { ITaskQueue, Task, TaskInput, QueueTaskStatus, TaskQueueDeps } from './types.js'

/**
 * In-memory implementation of ITaskQueue.
 *
 * Manages the full task lifecycle integrating with LockManager for
 * mutual exclusion and IEventBus for event publishing. Uses a Map
 * for task storage and priority-based ordering.
 *
 * @example
 * ```typescript
 * const queue = new InMemoryTaskQueue({ lockManager: locks, bus })
 * const task = await queue.publish({ taskId: 't1', ... })
 * const claimed = await queue.claim('agent_A', 't1')
 * await queue.start('t1')
 * await queue.complete('t1', { data: 'result' })
 * ```
 */
export class InMemoryTaskQueue implements ITaskQueue {
  private tasks: Map<string, Task> = new Map()
  private readonly lockManager: TaskQueueDeps['lockManager']
  private readonly bus: TaskQueueDeps['bus']

  constructor(deps: TaskQueueDeps) {
    this.lockManager = deps.lockManager
    this.bus = deps.bus
  }

  // ── Publish ─────────────────────────────────────────────────────────────

  async publish(input: TaskInput): Promise<Task> {
    // Check if dependencies are all completed
    const blocked = this.hasPendingDependencies(input.dependsOn ?? [])

    const task: Task = {
      taskId: input.taskId,
      sessionId: input.sessionId,
      intentId: input.intentId,
      slots: input.slots,
      contextSnapshot: input.contextSnapshot,
      priority: input.priority,
      timeoutMs: input.timeoutMs,
      cancelToken: input.cancelToken ?? null,
      replyTo: input.replyTo,
      status: blocked ? 'LOCKED' : 'AVAILABLE',
      claimedBy: null,
      createdAt: Date.now(),
      startedAt: null,
      finishedAt: null,
      dependsOn: input.dependsOn ?? [],
    }

    this.tasks.set(task.taskId, task)

    if (!blocked) {
      await this.bus.publish('bus:TASK_AVAILABLE', {
        event: 'TASK_AVAILABLE',
        task_id: task.taskId,
        session_id: task.sessionId,
        intent_id: task.intentId,
        priority: task.priority,
      })
    }

    return { ...task }
  }

  // ── Claim ───────────────────────────────────────────────────────────────

  async claim(agentId: string, taskId: string): Promise<Task | null> {
    const task = this.tasks.get(taskId)
    if (!task || task.status !== 'AVAILABLE') {
      return null
    }

    // Attempt to acquire lock
    const acquired = await this.lockManager.acquire(taskId, agentId, task.timeoutMs)
    if (!acquired) {
      return null
    }

    task.status = 'LOCKED'
    task.claimedBy = agentId

    await this.bus.publish('bus:TASK_LOCKED', {
      event: 'TASK_LOCKED',
      task_id: taskId,
      agent_id: agentId,
    })

    return { ...task }
  }

  // ── Start ───────────────────────────────────────────────────────────────

  async start(taskId: string): Promise<void> {
    const task = this.tasks.get(taskId)
    if (!task) throw new Error(`Task not found: "${taskId}"`)
    if (task.status !== 'LOCKED') {
      throw new Error(`Cannot start task "${taskId}" in status "${task.status}" (expected LOCKED)`)
    }

    task.status = 'RUNNING'
    task.startedAt = Date.now()

    await this.bus.publish('bus:TASK_RUNNING', {
      event: 'TASK_RUNNING',
      task_id: taskId,
      agent_id: task.claimedBy,
    })
  }

  // ── Complete ────────────────────────────────────────────────────────────

  async complete(taskId: string, result: unknown): Promise<void> {
    const task = this.tasks.get(taskId)
    if (!task) throw new Error(`Task not found: "${taskId}"`)
    if (task.status !== 'RUNNING' && task.status !== 'WAITING_HUMAN') {
      throw new Error(
        `Cannot complete task "${taskId}" in status "${task.status}" (expected RUNNING or WAITING_HUMAN)`,
      )
    }

    task.status = 'COMPLETED'
    task.result = result
    task.finishedAt = Date.now()

    // Release the lock
    if (task.claimedBy) {
      await this.lockManager.release(taskId, task.claimedBy)
    }

    await this.bus.publish('bus:TASK_COMPLETED', {
      event: 'TASK_COMPLETED',
      task_id: taskId,
      session_id: task.sessionId,
      result,
    })

    // Unblock dependents
    await this.publishDependents(taskId)
  }

  // ── Fail ────────────────────────────────────────────────────────────────

  async fail(taskId: string, error: string): Promise<void> {
    const task = this.tasks.get(taskId)
    if (!task) throw new Error(`Task not found: "${taskId}"`)
    if (task.status !== 'RUNNING' && task.status !== 'WAITING_HUMAN') {
      throw new Error(
        `Cannot fail task "${taskId}" in status "${task.status}" (expected RUNNING or WAITING_HUMAN)`,
      )
    }

    task.status = 'FAILED'
    task.error = error
    task.finishedAt = Date.now()

    // Release the lock
    if (task.claimedBy) {
      await this.lockManager.release(taskId, task.claimedBy)
    }

    await this.bus.publish('bus:TASK_FAILED', {
      event: 'TASK_FAILED',
      task_id: taskId,
      session_id: task.sessionId,
      error,
    })
  }

  // ── Cancel ──────────────────────────────────────────────────────────────

  async cancel(taskId: string, cancelToken: string): Promise<boolean> {
    const task = this.tasks.get(taskId)
    if (!task) return false

    // Can only cancel before RUNNING
    if (task.status !== 'AVAILABLE' && task.status !== 'LOCKED') {
      return false
    }

    // Verify cancel token matches
    if (task.cancelToken !== cancelToken) {
      return false
    }

    task.status = 'CANCELLED'
    task.finishedAt = Date.now()

    // Release lock if held
    if (task.claimedBy) {
      await this.lockManager.release(taskId, task.claimedBy)
    }

    await this.bus.publish('bus:TASK_CANCELLED', {
      event: 'TASK_CANCELLED',
      task_id: taskId,
      session_id: task.sessionId,
    })

    return true
  }

  // ── Timeout ─────────────────────────────────────────────────────────────

  async timeout(taskId: string): Promise<void> {
    const task = this.tasks.get(taskId)
    if (!task) throw new Error(`Task not found: "${taskId}"`)

    task.status = 'TIMED_OUT'
    task.finishedAt = Date.now()

    // Release the lock
    if (task.claimedBy) {
      await this.lockManager.release(taskId, task.claimedBy)
    }

    await this.bus.publish('bus:TASK_TIMED_OUT', {
      event: 'TASK_TIMED_OUT',
      task_id: taskId,
      session_id: task.sessionId,
    })

    // Re-enqueue the task by creating a fresh copy
    task.status = 'AVAILABLE'
    task.claimedBy = null
    task.startedAt = null
    task.finishedAt = null
    task.error = undefined
    task.result = undefined

    await this.bus.publish('bus:TASK_AVAILABLE', {
      event: 'TASK_AVAILABLE',
      task_id: task.taskId,
      session_id: task.sessionId,
      intent_id: task.intentId,
      priority: task.priority,
    })
  }

  // ── Wait Human ──────────────────────────────────────────────────────────

  async waitHumanApproval(taskId: string): Promise<void> {
    const task = this.tasks.get(taskId)
    if (!task) throw new Error(`Task not found: "${taskId}"`)
    if (task.status !== 'RUNNING') {
      throw new Error(
        `Cannot wait for human approval on task "${taskId}" in status "${task.status}" (expected RUNNING)`,
      )
    }

    task.status = 'WAITING_HUMAN'

    await this.bus.publish('bus:TASK_WAITING_HUMAN', {
      event: 'TASK_WAITING_HUMAN',
      task_id: taskId,
      session_id: task.sessionId,
    })
  }

  // ── Dependents ──────────────────────────────────────────────────────────

  async publishDependents(completedTaskId: string): Promise<void> {
    for (const task of this.tasks.values()) {
      if (task.status !== 'LOCKED' || !task.dependsOn.includes(completedTaskId)) {
        continue
      }

      // Check if ALL dependencies are now completed
      const allDepsComplete = task.dependsOn.every((depId) => {
        const dep = this.tasks.get(depId)
        return dep?.status === 'COMPLETED'
      })

      if (allDepsComplete) {
        // Unblock: set to AVAILABLE and release artificial lock
        task.status = 'AVAILABLE'
        task.claimedBy = null

        await this.bus.publish('bus:TASK_AVAILABLE', {
          event: 'TASK_AVAILABLE',
          task_id: task.taskId,
          session_id: task.sessionId,
          intent_id: task.intentId,
          priority: task.priority,
        })
      }
    }
  }

  // ── Queries ─────────────────────────────────────────────────────────────

  async getStatus(taskId: string): Promise<QueueTaskStatus | null> {
    const task = this.tasks.get(taskId)
    return task?.status ?? null
  }

  async getTask(taskId: string): Promise<Task | null> {
    const task = this.tasks.get(taskId)
    return task ? { ...task } : null
  }

  // ── Cleanup ─────────────────────────────────────────────────────────────

  /**
   * Dispose all tasks. Call in test teardown.
   */
  dispose(): void {
    this.tasks.clear()
  }

  // ── Private ─────────────────────────────────────────────────────────────

  private hasPendingDependencies(dependsOn: string[]): boolean {
    if (dependsOn.length === 0) return false

    return dependsOn.some((depId) => {
      const dep = this.tasks.get(depId)
      return !dep || dep.status !== 'COMPLETED'
    })
  }
}
