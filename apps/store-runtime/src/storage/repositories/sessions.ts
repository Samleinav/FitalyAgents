import type Database from 'better-sqlite3'
import { parseJson, stringifyJson } from './utils.js'

export interface SessionSummaryRow {
  session_id: string
  store_id: string
  started_at: number
  ended_at?: number | null
  summary?: Record<string, unknown> | null
  updated_at: number
}

export interface ISessionRepository {
  upsertStarted(sessionId: string, storeId: string, summary?: Record<string, unknown>): void
  touch(sessionId: string, summary?: Record<string, unknown>): void
  end(sessionId: string, summary?: Record<string, unknown>): void
  list(limit?: number): SessionSummaryRow[]
}

export class SessionRepository implements ISessionRepository {
  constructor(private readonly db: Database.Database) {}

  upsertStarted(sessionId: string, storeId: string, summary?: Record<string, unknown>): void {
    const now = Date.now()
    this.db
      .prepare(
        `
          INSERT INTO session_summaries (session_id, store_id, started_at, ended_at, summary, updated_at)
          VALUES (@session_id, @store_id, @started_at, NULL, @summary, @updated_at)
          ON CONFLICT(session_id) DO UPDATE SET
            store_id = excluded.store_id,
            summary = COALESCE(excluded.summary, session_summaries.summary),
            updated_at = excluded.updated_at
        `,
      )
      .run({
        session_id: sessionId,
        store_id: storeId,
        started_at: now,
        summary: summary ? stringifyJson(summary) : null,
        updated_at: now,
      })
  }

  touch(sessionId: string, summary?: Record<string, unknown>): void {
    this.db
      .prepare(
        'UPDATE session_summaries SET summary = COALESCE(?, summary), updated_at = ? WHERE session_id = ?',
      )
      .run(summary ? stringifyJson(summary) : null, Date.now(), sessionId)
  }

  end(sessionId: string, summary?: Record<string, unknown>): void {
    const now = Date.now()
    this.db
      .prepare(
        'UPDATE session_summaries SET ended_at = ?, summary = COALESCE(?, summary), updated_at = ? WHERE session_id = ?',
      )
      .run(now, summary ? stringifyJson(summary) : null, now, sessionId)
  }

  list(limit = 100): SessionSummaryRow[] {
    const rows = this.db
      .prepare('SELECT * FROM session_summaries ORDER BY updated_at DESC LIMIT ?')
      .all(limit) as Array<Record<string, unknown>>

    return rows.map((row) => ({
      session_id: String(row.session_id),
      store_id: String(row.store_id),
      started_at: Number(row.started_at),
      ended_at: row.ended_at == null ? null : Number(row.ended_at),
      summary: row.summary ? parseJson(String(row.summary), {}) : null,
      updated_at: Number(row.updated_at),
    }))
  }
}
