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
      const { products, catalogFallback } = searchSeededProducts(deps, query, limit)
      return {
        products,
        text: buildProductSearchText(query, products.length, catalogFallback),
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
        products = searchSeededProducts(deps, query, limit).products
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

function searchSeededProducts(
  deps: RetailAdapterCatalogDeps,
  query: string,
  limit: number,
): {
  products: ProductRecord[]
  catalogFallback: boolean
} {
  const products = listSeededProducts(deps, Math.max(limit, 50))
  const terms = extractSearchTerms(query)

  if (terms.length === 0) {
    return {
      products: products.slice(0, limit),
      catalogFallback: true,
    }
  }

  const scoredProducts = products
    .map((product) => ({
      product,
      score: scoreProduct(product, query, terms),
    }))
    .filter(({ score }) => score > 0)
    .sort((left, right) => {
      if (right.score !== left.score) {
        return right.score - left.score
      }

      if (right.product.stock !== left.product.stock) {
        return right.product.stock - left.product.stock
      }

      return left.product.name.localeCompare(right.product.name)
    })
    .slice(0, limit)
    .map(({ product }) => product)

  return {
    products: scoredProducts,
    catalogFallback: false,
  }
}

function listSeededProducts(deps: RetailAdapterCatalogDeps, limit: number): ProductRecord[] {
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

  return rows.map(mapProductRow)
}

function buildProductSearchText(
  query: string,
  productCount: number,
  catalogFallback: boolean,
): string {
  if (productCount === 0) {
    return `No encontré productos para "${query}".`
  }

  if (catalogFallback) {
    return 'Estos son algunos productos disponibles.'
  }

  return `Encontré ${productCount} producto(s) para "${query}".`
}

function scoreProduct(product: ProductRecord, query: string, terms: string[]): number {
  const name = normalizeSearchText(product.name)
  const haystack = normalizeSearchText(
    `${product.id} ${product.name} ${product.description} ${JSON.stringify(product.metadata)}`,
  )
  const numericTerms = terms.filter((term) => /^\d+$/.test(term))

  if (numericTerms.some((term) => !haystack.includes(term))) {
    return 0
  }

  let score = 0
  let matchedTerms = 0

  for (const term of terms) {
    if (name.includes(term)) {
      score += 4
      matchedTerms += 1
    } else if (haystack.includes(term)) {
      score += 2
      matchedTerms += 1
    }
  }

  if (matchedTerms === 0) {
    return 0
  }

  if (matchedTerms === terms.length) {
    score += 6
  }

  const normalizedQuery = normalizeSearchText(query)
  if (normalizedQuery.length > 0 && haystack.includes(normalizedQuery)) {
    score += 10
  }

  return score
}

function extractSearchTerms(query: string): string[] {
  const terms = normalizeSearchText(query)
    .split(' ')
    .map((term) => SEARCH_SYNONYMS.get(term) ?? term)
    .filter((term) => term.length > 0)
    .filter((term) => /^\d+$/.test(term) || term.length > 2)
    .filter((term) => !GENERIC_SEARCH_TERMS.has(term))

  return [...new Set(terms)]
}

function normalizeSearchText(value: string): string {
  return value
    .normalize('NFD')
    .replace(/[\u0300-\u036f]/g, '')
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, ' ')
    .trim()
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

const GENERIC_SEARCH_TERMS = new Set([
  'alguno',
  'algunos',
  'catalogo',
  'comprar',
  'dame',
  'disponible',
  'disponibles',
  'hay',
  'informacion',
  'lista',
  'muestra',
  'muestrame',
  'mostrar',
  'producto',
  'productos',
  'puedes',
  'que',
  'quiero',
  'talla',
  'tienda',
  'tienen',
  'tienes',
  'venden',
  'vende',
  'ver',
])

const SEARCH_SYNONYMS = new Map([
  ['shoe', 'tenis'],
  ['shoes', 'tenis'],
  ['sneaker', 'tenis'],
  ['sneakers', 'tenis'],
  ['zapato', 'tenis'],
  ['zapatos', 'tenis'],
  ['zapatilla', 'tenis'],
  ['zapatillas', 'tenis'],
])
