import BetterSqlite3 from 'better-sqlite3'
import type { Database } from 'better-sqlite3'
import type { RetailAdapterCatalogDeps } from '../catalog.js'
import type {
  AdapterExecutionContext,
  AdapterHealth,
  OrderAdapter,
  OrderConfirmResult,
  OrderCreateInput,
  OrderCreateResult,
  OrderLineResult,
  OrderUpdateInput,
  OrderUpdateResult,
} from '../catalog.js'
import { RetailAdapterError } from '../catalog.js'

interface SqliteOrderOptions {
  table: string
  idColumn: string
  sessionIdColumn: string
  draftIdColumn: string
  toolIdColumn: string
  paramsColumn: string
  resultColumn: string
  statusColumn: string
  createdAtColumn: string
  updatedAtColumn: string
  productsTable?: string
  productsIdColumn: string
  productsNameColumn: string
}

interface StoredOrder {
  id: string
  session_id: string
  draft_id?: string | null
  tool_id: string
  params: Record<string, unknown>
  result?: Record<string, unknown> | null
  status: string
  created_at: number
  updated_at: number
}

interface OrderLine {
  product_id: string
  quantity: number
  price: number
}

export function createSqliteOrderAdapter(deps: RetailAdapterCatalogDeps): OrderAdapter {
  const connector = deps.config.connectors.orders
  const { database, external } = resolveConnectorDb(
    deps,
    connector.database ?? connector.connection_string,
  )
  const options = readSqliteAdapterOptions(connector.options)
  const hasProductsTable = options.productsTable
    ? tableExists(database, options.productsTable)
    : false

  return {
    driver: 'sqlite',
    capabilities() {
      return ['create', 'update', 'confirm']
    },
    async health(): Promise<AdapterHealth> {
      database.prepare('SELECT 1').get()
      database.prepare(`SELECT 1 FROM ${quoteIdentifier(options.table)} LIMIT 1`).get()

      return {
        ok: true,
        driver: 'sqlite',
        details: {
          connector: 'orders',
          database:
            connector.database ?? connector.connection_string ?? deps.config.storage.sqlite_path,
          table: options.table,
        },
      }
    },
    async execute(action, input, context) {
      switch (action) {
        case 'create':
          return createOrder(
            database,
            options,
            hasProductsTable,
            input as OrderCreateInput,
            context,
          )
        case 'update':
          return updateOrder(database, options, hasProductsTable, input as OrderUpdateInput)
        case 'confirm':
          return confirmOrder(
            database,
            options,
            hasProductsTable,
            (input as { order_id: string }).order_id,
          )
      }
    },
    dispose() {
      if (external) {
        database.close()
      }
    },
  }
}

function createOrder(
  database: Database,
  options: SqliteOrderOptions,
  hasProductsTable: boolean,
  input: OrderCreateInput,
  context: AdapterExecutionContext,
): OrderCreateResult {
  const items = input.items
    .map(normalizeLine)
    .filter((line) => line.product_id && line.quantity > 0)
  if (items.length === 0) {
    throw new Error('order_create requires at least one valid item')
  }

  const total = sumTotal(items)
  const orderId = `ord_${Date.now()}`
  const now = Date.now()

  database
    .prepare(
      `
        INSERT INTO ${quoteIdentifier(options.table)} (
          ${quoteIdentifier(options.idColumn)},
          ${quoteIdentifier(options.sessionIdColumn)},
          ${quoteIdentifier(options.draftIdColumn)},
          ${quoteIdentifier(options.toolIdColumn)},
          ${quoteIdentifier(options.paramsColumn)},
          ${quoteIdentifier(options.resultColumn)},
          ${quoteIdentifier(options.statusColumn)},
          ${quoteIdentifier(options.createdAtColumn)},
          ${quoteIdentifier(options.updatedAtColumn)}
        )
        VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)
      `,
    )
    .run(
      orderId,
      context.session_id,
      null,
      'order_create',
      JSON.stringify({
        customer_id: input.customer_id ?? null,
        items,
      }),
      JSON.stringify({
        order_id: orderId,
        total,
        item_count: items.length,
        order_state: 'open',
      }),
      'completed',
      now,
      now,
    )

  return {
    order_id: orderId,
    total,
    item_count: items.length,
    order_state: 'open',
    items: expandOrderLines(database, options, hasProductsTable, items),
    text: `La orden ${orderId} quedó preparada por ${formatCurrency(total)}.`,
  }
}

function updateOrder(
  database: Database,
  options: SqliteOrderOptions,
  hasProductsTable: boolean,
  input: OrderUpdateInput,
): OrderUpdateResult {
  const existing = findOrder(database, options, input.order_id)
  if (!existing) {
    throw new Error(`Order ${input.order_id} was not found`)
  }

  const existingItems = Array.isArray(existing.params.items)
    ? (existing.params.items as unknown[]).map(normalizeLine).filter((line) => line.product_id)
    : []

  let items = input.items?.length
    ? input.items.map(normalizeLine).filter((line) => line.product_id && line.quantity > 0)
    : existingItems

  if (input.add_items?.length) {
    const additions = input.add_items
      .map(normalizeLine)
      .filter((line) => line.product_id && line.quantity > 0)
    items = mergeItems(items, additions)
  }

  if (input.remove_product_ids?.length) {
    const removeIds = new Set(input.remove_product_ids.map((entry) => entry.trim()).filter(Boolean))
    items = items.filter((line) => !removeIds.has(line.product_id))
  }

  if (items.length === 0) {
    throw new Error('order_update cannot leave an order without items')
  }

  const total = sumTotal(items)
  const previousResult = existing.result ?? {}
  const orderState = previousResult.order_state === 'confirmed' ? 'confirmed' : ('open' as const)

  database
    .prepare(
      `
        UPDATE ${quoteIdentifier(options.table)}
        SET
          ${quoteIdentifier(options.paramsColumn)} = ?,
          ${quoteIdentifier(options.resultColumn)} = ?,
          ${quoteIdentifier(options.statusColumn)} = ?,
          ${quoteIdentifier(options.updatedAtColumn)} = ?
        WHERE ${quoteIdentifier(options.idColumn)} = ?
      `,
    )
    .run(
      JSON.stringify({
        ...existing.params,
        items,
      }),
      JSON.stringify({
        ...previousResult,
        order_id: existing.id,
        total,
        item_count: items.length,
        order_state: orderState,
      }),
      existing.status,
      Date.now(),
      existing.id,
    )

  return {
    order_id: existing.id,
    total,
    item_count: items.length,
    order_state: orderState,
    items: expandOrderLines(database, options, hasProductsTable, items),
    text: `Actualicé la orden ${existing.id}. Nuevo total: ${formatCurrency(total)}.`,
  }
}

function confirmOrder(
  database: Database,
  options: SqliteOrderOptions,
  hasProductsTable: boolean,
  orderId: string,
): OrderConfirmResult {
  const existing = findOrder(database, options, orderId)
  if (!existing) {
    throw new Error(`Order ${orderId} was not found`)
  }

  const previousResult = existing.result ?? {}
  const items = Array.isArray(existing.params.items)
    ? (existing.params.items as unknown[])
        .map(normalizeLine)
        .filter((line) => line.product_id && line.quantity > 0)
    : []
  const total = typeof previousResult.total === 'number' ? previousResult.total : sumTotal(items)

  database
    .prepare(
      `
        UPDATE ${quoteIdentifier(options.table)}
        SET
          ${quoteIdentifier(options.resultColumn)} = ?,
          ${quoteIdentifier(options.statusColumn)} = ?,
          ${quoteIdentifier(options.updatedAtColumn)} = ?
        WHERE ${quoteIdentifier(options.idColumn)} = ?
      `,
    )
    .run(
      JSON.stringify({
        ...previousResult,
        order_id: existing.id,
        total,
        item_count:
          typeof previousResult.item_count === 'number' ? previousResult.item_count : items.length,
        order_state: 'confirmed',
        payment_status: 'awaiting_payment',
        confirmed_at: Date.now(),
      }),
      existing.status,
      Date.now(),
      existing.id,
    )

  return {
    order_id: existing.id,
    total,
    order_state: 'confirmed',
    payment_status: 'awaiting_payment',
    items: expandOrderLines(database, options, hasProductsTable, items),
    text: `La orden ${existing.id} quedó confirmada y lista para pago.`,
  }
}

function findOrder(
  database: Database,
  options: SqliteOrderOptions,
  orderId: string,
): StoredOrder | null {
  const row = database
    .prepare(
      `
        SELECT
          ${quoteIdentifier(options.idColumn)} AS id,
          ${quoteIdentifier(options.sessionIdColumn)} AS session_id,
          ${quoteIdentifier(options.draftIdColumn)} AS draft_id,
          ${quoteIdentifier(options.toolIdColumn)} AS tool_id,
          ${quoteIdentifier(options.paramsColumn)} AS params,
          ${quoteIdentifier(options.resultColumn)} AS result,
          ${quoteIdentifier(options.statusColumn)} AS status,
          ${quoteIdentifier(options.createdAtColumn)} AS created_at,
          ${quoteIdentifier(options.updatedAtColumn)} AS updated_at
        FROM ${quoteIdentifier(options.table)}
        WHERE ${quoteIdentifier(options.idColumn)} = ?
        LIMIT 1
      `,
    )
    .get(orderId) as Record<string, unknown> | undefined

  return row ? mapStoredOrder(row) : null
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

function readSqliteAdapterOptions(options: Record<string, unknown>): SqliteOrderOptions {
  return {
    table: readIdentifier(options.table, 'orders'),
    idColumn: readIdentifier(options.id_column, 'id'),
    sessionIdColumn: readIdentifier(options.session_id_column, 'session_id'),
    draftIdColumn: readIdentifier(options.draft_id_column, 'draft_id'),
    toolIdColumn: readIdentifier(options.tool_id_column, 'tool_id'),
    paramsColumn: readIdentifier(options.params_column, 'params'),
    resultColumn: readIdentifier(options.result_column, 'result'),
    statusColumn: readIdentifier(options.status_column, 'status'),
    createdAtColumn: readIdentifier(options.created_at_column, 'created_at'),
    updatedAtColumn: readIdentifier(options.updated_at_column, 'updated_at'),
    productsTable: readOptionalIdentifier(options.products_table) ?? 'products',
    productsIdColumn: readIdentifier(options.products_id_column, 'id'),
    productsNameColumn: readIdentifier(options.products_name_column, 'name'),
  }
}

function tableExists(database: Database, table: string): boolean {
  const row = database
    .prepare(
      `
        SELECT 1
        FROM sqlite_master
        WHERE type = 'table' AND name = ?
        LIMIT 1
      `,
    )
    .get(table)

  return Boolean(row)
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

function readOptionalIdentifier(value: unknown): string | undefined {
  if (typeof value !== 'string') {
    return undefined
  }

  const normalized = value.trim()
  if (!normalized || !/^[A-Za-z_][A-Za-z0-9_]*$/.test(normalized)) {
    return undefined
  }

  return normalized
}

function mapStoredOrder(row: Record<string, unknown>): StoredOrder {
  return {
    id: String(row.id),
    session_id: String(row.session_id),
    draft_id: row.draft_id ? String(row.draft_id) : null,
    tool_id: String(row.tool_id),
    params: parseJsonObject(row.params, 'order params'),
    result: row.result ? parseJsonObject(row.result, 'order result') : null,
    status: String(row.status),
    created_at: Number(row.created_at),
    updated_at: Number(row.updated_at),
  }
}

function parseJsonObject(value: unknown, label: string): Record<string, unknown> {
  if (!value) {
    return {}
  }

  if (typeof value === 'string') {
    try {
      const parsed = JSON.parse(value)
      return parsed && typeof parsed === 'object' ? (parsed as Record<string, unknown>) : {}
    } catch (error) {
      throw new RetailAdapterError({
        code: 'sqlite_json_invalid',
        message: `Could not parse ${label} JSON: ${
          error instanceof Error ? error.message : String(error)
        }`,
        retryable: false,
      })
    }
  }

  return typeof value === 'object' ? (value as Record<string, unknown>) : {}
}

function normalizeLine(value: unknown): OrderLine {
  const payload = value && typeof value === 'object' ? (value as Record<string, unknown>) : {}

  return {
    product_id: String(payload.product_id ?? '').trim(),
    quantity: Number(payload.quantity ?? 0),
    price: Number(payload.price ?? 0),
  }
}

function mergeItems(existing: OrderLine[], additions: OrderLine[]): OrderLine[] {
  const merged = new Map(existing.map((line) => [line.product_id, { ...line }]))

  for (const line of additions) {
    const current = merged.get(line.product_id)
    if (current) {
      current.quantity += line.quantity
      current.price = line.price || current.price
      continue
    }

    merged.set(line.product_id, { ...line })
  }

  return [...merged.values()].filter((line) => line.quantity > 0)
}

function sumTotal(items: OrderLine[]): number {
  return items.reduce((sum, item) => sum + item.quantity * item.price, 0)
}

function expandOrderLines(
  database: Database,
  options: SqliteOrderOptions,
  hasProductsTable: boolean,
  items: OrderLine[],
): OrderLineResult[] {
  return items.map((item) => ({
    product_id: item.product_id,
    name: lookupProductName(database, options, hasProductsTable, item.product_id),
    quantity: item.quantity,
    price: item.price,
    line_total: item.quantity * item.price,
  }))
}

function lookupProductName(
  database: Database,
  options: SqliteOrderOptions,
  hasProductsTable: boolean,
  productId: string,
): string {
  if (!hasProductsTable || !options.productsTable) {
    return productId
  }

  const row = database
    .prepare(
      `
        SELECT ${quoteIdentifier(options.productsNameColumn)} AS name
        FROM ${quoteIdentifier(options.productsTable)}
        WHERE ${quoteIdentifier(options.productsIdColumn)} = ?
        LIMIT 1
      `,
    )
    .get(productId) as Record<string, unknown> | undefined

  return typeof row?.name === 'string' ? row.name : productId
}

function formatCurrency(amount: number): string {
  return new Intl.NumberFormat('es', {
    style: 'currency',
    currency: 'USD',
  }).format(amount)
}
