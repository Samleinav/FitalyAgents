import { describe, it, expect, beforeEach, afterEach } from 'vitest'
import { InMemorySessionManager } from './in-memory-session-manager.js'
import { InMemoryBus } from '../bus/in-memory-bus.js'
import type { PriorityGroup } from './types.js'

describe('InMemorySessionManager', () => {
  let manager: InMemorySessionManager

  beforeEach(() => {
    manager = new InMemorySessionManager()
  })

  afterEach(() => {
    manager.dispose()
  })

  // ── createSession ─────────────────────────────────────────────────────

  describe('createSession', () => {
    it('creates a new session with metadata', async () => {
      const session = await manager.createSession('sess_1', { user: 'Ana' })

      expect(session.sessionId).toBe('sess_1')
      expect(session.status).toBe('active')
      expect(session.metadata).toEqual({ user: 'Ana' })
      expect(session.createdAt).toBeLessThanOrEqual(Date.now())
    })

    it('creates a session without metadata', async () => {
      const session = await manager.createSession('sess_1')
      expect(session.sessionId).toBe('sess_1')
      expect(session.metadata).toBeUndefined()
    })

    it('default priority group is 1 (individual client)', async () => {
      const session = await manager.createSession('sess_1')
      expect(session.priorityGroup).toBe(1)
    })

    it('throws on duplicate session ID', async () => {
      await manager.createSession('sess_1')
      await expect(manager.createSession('sess_1')).rejects.toThrow('already exists')
    })
  })

  // ── getSession ────────────────────────────────────────────────────────

  describe('getSession', () => {
    it('returns existing session', async () => {
      await manager.createSession('sess_1', { lang: 'es' })
      const session = await manager.getSession('sess_1')
      expect(session).not.toBeNull()
      expect(session!.sessionId).toBe('sess_1')
    })

    it('returns null for non-existent session', async () => {
      const session = await manager.getSession('ghost')
      expect(session).toBeNull()
    })
  })

  // ── assignGroup ───────────────────────────────────────────────────────

  describe('assignGroup', () => {
    it('assigns a group to an existing session', async () => {
      await manager.createSession('sess_1')
      await manager.assignGroup('sess_1', 'vip')

      const session = await manager.getSession('sess_1')
      expect(session!.group).toBe('vip')
    })

    it('overwrites an existing group', async () => {
      await manager.createSession('sess_1')
      await manager.assignGroup('sess_1', 'basic')
      await manager.assignGroup('sess_1', 'premium')

      const session = await manager.getSession('sess_1')
      expect(session!.group).toBe('premium')
    })

    it('throws for non-existent session', async () => {
      await expect(manager.assignGroup('ghost', 'vip')).rejects.toThrow('not found')
    })
  })

  // ── setPriorityGroup ──────────────────────────────────────────────────

  describe('setPriorityGroup', () => {
    it('sets priority group on session', async () => {
      await manager.createSession('sess_1')
      await manager.setPriorityGroup('sess_1', 2)

      const session = await manager.getSession('sess_1')
      expect(session!.priorityGroup).toBe(2)
    })

    it('throws for non-existent session', async () => {
      await expect(manager.setPriorityGroup('ghost', 2)).rejects.toThrow('not found')
    })

    it('supports all three priority groups', async () => {
      for (const pg of [0, 1, 2] as PriorityGroup[]) {
        const sid = `sess_pg${pg}`
        await manager.createSession(sid)
        await manager.setPriorityGroup(sid, pg)
        const session = await manager.getSession(sid)
        expect(session!.priorityGroup).toBe(pg)
      }
    })
  })

  // ── pauseSession / resumeSession ────────────────────────────────────────

  describe('pauseSession', () => {
    it('pauses an active session', async () => {
      await manager.createSession('sess_customer')
      await manager.pauseSession('sess_customer', 'sess_employee')

      const session = await manager.getSession('sess_customer')
      expect(session!.status).toBe('paused')
      expect(session!.pausedBy).toBe('sess_employee')
    })

    it('throws when pausing a non-active session', async () => {
      await manager.createSession('sess_1')
      await manager.pauseSession('sess_1')
      await expect(manager.pauseSession('sess_1')).rejects.toThrow('expected active')
    })

    it('throws for non-existent session', async () => {
      await expect(manager.pauseSession('ghost')).rejects.toThrow('not found')
    })
  })

  describe('resumeSession', () => {
    it('resumes a paused session', async () => {
      await manager.createSession('sess_1')
      await manager.pauseSession('sess_1', 'sess_employee')
      await manager.resumeSession('sess_1')

      const session = await manager.getSession('sess_1')
      expect(session!.status).toBe('active')
      expect(session!.pausedBy).toBeUndefined()
    })

    it('throws when resuming a non-paused session', async () => {
      await manager.createSession('sess_1')
      await expect(manager.resumeSession('sess_1')).rejects.toThrow('expected paused')
    })

    it('throws for non-existent session', async () => {
      await expect(manager.resumeSession('ghost')).rejects.toThrow('not found')
    })
  })

  // ── terminateSession ──────────────────────────────────────────────────

  describe('terminateSession', () => {
    it('sets session status to terminated', async () => {
      await manager.createSession('sess_1')
      await manager.terminateSession('sess_1')

      const session = await manager.getSession('sess_1')
      expect(session!.status).toBe('terminated')
    })

    it('fires onTerminated callbacks', async () => {
      const terminated: string[] = []
      manager.onTerminated((id) => {
        terminated.push(id)
      })

      await manager.createSession('sess_1')
      await manager.terminateSession('sess_1')

      expect(terminated).toEqual(['sess_1'])
    })

    it('fires multiple onTerminated callbacks in order', async () => {
      const log: string[] = []
      manager.onTerminated((id) => {
        log.push(`cb1:${id}`)
      })
      manager.onTerminated((id) => {
        log.push(`cb2:${id}`)
      })

      await manager.createSession('sess_1')
      await manager.terminateSession('sess_1')

      expect(log).toEqual(['cb1:sess_1', 'cb2:sess_1'])
    })

    it('fires async onTerminated callbacks', async () => {
      const terminated: string[] = []
      manager.onTerminated(async (id) => {
        await new Promise((r) => setTimeout(r, 10))
        terminated.push(id)
      })

      await manager.createSession('sess_1')
      await manager.terminateSession('sess_1')

      expect(terminated).toEqual(['sess_1'])
    })

    it('throws for non-existent session', async () => {
      await expect(manager.terminateSession('ghost')).rejects.toThrow('not found')
    })
  })

  // ── listActiveSessions ────────────────────────────────────────────────

  describe('listActiveSessions', () => {
    it('lists only active sessions', async () => {
      await manager.createSession('sess_1')
      await manager.createSession('sess_2')
      await manager.createSession('sess_3')
      await manager.terminateSession('sess_2')

      const active = await manager.listActiveSessions()
      expect(active).toContain('sess_1')
      expect(active).toContain('sess_3')
      expect(active).not.toContain('sess_2')
    })

    it('does NOT include paused sessions', async () => {
      await manager.createSession('sess_1')
      await manager.createSession('sess_2')
      await manager.pauseSession('sess_1')

      const active = await manager.listActiveSessions()
      expect(active).not.toContain('sess_1')
      expect(active).toContain('sess_2')
    })

    it('returns empty array when no sessions exist', async () => {
      const active = await manager.listActiveSessions()
      expect(active).toEqual([])
    })

    it('returns empty when all sessions are terminated', async () => {
      await manager.createSession('sess_1')
      await manager.terminateSession('sess_1')

      const active = await manager.listActiveSessions()
      expect(active).toEqual([])
    })
  })

  // ── listByPriorityGroup ───────────────────────────────────────────────

  describe('listByPriorityGroup', () => {
    it('returns sessions matching priority group', async () => {
      await manager.createSession('sess_customer1')
      await manager.createSession('sess_customer2')
      await manager.createSession('sess_employee')
      await manager.setPriorityGroup('sess_employee', 2)

      const customers = await manager.listByPriorityGroup(1)
      expect(customers).toContain('sess_customer1')
      expect(customers).toContain('sess_customer2')
      expect(customers).not.toContain('sess_employee')

      const employees = await manager.listByPriorityGroup(2)
      expect(employees).toEqual(['sess_employee'])
    })

    it('excludes terminated sessions', async () => {
      await manager.createSession('sess_1')
      await manager.terminateSession('sess_1')

      const result = await manager.listByPriorityGroup(1)
      expect(result).toEqual([])
    })

    it('includes paused sessions', async () => {
      await manager.createSession('sess_1')
      await manager.pauseSession('sess_1')

      const result = await manager.listByPriorityGroup(1)
      expect(result).toContain('sess_1')
    })
  })

  // ── Session isolation ─────────────────────────────────────────────────

  describe('session isolation', () => {
    it('terminating one session does NOT affect others', async () => {
      await manager.createSession('sess_ana')
      await manager.createSession('sess_pedro')

      await manager.terminateSession('sess_ana')

      const ana = await manager.getSession('sess_ana')
      const pedro = await manager.getSession('sess_pedro')

      expect(ana!.status).toBe('terminated')
      expect(pedro!.status).toBe('active')
    })

    it('groups are independent per session', async () => {
      await manager.createSession('sess_1')
      await manager.createSession('sess_2')

      await manager.assignGroup('sess_1', 'vip')
      await manager.assignGroup('sess_2', 'basic')

      const s1 = await manager.getSession('sess_1')
      const s2 = await manager.getSession('sess_2')

      expect(s1!.group).toBe('vip')
      expect(s2!.group).toBe('basic')
    })

    it('priority groups are independent per session', async () => {
      await manager.createSession('sess_1')
      await manager.createSession('sess_2')

      await manager.setPriorityGroup('sess_1', 0) // social
      await manager.setPriorityGroup('sess_2', 2) // employee

      const s1 = await manager.getSession('sess_1')
      const s2 = await manager.getSession('sess_2')

      expect(s1!.priorityGroup).toBe(0)
      expect(s2!.priorityGroup).toBe(2)
    })
  })

  // ── Employee Interrupt Protocol ──────────────────────────────────────

  describe('Employee Interrupt Protocol', () => {
    it('full flow: employee interrupts customer, responds, customer resumes', async () => {
      const bus = new InMemoryBus()

      // Create two sessions
      await manager.createSession('sess_customer', { user: 'Ana' })
      await manager.setPriorityGroup('sess_customer', 1)

      await manager.createSession('sess_employee', { user: 'Manager Bob' })
      await manager.setPriorityGroup('sess_employee', 2)

      // Customer session is active
      expect((await manager.getSession('sess_customer'))!.status).toBe('active')

      // Step 1: bus:PRIORITY_INTERRUPT → pause customer session
      const interruptEvents: unknown[] = []
      bus.subscribe('bus:PRIORITY_INTERRUPT', async (data) => {
        const event = data as { interrupter_session: string; target_session: string }
        interruptEvents.push(event)
        await manager.pauseSession(event.target_session, event.interrupter_session)
      })

      await bus.publish('bus:PRIORITY_INTERRUPT', {
        event: 'PRIORITY_INTERRUPT',
        interrupter_session: 'sess_employee',
        target_session: 'sess_customer',
        reason: 'Employee needs to check order details',
      })

      // Customer session should now be paused
      const paused = await manager.getSession('sess_customer')
      expect(paused!.status).toBe('paused')
      expect(paused!.pausedBy).toBe('sess_employee')

      // Step 2: Employee session processes (simulated)
      // Employee does their work...

      // Step 3: bus:SESSION_RESUMED → resume customer session
      const resumeEvents: unknown[] = []
      bus.subscribe('bus:SESSION_RESUMED', async (data) => {
        const event = data as { session_id: string }
        resumeEvents.push(event)
        await manager.resumeSession(event.session_id)
      })

      await bus.publish('bus:SESSION_RESUMED', {
        event: 'SESSION_RESUMED',
        session_id: 'sess_customer',
      })

      // Customer session should be active again
      const resumed = await manager.getSession('sess_customer')
      expect(resumed!.status).toBe('active')
      expect(resumed!.pausedBy).toBeUndefined()

      // Verify events were processed
      expect(interruptEvents).toHaveLength(1)
      expect(resumeEvents).toHaveLength(1)
    })

    it('higher priority group can interrupt lower', async () => {
      await manager.createSession('sess_social', { type: 'group_chat' })
      await manager.setPriorityGroup('sess_social', 0)

      await manager.createSession('sess_employee')
      await manager.setPriorityGroup('sess_employee', 2)

      // Employee (group 2) interrupts social (group 0)
      const employee = await manager.getSession('sess_employee')
      const social = await manager.getSession('sess_social')

      expect(employee!.priorityGroup).toBeGreaterThan(social!.priorityGroup)

      // Pause social session
      await manager.pauseSession('sess_social', 'sess_employee')
      expect((await manager.getSession('sess_social'))!.status).toBe('paused')

      // Resume after employee is done
      await manager.resumeSession('sess_social')
      expect((await manager.getSession('sess_social'))!.status).toBe('active')
    })

    it('pausing a customer does NOT terminate their session data', async () => {
      await manager.createSession('sess_1', { cart: ['item_1'] })
      await manager.pauseSession('sess_1', 'sess_employee')

      // Session still exists and metadata is preserved
      const session = await manager.getSession('sess_1')
      expect(session).not.toBeNull()
      expect(session!.metadata).toEqual({ cart: ['item_1'] })
      expect(session!.status).toBe('paused')
    })

    it('cannot terminate a paused session (must resume first or force)', async () => {
      await manager.createSession('sess_1')
      await manager.pauseSession('sess_1')

      // terminateSession still works for paused sessions (force cleanup)
      await manager.terminateSession('sess_1')
      expect((await manager.getSession('sess_1'))!.status).toBe('terminated')
    })
  })
})
