import BetterSqlite3 from 'better-sqlite3'
import type { Database } from 'better-sqlite3'
import type { RetailAdapterCatalogDeps } from '../catalog.js'
import type {
  AdapterHealth,
  CustomerAdapter,
  CustomerLookupResult,
  CustomerRegisterResult,
} from '../catalog.js'
import { RetailAdapterError } from '../catalog.js'

interface CustomerSqliteOptions {
  table: string
  idColumn: string
  nameColumn: string
  localeColumn: string
  metadataColumn: string
  createdAtColumn: string
  updatedAtColumn: string
}

export function createSqliteCustomerAdapter(deps: RetailAdapterCatalogDeps): CustomerAdapter {
  const connector = deps.config.connectors.customers
  const { database, external } = resolveConnectorDb(
    deps,
    connector.database ?? connector.connection_string,
  )
  const options = readSqliteAdapterOptions(connector.options)

  return {
    driver: 'sqlite',
    capabilities() {
      return ['lookup', 'register']
    },
    async health(): Promise<AdapterHealth> {
      database.prepare('SELECT 1').get()
      database.prepare(`SELECT 1 FROM ${quoteIdentifier(options.table)} LIMIT 1`).get()

      return {
        ok: true,
        driver: 'sqlite',
        details: {
          connector: 'customers',
          database:
            connector.database ?? connector.connection_string ?? deps.config.storage.sqlite_path,
          table: options.table,
        },
      }
    },
    async execute(action, input, _context) {
      if (action === 'register') {
        return registerCustomer(
          database,
          options,
          input as {
            name: string
            locale?: string
            metadata?: Record<string, unknown>
          },
        )
      }

      return lookupCustomers(
        database,
        options,
        input as {
          customer_id?: string
          query?: string
          limit?: number
        },
      )
    },
    dispose() {
      if (external) {
        database.close()
      }
    },
  }
}

function lookupCustomers(
  database: Database,
  options: CustomerSqliteOptions,
  input: {
    customer_id?: string
    query?: string
    limit?: number
  },
): CustomerLookupResult {
  const limit = clampLimit(input.limit)
  let rows: Array<Record<string, unknown>> = []

  if (input.customer_id?.trim()) {
    rows = database
      .prepare(
        `
          SELECT
            ${quoteIdentifier(options.idColumn)} AS id,
            ${quoteIdentifier(options.nameColumn)} AS name,
            ${quoteIdentifier(options.localeColumn)} AS locale,
            ${quoteIdentifier(options.metadataColumn)} AS metadata
          FROM ${quoteIdentifier(options.table)}
          WHERE ${quoteIdentifier(options.idColumn)} = ?
          LIMIT ?
        `,
      )
      .all(input.customer_id.trim(), limit) as Array<Record<string, unknown>>
  } else if (input.query?.trim()) {
    const searchTerm = `%${input.query.trim()}%`
    rows = database
      .prepare(
        `
          SELECT
            ${quoteIdentifier(options.idColumn)} AS id,
            ${quoteIdentifier(options.nameColumn)} AS name,
            ${quoteIdentifier(options.localeColumn)} AS locale,
            ${quoteIdentifier(options.metadataColumn)} AS metadata
          FROM ${quoteIdentifier(options.table)}
          WHERE ${quoteIdentifier(options.idColumn)} LIKE ?
            OR ${quoteIdentifier(options.nameColumn)} LIKE ?
          ORDER BY ${quoteIdentifier(options.updatedAtColumn)} DESC, ${quoteIdentifier(options.nameColumn)} ASC
          LIMIT ?
        `,
      )
      .all(searchTerm, searchTerm, limit) as Array<Record<string, unknown>>
  } else {
    rows = database
      .prepare(
        `
          SELECT
            ${quoteIdentifier(options.idColumn)} AS id,
            ${quoteIdentifier(options.nameColumn)} AS name,
            ${quoteIdentifier(options.localeColumn)} AS locale,
            ${quoteIdentifier(options.metadataColumn)} AS metadata
          FROM ${quoteIdentifier(options.table)}
          ORDER BY ${quoteIdentifier(options.updatedAtColumn)} DESC, ${quoteIdentifier(options.nameColumn)} ASC
          LIMIT ?
        `,
      )
      .all(limit) as Array<Record<string, unknown>>
  }

  const customers = rows.map(mapCustomerRow)
  return {
    customers,
    text:
      customers.length > 0
        ? `Encontré ${customers.length} cliente(s) coincidente(s).`
        : 'No encontré clientes con esos datos.',
  }
}

function registerCustomer(
  database: Database,
  options: CustomerSqliteOptions,
  input: {
    name: string
    locale?: string
    metadata?: Record<string, unknown>
  },
): CustomerRegisterResult {
  const customerId = `cust_${Date.now()}`
  const now = Date.now()

  database
    .prepare(
      `
        INSERT INTO ${quoteIdentifier(options.table)} (
          ${quoteIdentifier(options.idColumn)},
          ${quoteIdentifier(options.nameColumn)},
          ${quoteIdentifier(options.localeColumn)},
          ${quoteIdentifier(options.metadataColumn)},
          ${quoteIdentifier(options.createdAtColumn)},
          ${quoteIdentifier(options.updatedAtColumn)}
        )
        VALUES (?, ?, ?, ?, ?, ?)
        ON CONFLICT(${quoteIdentifier(options.idColumn)}) DO UPDATE SET
          ${quoteIdentifier(options.nameColumn)} = excluded.${quoteIdentifier(options.nameColumn)},
          ${quoteIdentifier(options.localeColumn)} = excluded.${quoteIdentifier(options.localeColumn)},
          ${quoteIdentifier(options.metadataColumn)} = excluded.${quoteIdentifier(options.metadataColumn)},
          ${quoteIdentifier(options.updatedAtColumn)} = excluded.${quoteIdentifier(options.updatedAtColumn)}
      `,
    )
    .run(
      customerId,
      input.name.trim(),
      input.locale?.trim() || 'es',
      JSON.stringify(input.metadata ?? {}),
      now,
      now,
    )

  return {
    customer_id: customerId,
    text: `Registré a ${input.name.trim()} correctamente.`,
  }
}

function resolveConnectorDb(
  deps: RetailAdapterCatalogDeps,
  configuredPath: string | undefined,
): { database: Database; external: boolean } {
  const candidatePath = configuredPath ?? deps.config.storage.sqlite_path
  if (candidatePath === deps.config.storage.sqlite_path) {
    return {
      database: deps.db,
      external: false,
    }
  }

  return {
    database: new BetterSqlite3(candidatePath),
    external: true,
  }
}

function readSqliteAdapterOptions(options: Record<string, unknown>): CustomerSqliteOptions {
  return {
    table: readIdentifier(options.table, 'customers'),
    idColumn: readIdentifier(options.id_column, 'id'),
    nameColumn: readIdentifier(options.name_column, 'name'),
    localeColumn: readIdentifier(options.locale_column, 'locale'),
    metadataColumn: readIdentifier(options.metadata_column, 'metadata'),
    createdAtColumn: readIdentifier(options.created_at_column, 'created_at'),
    updatedAtColumn: readIdentifier(options.updated_at_column, 'updated_at'),
  }
}

function quoteIdentifier(value: string): string {
  return `"${value.replaceAll('"', '""')}"`
}

function readIdentifier(value: unknown, fallback: string): string {
  if (typeof value !== 'string' || !/^[A-Za-z_][A-Za-z0-9_]*$/.test(value)) {
    return fallback
  }

  return value
}

function mapCustomerRow(row: Record<string, unknown>): {
  id: string
  name: string
  locale: string
  metadata: Record<string, unknown>
} {
  return {
    id: String(row.id),
    name: String(row.name),
    locale: String(row.locale ?? 'es'),
    metadata: parseMetadata(row.metadata),
  }
}

function parseMetadata(value: unknown): Record<string, unknown> {
  if (!value) {
    return {}
  }

  if (typeof value === 'string') {
    try {
      const parsed = JSON.parse(value)
      return parsed && typeof parsed === 'object' ? (parsed as Record<string, unknown>) : {}
    } catch (error) {
      throw new RetailAdapterError({
        code: 'sqlite_metadata_invalid',
        message: `Could not parse customer metadata JSON: ${
          error instanceof Error ? error.message : String(error)
        }`,
        retryable: false,
      })
    }
  }

  return typeof value === 'object' ? (value as Record<string, unknown>) : {}
}

function clampLimit(value: number | undefined): number {
  if (!Number.isInteger(value) || !value) {
    return 5
  }

  return Math.max(1, Math.min(20, value))
}
