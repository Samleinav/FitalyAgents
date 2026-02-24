import type { AgentManifest } from '../types/index.js'

// ── Error ────────────────────────────────────────────────────────────────────

/**
 * Thrown when an agent attempts to write to a field it is forbidden from accessing.
 */
export class AccessDeniedError extends Error {
  constructor(
    public readonly agentId: string,
    public readonly field: string,
  ) {
    super(`Agent "${agentId}" is forbidden from writing field "${field}"`)
    this.name = 'AccessDeniedError'
  }
}

// ── Interface ────────────────────────────────────────────────────────────────

/**
 * Interface for per-session context storage.
 *
 * Each session ID maps to a flat key–value document (JSON object).
 * Implementations can be backed by in-memory Maps (testing) or
 * RedisJSON (production) while keeping the same API contract.
 *
 * Namespace convention: `context:{session_id}`
 */
export interface IContextStore {
  /**
   * Retrieve a single field from a session's context.
   * Returns `null` if the session or field does not exist.
   */
  get<T = unknown>(sessionId: string, field: string): Promise<T | null>

  /**
   * Set a single field in a session's context.
   * Creates the session context if it doesn't already exist.
   */
  set(sessionId: string, field: string, value: unknown): Promise<void>

  /**
   * Atomically merge multiple fields into the session's context.
   * Existing fields not present in `updates` are left unchanged.
   * Creates the session context if it doesn't already exist.
   */
  patch(sessionId: string, updates: Record<string, unknown>): Promise<void>

  /**
   * Retrieve multiple fields from a session's context.
   * Only fields that exist are included in the result.
   */
  getMany(sessionId: string, fields: string[]): Promise<Record<string, unknown>>

  /**
   * Build a filtered snapshot of the session's context for an agent.
   *
   * - If `allowedFields` contains `"*"`, all fields are initially included.
   * - Otherwise only the listed fields are included.
   * - Fields present in `excludeFields` are **always** removed, even
   *   if they appear in `allowedFields`.
   *
   * This is the primary mechanism for enforcing `context_access.read`.
   */
  getSnapshot(
    sessionId: string,
    allowedFields: string[],
    excludeFields?: string[],
  ): Promise<Record<string, unknown>>

  /**
   * Delete a single field from the session's context,
   * or delete the entire session context if no field is specified.
   */
  delete(sessionId: string, field?: string): Promise<void>

  /**
   * Check whether a session context exists.
   */
  exists(sessionId: string): Promise<boolean>

  /**
   * Set a time-to-live on the session context.
   * After `ttlSeconds` the session is automatically deleted.
   */
  setTTL(sessionId: string, ttlSeconds: number): Promise<void>
}

// ── Access enforcement ──────────────────────────────────────────────────────

/**
 * Validate that a context patch does not touch fields forbidden by the
 * agent's manifest. Throws `AccessDeniedError` if any forbidden field
 * is present in the patch.
 *
 * @param manifest - The agent's manifest containing `context_access`
 * @param patch    - The proposed key–value updates
 * @throws {AccessDeniedError} If patch contains a forbidden field
 */
export function enforceAccess(manifest: AgentManifest, patch: Record<string, unknown>): void {
  const forbidden = new Set(manifest.context_access.forbidden)

  for (const field of Object.keys(patch)) {
    if (forbidden.has(field)) {
      throw new AccessDeniedError(manifest.agent_id, field)
    }
  }
}
