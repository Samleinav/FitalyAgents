import type Database from 'better-sqlite3'
import { parseJson, stringifyJson } from './utils.js'

export type OrderStatus = 'pending' | 'completed' | 'failed'

export interface OrderRow {
  id: string
  session_id: string
  draft_id?: string | null
  tool_id: string
  params: Record<string, unknown>
  result?: Record<string, unknown> | null
  status: OrderStatus
  created_at: number
  updated_at: number
}

export interface IOrderRepository {
  insert(order: OrderRow): void
  update(
    id: string,
    patch: {
      params?: Record<string, unknown>
      result?: Record<string, unknown> | null
      status?: OrderStatus
    },
  ): void
  updateStatus(id: string, status: OrderStatus, result?: Record<string, unknown> | null): void
  findById(id: string): OrderRow | null
  listBySession(sessionId: string): OrderRow[]
}

export class OrderRepository implements IOrderRepository {
  constructor(private readonly db: Database.Database) {}

  insert(order: OrderRow): void {
    this.db
      .prepare(
        `
          INSERT INTO orders (id, session_id, draft_id, tool_id, params, result, status, created_at, updated_at)
          VALUES (@id, @session_id, @draft_id, @tool_id, @params, @result, @status, @created_at, @updated_at)
        `,
      )
      .run({
        ...order,
        draft_id: order.draft_id ?? null,
        params: stringifyJson(order.params),
        result: order.result ? stringifyJson(order.result) : null,
      })
  }

  update(
    id: string,
    patch: {
      params?: Record<string, unknown>
      result?: Record<string, unknown> | null
      status?: OrderStatus
    },
  ): void {
    const existing = this.findById(id)
    if (!existing) {
      throw new Error(`Order ${id} not found`)
    }

    this.db
      .prepare(
        `
          UPDATE orders
          SET params = ?, result = ?, status = ?, updated_at = ?
          WHERE id = ?
        `,
      )
      .run(
        stringifyJson(patch.params ?? existing.params),
        patch.result === null
          ? null
          : stringifyJson(patch.result ?? (existing.result ? existing.result : {})),
        patch.status ?? existing.status,
        Date.now(),
        id,
      )
  }

  updateStatus(id: string, status: OrderStatus, result?: Record<string, unknown> | null): void {
    this.db
      .prepare('UPDATE orders SET status = ?, result = ?, updated_at = ? WHERE id = ?')
      .run(status, result ? stringifyJson(result) : null, Date.now(), id)
  }

  findById(id: string): OrderRow | null {
    const row = this.db.prepare('SELECT * FROM orders WHERE id = ?').get(id) as
      | Record<string, unknown>
      | undefined

    return row ? mapOrder(row) : null
  }

  listBySession(sessionId: string): OrderRow[] {
    const rows = this.db
      .prepare('SELECT * FROM orders WHERE session_id = ? ORDER BY created_at DESC')
      .all(sessionId) as Array<Record<string, unknown>>

    return rows.map(mapOrder)
  }
}

function mapOrder(row: Record<string, unknown>): OrderRow {
  return {
    id: String(row.id),
    session_id: String(row.session_id),
    draft_id: row.draft_id ? String(row.draft_id) : null,
    tool_id: String(row.tool_id),
    params: parseJson(String(row.params ?? '{}'), {}),
    result: row.result ? parseJson(String(row.result), {}) : null,
    status: String(row.status) as OrderStatus,
    created_at: Number(row.created_at),
    updated_at: Number(row.updated_at),
  }
}
