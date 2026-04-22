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

export function createMockProductAdapter(deps: RetailAdapterCatalogDeps): ProductAdapter {
  return {
    driver: 'mock',
    capabilities() {
      return ['search']
    },
    async health(): Promise<AdapterHealth> {
      return {
        ok: true,
        driver: 'mock',
        details: {
          connector: 'products',
          mode: 'sqlite-seeded',
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
      const limit = clampLimit(input.limit)
      const searchTerm = `%${query}%`
      const rows = deps.db
        .prepare(
          `
            SELECT id, name, description, price, stock, metadata
            FROM products
            WHERE name LIKE ? OR description LIKE ?
            ORDER BY stock DESC, name ASC
            LIMIT ?
          `,
        )
        .all(searchTerm, searchTerm, limit) as Array<Record<string, unknown>>
      const products = rows.map(mapProductRow)
      return {
        products,
        text:
          products.length > 0
            ? `Encontré ${products.length} producto(s) para "${query}".`
            : `No encontré productos para "${query}".`,
      }
    },
  }
}

export function createMockInventoryAdapter(deps: RetailAdapterCatalogDeps): InventoryAdapter {
  return {
    driver: 'mock',
    capabilities() {
      return ['inventory_check']
    },
    async health(): Promise<AdapterHealth> {
      return {
        ok: true,
        driver: 'mock',
        details: {
          connector: 'inventory',
          mode: 'sqlite-seeded',
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
      const productId = input.product_id?.trim()
      const query = input.query?.trim()

      let products: ProductRecord[] = []
      if (productId) {
        const rows = deps.db
          .prepare(
            `
              SELECT id, name, description, price, stock, metadata
              FROM products
              WHERE id = ?
            `,
          )
          .all(productId) as Array<Record<string, unknown>>
        products = rows.map(mapProductRow)
      } else if (query) {
        const searchTerm = `%${query}%`
        const rows = deps.db
          .prepare(
            `
              SELECT id, name, description, price, stock, metadata
              FROM products
              WHERE name LIKE ? OR description LIKE ?
              ORDER BY stock DESC, name ASC
              LIMIT ?
            `,
          )
          .all(searchTerm, searchTerm, limit) as Array<Record<string, unknown>>
        products = rows.map(mapProductRow)
      } else {
        const rows = deps.db
          .prepare(
            `
              SELECT id, name, description, price, stock, metadata
              FROM products
              ORDER BY stock DESC, name ASC
              LIMIT ?
            `,
          )
          .all(limit) as Array<Record<string, unknown>>
        products = rows.map(mapProductRow)
      }

      const inStock = products.some((product) => product.stock > 0)

      return {
        products,
        in_stock: inStock,
        text:
          products.length > 0
            ? `Hay ${products.filter((product) => product.stock > 0).length} producto(s) con stock disponible.`
            : 'No encontré coincidencias de inventario.',
      }
    },
  }
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
  if (typeof value !== 'string' || value.length === 0) {
    return {}
  }

  try {
    const parsed = JSON.parse(value)
    return parsed && typeof parsed === 'object' ? (parsed as Record<string, unknown>) : {}
  } catch {
    return {}
  }
}

function clampLimit(value: number | undefined): number {
  if (!Number.isInteger(value) || !value) {
    return 5
  }

  return Math.max(1, Math.min(20, value))
}
