import type { IContextStore } from './types.js'

/**
 * In-memory implementation of IContextStore.
 *
 * Uses nested Maps for fast per-session, per-field lookups.
 * Supports TTL via setTimeout (auto-unref'd so timers don't
 * prevent process exit). Suitable for testing and single-node use.
 *
 * @example
 * ```typescript
 * const store = new InMemoryContextStore()
 * await store.set('sess_1', 'cart', { items: ['shirt'] })
 * const cart = await store.get('sess_1', 'cart')
 * ```
 */
export class InMemoryContextStore implements IContextStore {
  /** session_id → { field → value } */
  private data: Map<string, Map<string, unknown>> = new Map()
  /** session_id → TTL timer handle */
  private timers: Map<string, ReturnType<typeof setTimeout>> = new Map()

  // ── Core CRUD ───────────────────────────────────────────────────────────

  async get<T = unknown>(sessionId: string, field: string): Promise<T | null> {
    const session = this.data.get(sessionId)
    if (!session) return null

    const value = session.get(field)
    if (value === undefined) return null

    return value as T
  }

  async set(sessionId: string, field: string, value: unknown): Promise<void> {
    this.ensureSession(sessionId)
    this.data.get(sessionId)!.set(field, value)
  }

  async patch(sessionId: string, updates: Record<string, unknown>): Promise<void> {
    this.ensureSession(sessionId)
    const session = this.data.get(sessionId)!

    for (const [key, value] of Object.entries(updates)) {
      session.set(key, value)
    }
  }

  async getMany(sessionId: string, fields: string[]): Promise<Record<string, unknown>> {
    const session = this.data.get(sessionId)
    if (!session) return {}

    const result: Record<string, unknown> = {}
    for (const field of fields) {
      if (session.has(field)) {
        result[field] = session.get(field)
      }
    }
    return result
  }

  async getSnapshot(
    sessionId: string,
    allowedFields: string[],
    excludeFields?: string[],
  ): Promise<Record<string, unknown>> {
    const session = this.data.get(sessionId)
    if (!session) return {}

    const excluded = new Set(excludeFields ?? [])
    const allowAll = allowedFields.includes('*')

    const result: Record<string, unknown> = {}

    if (allowAll) {
      // Include all fields, then exclude forbidden ones
      for (const [key, value] of session.entries()) {
        if (!excluded.has(key)) {
          result[key] = value
        }
      }
    } else {
      // Only include explicitly allowed fields, minus exclusions
      for (const field of allowedFields) {
        if (!excluded.has(field) && session.has(field)) {
          result[field] = session.get(field)
        }
      }
    }

    return result
  }

  async delete(sessionId: string, field?: string): Promise<void> {
    if (field !== undefined) {
      // Delete a single field
      const session = this.data.get(sessionId)
      if (session) {
        session.delete(field)
      }
    } else {
      // Delete entire session context
      this.data.delete(sessionId)
      const timer = this.timers.get(sessionId)
      if (timer) {
        clearTimeout(timer)
        this.timers.delete(sessionId)
      }
    }
  }

  async exists(sessionId: string): Promise<boolean> {
    return this.data.has(sessionId)
  }

  async setTTL(sessionId: string, ttlSeconds: number): Promise<void> {
    // Clear any previous timer
    const existing = this.timers.get(sessionId)
    if (existing) {
      clearTimeout(existing)
    }

    const timer = setTimeout(() => {
      this.data.delete(sessionId)
      this.timers.delete(sessionId)
    }, ttlSeconds * 1000)

    // Don't let the timer prevent process exit
    if (typeof timer === 'object' && 'unref' in timer) {
      timer.unref()
    }

    this.timers.set(sessionId, timer)
  }

  // ── Cleanup ─────────────────────────────────────────────────────────────

  /**
   * Dispose all sessions and cancel any TTL timers.
   * Call in test teardown to prevent leaked handles.
   */
  dispose(): void {
    for (const timer of this.timers.values()) {
      clearTimeout(timer)
    }
    this.timers.clear()
    this.data.clear()
  }

  // ── Private ─────────────────────────────────────────────────────────────

  private ensureSession(sessionId: string): void {
    if (!this.data.has(sessionId)) {
      this.data.set(sessionId, new Map())
    }
  }
}
