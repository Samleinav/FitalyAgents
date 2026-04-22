import type Database from 'better-sqlite3'
import { parseJson, stringifyJson } from './utils.js'

export type ApprovalStatus = 'pending' | 'approved' | 'rejected' | 'timeout' | 'queued'

export interface ApprovalRequestRow {
  id: string
  draft_id: string
  session_id: string
  action: string
  required_role: string
  strategy: string
  quorum_required?: number | null
  status: ApprovalStatus
  approvers: string[]
  context: Record<string, unknown>
  timeout_ms: number
  created_at: number
  resolved_at?: number | null
}

export interface IApprovalRepository {
  insert(request: ApprovalRequestRow): void
  updateStatus(
    id: string,
    status: ApprovalStatus,
    approvers?: string[],
    resolvedAt?: number | null,
  ): void
  findPendingByRole(role: string): ApprovalRequestRow[]
  findById(id: string): ApprovalRequestRow | null
  listPending(): ApprovalRequestRow[]
}

export class ApprovalRepository implements IApprovalRepository {
  constructor(private readonly db: Database.Database) {}

  insert(request: ApprovalRequestRow): void {
    this.db
      .prepare(
        `
          INSERT OR REPLACE INTO approval_requests (
            id,
            draft_id,
            session_id,
            action,
            required_role,
            strategy,
            quorum_required,
            status,
            approvers,
            context,
            timeout_ms,
            created_at,
            resolved_at
          )
          VALUES (
            @id,
            @draft_id,
            @session_id,
            @action,
            @required_role,
            @strategy,
            @quorum_required,
            @status,
            @approvers,
            @context,
            @timeout_ms,
            @created_at,
            @resolved_at
          )
        `,
      )
      .run({
        ...request,
        approvers: stringifyJson(request.approvers),
        context: stringifyJson(request.context),
        quorum_required: request.quorum_required ?? null,
        resolved_at: request.resolved_at ?? null,
      })
  }

  updateStatus(
    id: string,
    status: ApprovalStatus,
    approvers?: string[],
    resolvedAt?: number | null,
  ): void {
    this.db
      .prepare(
        `
          UPDATE approval_requests
          SET status = ?, approvers = COALESCE(?, approvers), resolved_at = COALESCE(?, resolved_at)
          WHERE id = ?
        `,
      )
      .run(status, approvers ? stringifyJson(approvers) : null, resolvedAt ?? null, id)
  }

  findPendingByRole(role: string): ApprovalRequestRow[] {
    const rows = this.db
      .prepare(
        'SELECT * FROM approval_requests WHERE status IN (?, ?) AND required_role = ? ORDER BY created_at ASC',
      )
      .all('pending', 'queued', role) as Array<Record<string, unknown>>

    return rows.map(mapApproval)
  }

  findById(id: string): ApprovalRequestRow | null {
    const row = this.db.prepare('SELECT * FROM approval_requests WHERE id = ?').get(id) as
      | Record<string, unknown>
      | undefined

    return row ? mapApproval(row) : null
  }

  listPending(): ApprovalRequestRow[] {
    const rows = this.db
      .prepare('SELECT * FROM approval_requests WHERE status IN (?, ?) ORDER BY created_at ASC')
      .all('pending', 'queued') as Array<Record<string, unknown>>

    return rows.map(mapApproval)
  }
}

function mapApproval(row: Record<string, unknown>): ApprovalRequestRow {
  return {
    id: String(row.id),
    draft_id: String(row.draft_id),
    session_id: String(row.session_id),
    action: String(row.action),
    required_role: String(row.required_role),
    strategy: String(row.strategy),
    quorum_required: row.quorum_required == null ? null : Number(row.quorum_required),
    status: String(row.status) as ApprovalStatus,
    approvers: parseJson(String(row.approvers ?? '[]'), []),
    context: parseJson(String(row.context ?? '{}'), {}),
    timeout_ms: Number(row.timeout_ms),
    created_at: Number(row.created_at),
    resolved_at: row.resolved_at == null ? null : Number(row.resolved_at),
  }
}
