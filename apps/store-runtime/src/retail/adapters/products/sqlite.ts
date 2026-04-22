import BetterSqlite3 from 'better-sqlite3'
import type { Database } from 'better-sqlite3'
import type { RetailAdapterCatalogDeps } from '../catalog.js'
import type {
  AdapterExecutionContext,
  AdapterHealth,
  InventoryAdapter,
  InventoryCheckResult,
  ProductAdapter,
  ProductRecord,
  ProductSearchResult,
} from '../catalog.js'
import { RetailAdapterError } from '../catalog.js'

interface SqliteAdapterOptions {
  table: string
  idColumn: string
  nameColumn: string
  descriptionColumn: string
  priceColumn: string
  stockColumn: string
  metadataColumn: string
}

export function createSqliteProductAdapter(deps: RetailAdapterCatalogDeps): ProductAdapter {
  const connector = deps.config.connectors.products
  const { database, external } = resolveConnectorDb(
    deps,
    connector.database ?? connector.connection_string,
  )
  const options = readSqliteAdapterOptions(connector.options)

  return {
    driver: 'sqlite',
    capabilities() {
      return ['search']
    },
    async health(): Promise<AdapterHealth> {
      database.prepare('SELECT 1').get()
      database.prepare(`SELECT 1 FROM ${quoteIdentifier(options.table)} LIMIT 1`).get()

      return {
        ok: true,
        driver: 'sqlite',
        details: {
          connector: 'products',
          database:
            connector.database ?? connector.connection_string ?? deps.config.storage.sqlite_path,
          table: options.table,
        },
      }
    },
    async execute(
      _action: 'search',
      input: {
        query: string
        limit?: number
      },
      _context: AdapterExecutionContext,
    ): Promise<ProductSearchResult> {
      const query = input.query.trim()
      const searchTerm = `%${query}%`
      const rows = database
        .prepare(
          `
            SELECT
              ${quoteIdentifier(options.idColumn)} AS id,
              ${quoteIdentifier(options.nameColumn)} AS name,
              ${quoteIdentifier(options.descriptionColumn)} AS description,
              ${quoteIdentifier(options.priceColumn)} AS price,
              ${quoteIdentifier(options.stockColumn)} AS stock,
              ${quoteIdentifier(options.metadataColumn)} AS metadata
            FROM ${quoteIdentifier(options.table)}
            WHERE ${quoteIdentifier(options.nameColumn)} LIKE ?
              OR ${quoteIdentifier(options.descriptionColumn)} LIKE ?
            ORDER BY ${quoteIdentifier(options.stockColumn)} DESC, ${quoteIdentifier(options.nameColumn)} ASC
            LIMIT ?
          `,
        )
        .all(searchTerm, searchTerm, clampLimit(input.limit)) as Array<Record<string, unknown>>

      const products = rows.map(mapProductRow)
      return {
        products,
        text:
          products.length > 0
            ? `Encontré ${products.length} producto(s) para "${query}".`
            : `No encontré productos para "${query}".`,
      }
    },
    dispose() {
      if (external) {
        database.close()
      }
    },
  }
}

export function createSqliteInventoryAdapter(deps: RetailAdapterCatalogDeps): InventoryAdapter {
  const connector = deps.config.connectors.inventory
  const { database, external } = resolveConnectorDb(
    deps,
    connector.database ?? connector.connection_string,
  )
  const options = readSqliteAdapterOptions(connector.options)

  return {
    driver: 'sqlite',
    capabilities() {
      return ['inventory_check']
    },
    async health(): Promise<AdapterHealth> {
      database.prepare('SELECT 1').get()
      database.prepare(`SELECT 1 FROM ${quoteIdentifier(options.table)} LIMIT 1`).get()

      return {
        ok: true,
        driver: 'sqlite',
        details: {
          connector: 'inventory',
          database:
            connector.database ?? connector.connection_string ?? deps.config.storage.sqlite_path,
          table: options.table,
        },
      }
    },
    async execute(
      _action: 'inventory_check',
      input: {
        product_id?: string
        query?: string
        limit?: number
      },
      _context: AdapterExecutionContext,
    ): Promise<InventoryCheckResult> {
      const limit = clampLimit(input.limit)
      let rows: Array<Record<string, unknown>> = []

      if (input.product_id) {
        rows = database
          .prepare(
            `
              SELECT
                ${quoteIdentifier(options.idColumn)} AS id,
                ${quoteIdentifier(options.nameColumn)} AS name,
                ${quoteIdentifier(options.descriptionColumn)} AS description,
                ${quoteIdentifier(options.priceColumn)} AS price,
                ${quoteIdentifier(options.stockColumn)} AS stock,
                ${quoteIdentifier(options.metadataColumn)} AS metadata
              FROM ${quoteIdentifier(options.table)}
              WHERE ${quoteIdentifier(options.idColumn)} = ?
              LIMIT ?
            `,
          )
          .all(input.product_id, limit) as Array<Record<string, unknown>>
      } else if (input.query) {
        const searchTerm = `%${input.query}%`
        rows = database
          .prepare(
            `
              SELECT
                ${quoteIdentifier(options.idColumn)} AS id,
                ${quoteIdentifier(options.nameColumn)} AS name,
                ${quoteIdentifier(options.descriptionColumn)} AS description,
                ${quoteIdentifier(options.priceColumn)} AS price,
                ${quoteIdentifier(options.stockColumn)} AS stock,
                ${quoteIdentifier(options.metadataColumn)} AS metadata
              FROM ${quoteIdentifier(options.table)}
              WHERE ${quoteIdentifier(options.nameColumn)} LIKE ?
                OR ${quoteIdentifier(options.descriptionColumn)} LIKE ?
              ORDER BY ${quoteIdentifier(options.stockColumn)} DESC, ${quoteIdentifier(options.nameColumn)} ASC
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
                ${quoteIdentifier(options.descriptionColumn)} AS description,
                ${quoteIdentifier(options.priceColumn)} AS price,
                ${quoteIdentifier(options.stockColumn)} AS stock,
                ${quoteIdentifier(options.metadataColumn)} AS metadata
              FROM ${quoteIdentifier(options.table)}
              ORDER BY ${quoteIdentifier(options.stockColumn)} DESC, ${quoteIdentifier(options.nameColumn)} ASC
              LIMIT ?
            `,
          )
          .all(limit) as Array<Record<string, unknown>>
      }

      const products = rows.map(mapProductRow)

      return {
        products,
        in_stock: products.some((product) => product.stock > 0),
        text:
          products.length > 0
            ? `Hay ${products.filter((product) => product.stock > 0).length} producto(s) con stock disponible.`
            : 'No encontré coincidencias de inventario.',
      }
    },
    dispose() {
      if (external) {
        database.close()
      }
    },
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
    database: new BetterSqlite3(candidatePath, { readonly: true }),
    external: true,
  }
}

function readSqliteAdapterOptions(options: Record<string, unknown>): SqliteAdapterOptions {
  return {
    table: readIdentifier(options.table, 'products'),
    idColumn: readIdentifier(options.id_column, 'id'),
    nameColumn: readIdentifier(options.name_column, 'name'),
    descriptionColumn: readIdentifier(options.description_column, 'description'),
    priceColumn: readIdentifier(options.price_column, 'price'),
    stockColumn: readIdentifier(options.stock_column, 'stock'),
    metadataColumn: readIdentifier(options.metadata_column, 'metadata'),
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

function mapProductRow(row: Record<string, unknown>): ProductRecord {
  return {
    id: String(row.id),
    name: String(row.name),
    description: String(row.description ?? ''),
    price: Number(row.price ?? 0),
    stock: Number(row.stock ?? 0),
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
        message: `Could not parse product metadata JSON: ${
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
