import type { ISessionManager, Session, OnSessionTerminated, PriorityGroup } from './types.js'

/**
 * In-memory implementation of ISessionManager.
 *
 * Tracks sessions in a Map with support for groups, priority groups,
 * pause/resume for employee interrupt protocol, termination hooks,
 * and listing active sessions. Suitable for testing and single-node use.
 *
 * @example
 * ```typescript
 * const manager = new InMemorySessionManager()
 * const session = await manager.createSession('sess_1', { user: 'Ana' })
 * await manager.assignGroup('sess_1', 'vip')
 * await manager.setPriorityGroup('sess_1', 2) // employee
 * await manager.pauseSession('sess_customer', 'sess_employee')
 * await manager.resumeSession('sess_customer')
 * await manager.terminateSession('sess_1')
 * ```
 */
export class InMemorySessionManager implements ISessionManager {
  private sessions: Map<string, Session> = new Map()
  private terminatedCallbacks: OnSessionTerminated[] = []

  async createSession(sessionId: string, metadata?: Record<string, unknown>): Promise<Session> {
    if (this.sessions.has(sessionId)) {
      throw new Error(`Session already exists: "${sessionId}"`)
    }

    const session: Session = {
      sessionId,
      createdAt: Date.now(),
      status: 'active',
      priorityGroup: 1, // default: individual client
      metadata,
    }

    this.sessions.set(sessionId, session)
    return session
  }

  async getSession(sessionId: string): Promise<Session | null> {
    return this.sessions.get(sessionId) ?? null
  }

  async assignGroup(sessionId: string, group: string): Promise<void> {
    const session = this.sessions.get(sessionId)
    if (!session) {
      throw new Error(`Session not found: "${sessionId}"`)
    }
    session.group = group
  }

  async setPriorityGroup(sessionId: string, priorityGroup: PriorityGroup): Promise<void> {
    const session = this.sessions.get(sessionId)
    if (!session) {
      throw new Error(`Session not found: "${sessionId}"`)
    }
    session.priorityGroup = priorityGroup
  }

  async pauseSession(sessionId: string, pausedBy?: string): Promise<void> {
    const session = this.sessions.get(sessionId)
    if (!session) {
      throw new Error(`Session not found: "${sessionId}"`)
    }
    if (session.status !== 'active') {
      throw new Error(`Cannot pause session "${sessionId}": expected active, got ${session.status}`)
    }
    session.status = 'paused'
    session.pausedBy = pausedBy
  }

  async resumeSession(sessionId: string): Promise<void> {
    const session = this.sessions.get(sessionId)
    if (!session) {
      throw new Error(`Session not found: "${sessionId}"`)
    }
    if (session.status !== 'paused') {
      throw new Error(
        `Cannot resume session "${sessionId}": expected paused, got ${session.status}`,
      )
    }
    session.status = 'active'
    session.pausedBy = undefined
  }

  async terminateSession(sessionId: string): Promise<void> {
    const session = this.sessions.get(sessionId)
    if (!session) {
      throw new Error(`Session not found: "${sessionId}"`)
    }

    session.status = 'terminated'

    // Fire all registered callbacks
    for (const callback of this.terminatedCallbacks) {
      try {
        const result = callback(sessionId)
        if (result instanceof Promise) {
          await result
        }
      } catch {
        /* swallow callback errors to ensure all callbacks are invoked */
      }
    }
  }

  async listActiveSessions(): Promise<string[]> {
    const active: string[] = []
    for (const session of this.sessions.values()) {
      if (session.status === 'active') {
        active.push(session.sessionId)
      }
    }
    return active
  }

  async listByPriorityGroup(priorityGroup: PriorityGroup): Promise<string[]> {
    const result: string[] = []
    for (const session of this.sessions.values()) {
      if (session.priorityGroup === priorityGroup && session.status !== 'terminated') {
        result.push(session.sessionId)
      }
    }
    return result
  }

  onTerminated(callback: OnSessionTerminated): void {
    this.terminatedCallbacks.push(callback)
  }

  // ── Convenience ─────────────────────────────────────────────────────────

  /**
   * Dispose all sessions and clear callbacks.
   * Call in test teardown.
   */
  dispose(): void {
    this.sessions.clear()
    this.terminatedCallbacks = []
  }
}
