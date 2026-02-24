import { describe, it, expect, beforeEach, afterEach } from 'vitest'
import { InMemoryTaskQueue } from './in-memory-task-queue.js'
import { InMemoryLockManager } from '../locks/in-memory-lock-manager.js'
import { InMemoryBus } from '../bus/in-memory-bus.js'
import type { TaskInput } from './types.js'

// ── Fixtures ────────────────────────────────────────────────────────────────

function makeInput(overrides: Partial<TaskInput> = {}): TaskInput {
  return {
    taskId: 'task_1',
    sessionId: 'sess_1',
    intentId: 'SEARCH',
    slots: { query: 'hotels in cancun' },
    contextSnapshot: { locale: 'es-MX' },
    priority: 5,
    timeoutMs: 10000,
    cancelToken: 'cancel_tok_1',
    replyTo: 'results:agent_test',
    ...overrides,
  }
}

// ── Tests ────────────────────────────────────────────────────────────────────

describe('InMemoryTaskQueue', () => {
  let queue: InMemoryTaskQueue
  let locks: InMemoryLockManager
  let bus: InMemoryBus

  beforeEach(() => {
    locks = new InMemoryLockManager()
    bus = new InMemoryBus()
    queue = new InMemoryTaskQueue({ lockManager: locks, bus })
  })

  afterEach(() => {
    queue.dispose()
    locks.dispose()
  })

  // ── Full lifecycle ────────────────────────────────────────────────────

  describe('full lifecycle: AVAILABLE → LOCKED → RUNNING → COMPLETED', () => {
    it('completes the full happy path', async () => {
      // 1. Publish
      const published = await queue.publish(makeInput())
      expect(published.status).toBe('AVAILABLE')
      expect(published.taskId).toBe('task_1')

      // 2. Claim
      const claimed = await queue.claim('agent_A', 'task_1')
      expect(claimed).not.toBeNull()
      expect(claimed!.status).toBe('LOCKED')
      expect(claimed!.claimedBy).toBe('agent_A')

      // Lock should be held
      expect(await locks.isLocked('task_1')).toBe(true)

      // 3. Start
      await queue.start('task_1')
      expect(await queue.getStatus('task_1')).toBe('RUNNING')

      // 4. Complete
      await queue.complete('task_1', { found: 3, hotels: ['A', 'B', 'C'] })
      expect(await queue.getStatus('task_1')).toBe('COMPLETED')

      const task = await queue.getTask('task_1')
      expect(task!.result).toEqual({ found: 3, hotels: ['A', 'B', 'C'] })
      expect(task!.finishedAt).not.toBeNull()

      // Lock should be released
      expect(await locks.isLocked('task_1')).toBe(false)
    })
  })

  // ── Publish ─────────────────────────────────────────────────────────────

  describe('publish', () => {
    it('publishes a task as AVAILABLE', async () => {
      const task = await queue.publish(makeInput())
      expect(task.status).toBe('AVAILABLE')
      expect(task.createdAt).toBeLessThanOrEqual(Date.now())
    })

    it('publishes TASK_AVAILABLE event on bus', async () => {
      const events: unknown[] = []
      bus.subscribe('bus:TASK_AVAILABLE', (data) => {
        events.push(data)
      })

      await queue.publish(makeInput())
      expect(events.length).toBe(1)
      expect(events[0]).toHaveProperty('task_id', 'task_1')
    })

    it('task with unmet dependencies starts as LOCKED (blocked)', async () => {
      // TaskB depends on TaskA which doesn't exist yet
      const taskB = await queue.publish(makeInput({ taskId: 'task_B', dependsOn: ['task_A'] }))
      expect(taskB.status).toBe('LOCKED')
    })
  })

  // ── Claim ───────────────────────────────────────────────────────────────

  describe('claim', () => {
    it('returns null for non-existent task', async () => {
      const result = await queue.claim('agent_A', 'ghost')
      expect(result).toBeNull()
    })

    it('returns null if task is not AVAILABLE', async () => {
      await queue.publish(makeInput())
      await queue.claim('agent_A', 'task_1') // Now LOCKED
      const result = await queue.claim('agent_B', 'task_1')
      expect(result).toBeNull()
    })

    it('agent_B cannot claim task already locked by agent_A', async () => {
      await queue.publish(makeInput())
      await queue.claim('agent_A', 'task_1')
      const result = await queue.claim('agent_B', 'task_1')
      expect(result).toBeNull()
    })
  })

  // ── Start ───────────────────────────────────────────────────────────────

  describe('start', () => {
    it('throws for non-existent task', async () => {
      await expect(queue.start('ghost')).rejects.toThrow('not found')
    })

    it('throws if task is not LOCKED', async () => {
      await queue.publish(makeInput())
      // Still AVAILABLE, not LOCKED
      await expect(queue.start('task_1')).rejects.toThrow('expected LOCKED')
    })
  })

  // ── Fail ────────────────────────────────────────────────────────────────

  describe('fail', () => {
    it('marks task as FAILED and releases lock', async () => {
      await queue.publish(makeInput())
      await queue.claim('agent_A', 'task_1')
      await queue.start('task_1')
      await queue.fail('task_1', 'provider_timeout')

      expect(await queue.getStatus('task_1')).toBe('FAILED')
      const task = await queue.getTask('task_1')
      expect(task!.error).toBe('provider_timeout')
      expect(await locks.isLocked('task_1')).toBe(false)
    })
  })

  // ── Cancel ──────────────────────────────────────────────────────────────

  describe('cancel', () => {
    it('cancels AVAILABLE task with correct token', async () => {
      await queue.publish(makeInput())
      const cancelled = await queue.cancel('task_1', 'cancel_tok_1')
      expect(cancelled).toBe(true)
      expect(await queue.getStatus('task_1')).toBe('CANCELLED')
    })

    it('cancels LOCKED task before RUNNING', async () => {
      await queue.publish(makeInput())
      await queue.claim('agent_A', 'task_1')
      const cancelled = await queue.cancel('task_1', 'cancel_tok_1')
      expect(cancelled).toBe(true)
      expect(await queue.getStatus('task_1')).toBe('CANCELLED')
      // Lock should be released
      expect(await locks.isLocked('task_1')).toBe(false)
    })

    it('CANNOT cancel RUNNING task', async () => {
      await queue.publish(makeInput())
      await queue.claim('agent_A', 'task_1')
      await queue.start('task_1')
      const cancelled = await queue.cancel('task_1', 'cancel_tok_1')
      expect(cancelled).toBe(false)
      expect(await queue.getStatus('task_1')).toBe('RUNNING')
    })

    it('CANNOT cancel with wrong token', async () => {
      await queue.publish(makeInput())
      const cancelled = await queue.cancel('task_1', 'wrong_token')
      expect(cancelled).toBe(false)
      expect(await queue.getStatus('task_1')).toBe('AVAILABLE')
    })

    it('returns false for non-existent task', async () => {
      const cancelled = await queue.cancel('ghost', 'tok')
      expect(cancelled).toBe(false)
    })
  })

  // ── Timeout ─────────────────────────────────────────────────────────────

  describe('timeout', () => {
    it('marks task as timed out then re-enqueues as AVAILABLE', async () => {
      await queue.publish(makeInput())
      await queue.claim('agent_A', 'task_1')
      await queue.start('task_1')

      await queue.timeout('task_1')

      // Should be re-enqueued as AVAILABLE
      const task = await queue.getTask('task_1')
      expect(task!.status).toBe('AVAILABLE')
      expect(task!.claimedBy).toBeNull()
      expect(task!.startedAt).toBeNull()

      // Lock should be released
      expect(await locks.isLocked('task_1')).toBe(false)
    })

    it('re-enqueued task can be claimed by another agent', async () => {
      await queue.publish(makeInput())
      await queue.claim('agent_A', 'task_1')
      await queue.start('task_1')
      await queue.timeout('task_1')

      // agent_B grabs the re-enqueued task
      const claimed = await queue.claim('agent_B', 'task_1')
      expect(claimed).not.toBeNull()
      expect(claimed!.claimedBy).toBe('agent_B')
    })
  })

  // ── Wait Human Approval ─────────────────────────────────────────────────

  describe('waitHumanApproval', () => {
    it('pauses running task for human approval', async () => {
      await queue.publish(makeInput())
      await queue.claim('agent_A', 'task_1')
      await queue.start('task_1')
      await queue.waitHumanApproval('task_1')

      expect(await queue.getStatus('task_1')).toBe('WAITING_HUMAN')
    })

    it('WAITING_HUMAN task can still be completed', async () => {
      await queue.publish(makeInput())
      await queue.claim('agent_A', 'task_1')
      await queue.start('task_1')
      await queue.waitHumanApproval('task_1')
      await queue.complete('task_1', { approved: true })

      expect(await queue.getStatus('task_1')).toBe('COMPLETED')
    })

    it('throws if task is not RUNNING', async () => {
      await queue.publish(makeInput())
      await expect(queue.waitHumanApproval('task_1')).rejects.toThrow('expected RUNNING')
    })
  })

  // ── Task chaining (dependsOn) ─────────────────────────────────────────

  describe('task chaining (dependsOn)', () => {
    it('Task B only becomes AVAILABLE when Task A completes', async () => {
      // Publish Task A (no deps)
      await queue.publish(makeInput({ taskId: 'task_A' }))

      // Publish Task B (depends on Task A)
      const taskB = await queue.publish(makeInput({ taskId: 'task_B', dependsOn: ['task_A'] }))
      expect(taskB.status).toBe('LOCKED') // blocked

      // Complete Task A
      await queue.claim('agent_A', 'task_A')
      await queue.start('task_A')
      await queue.complete('task_A', { done: true })

      // Task B should now be AVAILABLE
      expect(await queue.getStatus('task_B')).toBe('AVAILABLE')

      // Agent can now claim Task B
      const claimed = await queue.claim('agent_B', 'task_B')
      expect(claimed).not.toBeNull()
      expect(claimed!.status).toBe('LOCKED')
    })

    it('multi-dep: Task C waits for both Task A and Task B', async () => {
      await queue.publish(makeInput({ taskId: 'task_A' }))
      await queue.publish(makeInput({ taskId: 'task_B' }))
      await queue.publish(makeInput({ taskId: 'task_C', dependsOn: ['task_A', 'task_B'] }))

      // Complete Task A only
      await queue.claim('agent_1', 'task_A')
      await queue.start('task_A')
      await queue.complete('task_A', {})

      // Task C still blocked (task_B not done)
      expect(await queue.getStatus('task_C')).toBe('LOCKED')

      // Complete Task B
      await queue.claim('agent_2', 'task_B')
      await queue.start('task_B')
      await queue.complete('task_B', {})

      // Task C should now be AVAILABLE
      expect(await queue.getStatus('task_C')).toBe('AVAILABLE')
    })
  })

  // ── getStatus / getTask ───────────────────────────────────────────────

  describe('getStatus / getTask', () => {
    it('returns null for unknown task', async () => {
      expect(await queue.getStatus('ghost')).toBeNull()
      expect(await queue.getTask('ghost')).toBeNull()
    })

    it('getTask returns a copy (no mutation)', async () => {
      await queue.publish(makeInput())
      const task1 = await queue.getTask('task_1')
      const task2 = await queue.getTask('task_1')
      expect(task1).toEqual(task2)
      expect(task1).not.toBe(task2) // different references
    })
  })

  // ── Bus events ────────────────────────────────────────────────────────

  describe('bus events', () => {
    it('emits events through the full lifecycle', async () => {
      const events: string[] = []
      bus.psubscribe('bus:TASK_*', (channel) => {
        events.push(channel.replace('bus:', ''))
      })

      await queue.publish(makeInput())
      await queue.claim('agent_A', 'task_1')
      await queue.start('task_1')
      await queue.complete('task_1', {})

      expect(events).toEqual(['TASK_AVAILABLE', 'TASK_LOCKED', 'TASK_RUNNING', 'TASK_COMPLETED'])
    })
  })
})
