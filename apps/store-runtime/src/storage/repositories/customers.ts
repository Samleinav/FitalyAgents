import type Database from 'better-sqlite3'
import { parseJson, stringifyJson } from './utils.js'

export interface Customer {
  id: string
  name: string
  locale: string
  metadata: Record<string, unknown>
  created_at: number
  updated_at: number
}

export interface ICustomerRepository {
  upsert(customer: {
    id: string
    name: string
    locale?: string
    metadata?: Record<string, unknown>
  }): void
  findById(id: string): Customer | null
  list(): Customer[]
}

export class CustomerRepository implements ICustomerRepository {
  constructor(private readonly db: Database.Database) {}

  upsert(customer: {
    id: string
    name: string
    locale?: string
    metadata?: Record<string, unknown>
  }): void {
    const now = Date.now()
    this.db
      .prepare(
        `
          INSERT INTO customers (id, name, locale, metadata, created_at, updated_at)
          VALUES (@id, @name, @locale, @metadata, @created_at, @updated_at)
          ON CONFLICT(id) DO UPDATE SET
            name = excluded.name,
            locale = excluded.locale,
            metadata = excluded.metadata,
            updated_at = excluded.updated_at
        `,
      )
      .run({
        id: customer.id,
        name: customer.name,
        locale: customer.locale ?? 'es',
        metadata: stringifyJson(customer.metadata ?? {}),
        created_at: now,
        updated_at: now,
      })
  }

  findById(id: string): Customer | null {
    const row = this.db.prepare('SELECT * FROM customers WHERE id = ?').get(id) as
      | Record<string, unknown>
      | undefined

    return row ? mapCustomer(row) : null
  }

  list(): Customer[] {
    const rows = this.db.prepare('SELECT * FROM customers ORDER BY updated_at DESC').all() as Array<
      Record<string, unknown>
    >

    return rows.map(mapCustomer)
  }
}

function mapCustomer(row: Record<string, unknown>): Customer {
  return {
    id: String(row.id),
    name: String(row.name),
    locale: String(row.locale ?? 'es'),
    metadata: parseJson(String(row.metadata ?? '{}'), {}),
    created_at: Number(row.created_at),
    updated_at: Number(row.updated_at),
  }
}
