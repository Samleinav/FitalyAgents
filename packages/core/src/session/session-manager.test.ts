import { describe, it, expect, beforeEach, afterEach } from 'vitest'
import { InMemorySessionManager } from './in-memory-session-manager.js'

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
  })
})
