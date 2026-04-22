import type { RetailAdapterCatalogDeps } from '../catalog.js'
import type {
  AdapterExecutionContext,
  AdapterHealth,
  InventoryAdapter,
  InventoryCheckResult,
  ProductAdapter,
  ProductRecord,
  ProductSearchResult,
  RetailAdapterErrorShape,
} from '../catalog.js'
import { RetailAdapterError } from '../catalog.js'

export function createRestProductAdapter(deps: RetailAdapterCatalogDeps): ProductAdapter {
  const connector = deps.config.connectors.products

  return {
    driver: 'rest',
    capabilities() {
      return ['search']
    },
    async health(): Promise<AdapterHealth> {
      const response = await requestJson(
        connector.url,
        connector.headers,
        connector.health_timeout_ms,
      )
      return {
        ok: true,
        driver: 'rest',
        details: {
          connector: 'products',
          status: response.status,
          url: connector.url,
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
      if (!connector.url) {
        throw new RetailAdapterError({
          code: 'missing_rest_url',
          message: 'REST connector requires a url',
          retryable: false,
        })
      }

      const url = new URL(connector.url)
      url.searchParams.set('query', input.query.trim())
      url.searchParams.set('limit', String(clampLimit(input.limit)))

      const response = await requestJson(
        url.toString(),
        connector.headers,
        connector.health_timeout_ms,
      )
      return normalizeProductSearchResponse(response.payload, input.query)
    },
  }
}

export function createRestInventoryAdapter(deps: RetailAdapterCatalogDeps): InventoryAdapter {
  const connector = deps.config.connectors.inventory

  return {
    driver: 'rest',
    capabilities() {
      return ['inventory_check']
    },
    async health(): Promise<AdapterHealth> {
      const response = await requestJson(
        connector.url,
        connector.headers,
        connector.health_timeout_ms,
      )
      return {
        ok: true,
        driver: 'rest',
        details: {
          connector: 'inventory',
          status: response.status,
          url: connector.url,
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
      if (!connector.url) {
        throw new RetailAdapterError({
          code: 'missing_rest_url',
          message: 'REST connector requires a url',
          retryable: false,
        })
      }

      const url = new URL(connector.url)
      if (input.product_id) {
        url.searchParams.set('product_id', input.product_id)
      }
      if (input.query) {
        url.searchParams.set('query', input.query)
      }
      if (input.limit) {
        url.searchParams.set('limit', String(clampLimit(input.limit)))
      }

      const response = await requestJson(
        url.toString(),
        connector.headers,
        connector.health_timeout_ms,
      )
      return normalizeInventoryResponse(response.payload)
    },
  }
}

async function requestJson(
  url: string | undefined,
  headers: Record<string, string>,
  timeoutMs: number,
): Promise<{
  status: number
  payload: unknown
}> {
  if (!url) {
    throw new RetailAdapterError({
      code: 'missing_rest_url',
      message: 'REST connector requires a url',
      retryable: false,
    })
  }

  const controller = new AbortController()
  const timeout = setTimeout(() => controller.abort(), timeoutMs)

  try {
    const response = await fetch(url, {
      method: 'GET',
      headers: {
        accept: 'application/json',
        ...headers,
      },
      signal: controller.signal,
    })

    if (!response.ok) {
      throw new RetailAdapterError({
        code: 'rest_connector_http_error',
        message: `REST connector returned HTTP ${response.status}`,
        retryable: response.status >= 500,
        details: {
          status: response.status,
          url,
        },
      })
    }

    return {
      status: response.status,
      payload: await response.json(),
    }
  } catch (error) {
    if (error instanceof RetailAdapterError) {
      throw error
    }

    const shape: RetailAdapterErrorShape = {
      code:
        error instanceof Error && error.name === 'AbortError'
          ? 'rest_timeout'
          : 'rest_request_failed',
      message:
        error instanceof Error
          ? error.message
          : 'REST connector request failed for an unknown reason',
      retryable: true,
      details: {
        url,
      },
    }
    throw new RetailAdapterError(shape, { cause: error })
  } finally {
    clearTimeout(timeout)
  }
}

function normalizeProductSearchResponse(payload: unknown, query: string): ProductSearchResult {
  const record = toRecord(payload)
  const products = readProducts(record.products ?? record.items ?? payload)
  return {
    products,
    text:
      readString(record.text) ??
      (products.length > 0
        ? `Encontré ${products.length} producto(s) para "${query}".`
        : `No encontré productos para "${query}".`),
  }
}

function normalizeInventoryResponse(payload: unknown): InventoryCheckResult {
  const record = toRecord(payload)
  const products = readProducts(record.products ?? record.items ?? payload)
  return {
    products,
    in_stock:
      typeof record.in_stock === 'boolean'
        ? record.in_stock
        : products.some((product) => product.stock > 0),
    text:
      readString(record.text) ??
      (products.length > 0
        ? `Hay ${products.filter((product) => product.stock > 0).length} producto(s) con stock disponible.`
        : 'No encontré coincidencias de inventario.'),
  }
}

function readProducts(value: unknown): ProductRecord[] {
  if (!Array.isArray(value)) {
    return []
  }

  return value.map((entry) => mapProductRecord(toRecord(entry))).filter((entry) => entry !== null)
}

function mapProductRecord(value: Record<string, unknown>): ProductRecord | null {
  const id = readString(value.id)
  const name = readString(value.name)
  if (!id || !name) {
    return null
  }

  return {
    id,
    name,
    description: readString(value.description) ?? '',
    price: readNumber(value.price) ?? 0,
    stock: readNumber(value.stock) ?? 0,
    metadata: toRecord(value.metadata),
  }
}

function clampLimit(value: number | undefined): number {
  if (!Number.isInteger(value) || !value) {
    return 5
  }

  return Math.max(1, Math.min(20, value))
}

function toRecord(value: unknown): Record<string, unknown> {
  return value && typeof value === 'object' ? (value as Record<string, unknown>) : {}
}

function readString(value: unknown): string | null {
  return typeof value === 'string' && value.trim().length > 0 ? value.trim() : null
}

function readNumber(value: unknown): number | null {
  const parsed = Number(value)
  return Number.isFinite(parsed) ? parsed : null
}
