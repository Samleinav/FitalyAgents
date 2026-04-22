import type Database from 'better-sqlite3'
import type { StoreEmployeeConfig } from '../../config/schema.js'
import { parseJson, stringifyJson } from './utils.js'

export interface EmployeeRow {
  id: string
  name: string
  role: string
  approval_limits: Record<string, unknown>
  voice_id?: string
  loaded_from: string
  updated_at: number
}

export interface IEmployeeRepository {
  upsert(employee: StoreEmployeeConfig, loadedFrom?: string): void
  deleteMissingConfigEmployees(ids: string[]): void
  findById(id: string): EmployeeRow | null
  findByVoiceId(voiceId: string): EmployeeRow | null
  list(): EmployeeRow[]
}

export class EmployeeRepository implements IEmployeeRepository {
  constructor(private readonly db: Database.Database) {}

  upsert(employee: StoreEmployeeConfig, loadedFrom = 'config'): void {
    this.db
      .prepare(
        `
          INSERT INTO employees (id, name, role, approval_limits, voice_id, loaded_from, updated_at)
          VALUES (@id, @name, @role, @approval_limits, @voice_id, @loaded_from, @updated_at)
          ON CONFLICT(id) DO UPDATE SET
            name = excluded.name,
            role = excluded.role,
            approval_limits = excluded.approval_limits,
            voice_id = excluded.voice_id,
            loaded_from = excluded.loaded_from,
            updated_at = excluded.updated_at
        `,
      )
      .run({
        id: employee.id,
        name: employee.name,
        role: employee.role,
        approval_limits: stringifyJson(employee.approval_limits ?? {}),
        voice_id: employee.voice_id ?? null,
        loaded_from: loadedFrom,
        updated_at: Date.now(),
      })
  }

  deleteMissingConfigEmployees(ids: string[]): void {
    if (ids.length === 0) {
      this.db.prepare(`DELETE FROM employees WHERE loaded_from = 'config'`).run()
      return
    }

    const placeholders = ids.map(() => '?').join(', ')
    this.db
      .prepare(`DELETE FROM employees WHERE loaded_from = 'config' AND id NOT IN (${placeholders})`)
      .run(...ids)
  }

  findById(id: string): EmployeeRow | null {
    const row = this.db.prepare('SELECT * FROM employees WHERE id = ?').get(id) as
      | Record<string, unknown>
      | undefined

    return row ? mapEmployee(row) : null
  }

  findByVoiceId(voiceId: string): EmployeeRow | null {
    const row = this.db.prepare('SELECT * FROM employees WHERE voice_id = ?').get(voiceId) as
      | Record<string, unknown>
      | undefined

    return row ? mapEmployee(row) : null
  }

  list(): EmployeeRow[] {
    const rows = this.db
      .prepare('SELECT * FROM employees ORDER BY role DESC, name ASC')
      .all() as Array<Record<string, unknown>>

    return rows.map(mapEmployee)
  }
}

function mapEmployee(row: Record<string, unknown>): EmployeeRow {
  return {
    id: String(row.id),
    name: String(row.name),
    role: String(row.role),
    approval_limits: parseJson(String(row.approval_limits ?? '{}'), {}),
    voice_id: row.voice_id ? String(row.voice_id) : undefined,
    loaded_from: String(row.loaded_from ?? 'config'),
    updated_at: Number(row.updated_at),
  }
}
