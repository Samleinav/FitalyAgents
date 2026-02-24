// ── Session types ───────────────────────────────────────────────────────────

/**
 * Represents an active session with metadata.
 */
export interface Session {
  /** Unique session identifier */
  sessionId: string
  /** When the session was created (ms since epoch) */
  createdAt: number
  /** Optional group this session belongs to (e.g. 'vip', 'default') */
  group?: string
  /** Current status of the session */
  status: 'active' | 'terminated'
  /** Arbitrary metadata attached at creation time */
  metadata?: Record<string, unknown>
}

/**
 * Callback invoked when a session is terminated.
 * Used to trigger cleanup of related resources (context, locks, tasks).
 */
export type OnSessionTerminated = (sessionId: string) => void | Promise<void>

/**
 * Interface for session lifecycle management.
 *
 * Tracks active sessions, their groups, and provides a hook for
 * cleanup when sessions are terminated.
 */
export interface ISessionManager {
  /**
   * Create a new session. Returns the created Session object.
   * If a session with the same ID already exists, throws an error.
   */
  createSession(sessionId: string, metadata?: Record<string, unknown>): Promise<Session>

  /**
   * Get a session by ID. Returns null if not found.
   */
  getSession(sessionId: string): Promise<Session | null>

  /**
   * Assign a session to a group (e.g. 'vip', 'enterprise').
   */
  assignGroup(sessionId: string, group: string): Promise<void>

  /**
   * Terminate a session and trigger cleanup callbacks.
   * Sets status to 'terminated' and fires `onTerminated` hooks.
   */
  terminateSession(sessionId: string): Promise<void>

  /**
   * List all session IDs with status 'active'.
   */
  listActiveSessions(): Promise<string[]>

  /**
   * Register a callback invoked when any session is terminated.
   * Multiple callbacks can be registered. They are called in order.
   */
  onTerminated(callback: OnSessionTerminated): void
}
