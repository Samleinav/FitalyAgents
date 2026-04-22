import type Database from 'better-sqlite3'
import { parseJson, stringifyJson } from './utils.js'

export type DraftStatus = 'pending' | 'confirmed' | 'cancelled'

export interface DraftRow {
  id: string
  session_id: string
  tool_id: string
  params: Record<string, unknown>
  status: DraftStatus
  safety_level: string
  created_at: number
  updated_at: number
}

export interface IDraftRepository {
  upsert(draft: DraftRow): void
  updateStatus(id: string, status: DraftStatus): void
  findById(id: string): DraftRow | null
  listPending(sessionId?: string): DraftRow[]
}

export class DraftRepository implements IDraftRepository {
  constructor(private readonly db: Database.Database) {}

  upsert(draft: DraftRow): void {
    this.db
      .prepare(
        `
          INSERT INTO drafts (id, session_id, tool_id, params, status, safety_level, created_at, updated_at)
          VALUES (@id, @session_id, @tool_id, @params, @status, @safety_level, @created_at, @updated_at)
          ON CONFLICT(id) DO UPDATE SET
            params = excluded.params,
            status = excluded.status,
            safety_level = excluded.safety_level,
            updated_at = excluded.updated_at
        `,
      )
      .run({
        ...draft,
        params: stringifyJson(draft.params),
      })
  }

  updateStatus(id: string, status: DraftStatus): void {
    this.db
      .prepare('UPDATE drafts SET status = ?, updated_at = ? WHERE id = ?')
      .run(status, Date.now(), id)
  }

  findById(id: string): DraftRow | null {
    const row = this.db.prepare('SELECT * FROM drafts WHERE id = ?').get(id) as
      | Record<string, unknown>
      | undefined

    return row ? mapDraft(row) : null
  }

  listPending(sessionId?: string): DraftRow[] {
    const rows = sessionId
      ? (this.db
          .prepare(
            'SELECT * FROM drafts WHERE status = ? AND session_id = ? ORDER BY created_at DESC',
          )
          .all('pending', sessionId) as Array<Record<string, unknown>>)
      : (this.db
          .prepare('SELECT * FROM drafts WHERE status = ? ORDER BY created_at DESC')
          .all('pending') as Array<Record<string, unknown>>)

    return rows.map(mapDraft)
  }
}

function mapDraft(row: Record<string, unknown>): DraftRow {
  return {
    id: String(row.id),
    session_id: String(row.session_id),
    tool_id: String(row.tool_id),
    params: parseJson(String(row.params ?? '{}'), {}),
    status: String(row.status) as DraftStatus,
    safety_level: String(row.safety_level),
    created_at: Number(row.created_at),
    updated_at: Number(row.updated_at),
  }
}
