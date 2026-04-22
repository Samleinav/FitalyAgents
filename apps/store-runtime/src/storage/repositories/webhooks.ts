import type Database from 'better-sqlite3'
import { parseJson, stringifyJson } from './utils.js'

export type WebhookDeliveryStatus = 'pending' | 'sent' | 'failed'

export interface WebhookDeliveryRow {
  id: string
  url: string
  payload: Record<string, unknown>
  status: WebhookDeliveryStatus
  attempts: number
  last_error?: string | null
  created_at: number
  sent_at?: number | null
}

export interface IWebhookRepository {
  insert(delivery: WebhookDeliveryRow): void
  markSent(id: string): void
  markFailed(id: string, error: string): void
  listPending(): WebhookDeliveryRow[]
}

export class WebhookRepository implements IWebhookRepository {
  constructor(private readonly db: Database.Database) {}

  insert(delivery: WebhookDeliveryRow): void {
    this.db
      .prepare(
        `
          INSERT OR REPLACE INTO webhook_deliveries (
            id,
            url,
            payload,
            status,
            attempts,
            last_error,
            created_at,
            sent_at
          )
          VALUES (@id, @url, @payload, @status, @attempts, @last_error, @created_at, @sent_at)
        `,
      )
      .run({
        ...delivery,
        payload: stringifyJson(delivery.payload),
        last_error: delivery.last_error ?? null,
        sent_at: delivery.sent_at ?? null,
      })
  }

  markSent(id: string): void {
    this.db
      .prepare(
        'UPDATE webhook_deliveries SET status = ?, attempts = attempts + 1, sent_at = ? WHERE id = ?',
      )
      .run('sent', Date.now(), id)
  }

  markFailed(id: string, error: string): void {
    this.db
      .prepare(
        'UPDATE webhook_deliveries SET status = ?, attempts = attempts + 1, last_error = ? WHERE id = ?',
      )
      .run('failed', error, id)
  }

  listPending(): WebhookDeliveryRow[] {
    const rows = this.db
      .prepare('SELECT * FROM webhook_deliveries WHERE status = ? ORDER BY created_at ASC')
      .all('pending') as Array<Record<string, unknown>>

    return rows.map((row) => ({
      id: String(row.id),
      url: String(row.url),
      payload: parseJson(String(row.payload), {}),
      status: String(row.status) as WebhookDeliveryStatus,
      attempts: Number(row.attempts),
      last_error: row.last_error ? String(row.last_error) : null,
      created_at: Number(row.created_at),
      sent_at: row.sent_at == null ? null : Number(row.sent_at),
    }))
  }
}
