import { describe, it, expect, beforeEach, afterEach } from 'vitest'
import { InMemoryLockManager } from './in-memory-lock-manager.js'
import type { LockValue } from './types.js'

describe('InMemoryLockManager', () => {
  let locks: InMemoryLockManager

  beforeEach(() => {
    locks = new InMemoryLockManager()
  })

  afterEach(() => {
    locks.dispose()
  })

  // ── acquire ───────────────────────────────────────────────────────────

  describe('acquire', () => {
    it('acquires a lock on an unlocked task', async () => {
      const acquired = await locks.acquire('task_1', 'agent_A', 5000)
      expect(acquired).toBe(true)
    })

    it('agent_B CANNOT acquire a lock already held by agent_A', async () => {
      await locks.acquire('task_1', 'agent_A', 5000)
      const acquired = await locks.acquire('task_1', 'agent_B', 5000)
      expect(acquired).toBe(false)
    })

    it('same agent cannot re-acquire its own lock', async () => {
      await locks.acquire('task_1', 'agent_A', 5000)
      const acquired = await locks.acquire('task_1', 'agent_A', 5000)
      expect(acquired).toBe(false)
    })

    it('different tasks can be locked independently', async () => {
      const a = await locks.acquire('task_1', 'agent_A', 5000)
      const b = await locks.acquire('task_2', 'agent_B', 5000)
      expect(a).toBe(true)
      expect(b).toBe(true)
    })
  })

  // ── release ───────────────────────────────────────────────────────────

  describe('release', () => {
    it('owner can release their lock', async () => {
      await locks.acquire('task_1', 'agent_A', 5000)
      await locks.release('task_1', 'agent_A')
      expect(await locks.isLocked('task_1')).toBe(false)
    })

    it('non-owner CANNOT release the lock', async () => {
      await locks.acquire('task_1', 'agent_A', 5000)
      await locks.release('task_1', 'agent_B') // agent_B is NOT the owner
      expect(await locks.isLocked('task_1')).toBe(true)
    })

    it('releasing non-existent lock is a no-op', async () => {
      // Should not throw
      await locks.release('ghost_task', 'agent_A')
    })

    it('after release, another agent can acquire', async () => {
      await locks.acquire('task_1', 'agent_A', 5000)
      await locks.release('task_1', 'agent_A')
      const acquired = await locks.acquire('task_1', 'agent_B', 5000)
      expect(acquired).toBe(true)
    })
  })

  // ── releaseAll ────────────────────────────────────────────────────────

  describe('releaseAll', () => {
    it('releases all locks held by a specific agent', async () => {
      await locks.acquire('task_1', 'agent_A', 5000)
      await locks.acquire('task_2', 'agent_A', 5000)
      await locks.acquire('task_3', 'agent_B', 5000)

      await locks.releaseAll('agent_A')

      expect(await locks.isLocked('task_1')).toBe(false)
      expect(await locks.isLocked('task_2')).toBe(false)
      // agent_B's lock is untouched
      expect(await locks.isLocked('task_3')).toBe(true)
    })

    it('no-op if agent has no locks', async () => {
      await locks.acquire('task_1', 'agent_A', 5000)
      await locks.releaseAll('agent_C') // agent_C has nothing
      expect(await locks.isLocked('task_1')).toBe(true)
    })
  })

  // ── get / isLocked ────────────────────────────────────────────────────

  describe('get / isLocked', () => {
    it('returns lock info for held lock', async () => {
      await locks.acquire('task_1', 'agent_A', 5000)
      const lock = await locks.get('task_1')

      expect(lock).not.toBeNull()
      expect(lock!.taskId).toBe('task_1')
      expect(lock!.agentId).toBe('agent_A')
      expect(lock!.acquiredAt).toBeLessThanOrEqual(Date.now())
      expect(lock!.expiresAt).toBeGreaterThan(Date.now())
    })

    it('returns null for unlocked task', async () => {
      const lock = await locks.get('ghost')
      expect(lock).toBeNull()
    })

    it('isLocked returns true for held lock', async () => {
      await locks.acquire('task_1', 'agent_A', 5000)
      expect(await locks.isLocked('task_1')).toBe(true)
    })

    it('isLocked returns false for unlocked task', async () => {
      expect(await locks.isLocked('ghost')).toBe(false)
    })
  })

  // ── TTL expiry ────────────────────────────────────────────────────────

  describe('TTL expiry', () => {
    it('expired lock is automatically evicted on access', async () => {
      await locks.acquire('task_1', 'agent_A', 50) // 50ms TTL

      // Lock should exist immediately
      expect(await locks.isLocked('task_1')).toBe(true)

      // Wait for TTL to expire
      await new Promise((r) => setTimeout(r, 100))

      // Lock should be evicted
      expect(await locks.isLocked('task_1')).toBe(false)
      expect(await locks.get('task_1')).toBeNull()
    })

    it('expired lock allows re-acquisition by another agent', async () => {
      await locks.acquire('task_1', 'agent_A', 50)
      await new Promise((r) => setTimeout(r, 100))

      const acquired = await locks.acquire('task_1', 'agent_B', 5000)
      expect(acquired).toBe(true)

      const lock = await locks.get('task_1')
      expect(lock!.agentId).toBe('agent_B')
    })
  })

  // ── Watchdog ──────────────────────────────────────────────────────────

  describe('watchdog', () => {
    it('detects and releases expired locks via watchdog callback', async () => {
      const expired: LockValue[] = []

      await locks.acquire('task_1', 'agent_A', 50) // 50ms TTL
      await locks.acquire('task_2', 'agent_B', 10_000) // long TTL

      locks.startWatchdog(30, (lock) => {
        expired.push(lock)
      })

      // Wait for TTL of task_1 to expire + watchdog interval
      await new Promise((r) => setTimeout(r, 150))

      locks.stopWatchdog()

      // Only task_1 should have been detected as expired
      expect(expired.length).toBeGreaterThanOrEqual(1)
      expect(expired.some((l) => l.taskId === 'task_1')).toBe(true)
      expect(expired.some((l) => l.taskId === 'task_2')).toBe(false)

      // task_1 should be released
      expect(await locks.isLocked('task_1')).toBe(false)
      // task_2 should still be locked
      expect(await locks.isLocked('task_2')).toBe(true)
    })

    it('stopWatchdog prevents further scanning', async () => {
      const expired: LockValue[] = []

      await locks.acquire('task_1', 'agent_A', 50)

      locks.startWatchdog(30, (lock) => {
        expired.push(lock)
      })

      // Stop immediately
      locks.stopWatchdog()

      await new Promise((r) => setTimeout(r, 150))

      // Should NOT have detected the expired lock because watchdog was stopped
      expect(expired.length).toBe(0)
    })
  })
})
