import type { RetailAdapterCatalogDeps } from '../catalog.js'
import type {
  AdapterHealth,
  OrderAdapter,
  OrderConfirmResult,
  OrderCreateInput,
  OrderCreateResult,
  OrderLineResult,
  OrderUpdateInput,
  OrderUpdateResult,
  RetailAdapterErrorShape,
} from '../catalog.js'
import { RetailAdapterError } from '../catalog.js'

interface OrderRestOptions {
  healthUrl?: string
  createUrl?: string
  updateUrl?: string
  confirmUrl?: string
  createMethod: 'POST' | 'PUT'
  updateMethod: 'POST' | 'PUT' | 'PATCH'
  confirmMethod: 'POST' | 'PUT' | 'PATCH'
}

export function createRestOrderAdapter(deps: RetailAdapterCatalogDeps): OrderAdapter {
  const connector = deps.config.connectors.orders
  const options = readRestOptions(connector.options)

  return {
    driver: 'rest',
    capabilities() {
      return ['create', 'update', 'confirm']
    },
    async health(): Promise<AdapterHealth> {
      const healthUrl = resolveUrl(connector.url, options.healthUrl) ?? connector.url
      const response = await requestJson({
        url: healthUrl,
        headers: connector.headers,
        timeoutMs: connector.health_timeout_ms,
        method: 'GET',
      })

      return {
        ok: true,
        driver: 'rest',
        details: {
          connector: 'orders',
          status: response.status,
          url: healthUrl,
        },
      }
    },
    async execute(action, input, context) {
      switch (action) {
        case 'create': {
          const createInput = input as OrderCreateInput
          const response = await requestJson({
            url: resolveUrl(connector.url, options.createUrl),
            headers: connector.headers,
            timeoutMs: connector.health_timeout_ms,
            method: options.createMethod,
            body: {
              ...createInput,
              context,
            },
          })

          return normalizeCreateResponse(response.payload, createInput.items)
        }
        case 'update': {
          const updateInput = input as OrderUpdateInput
          const response = await requestJson({
            url: resolveOrderUrl(connector.url, options.updateUrl, updateInput.order_id, []),
            headers: connector.headers,
            timeoutMs: connector.health_timeout_ms,
            method: options.updateMethod,
            body: {
              ...updateInput,
              context,
            },
          })

          return normalizeUpdateResponse(
            response.payload,
            updateInput.items ?? updateInput.add_items ?? [],
            updateInput.order_id,
          )
        }
        case 'confirm': {
          const confirmInput = input as { order_id: string }
          const response = await requestJson({
            url: resolveOrderUrl(connector.url, options.confirmUrl, confirmInput.order_id, [
              'confirm',
            ]),
            headers: connector.headers,
            timeoutMs: connector.health_timeout_ms,
            method: options.confirmMethod,
            body: {
              ...confirmInput,
              context,
            },
          })

          return normalizeConfirmResponse(response.payload, confirmInput.order_id)
        }
      }
    },
  }
}

function readRestOptions(options: Record<string, unknown>): OrderRestOptions {
  return {
    healthUrl: readOptionalString(options.health_url),
    createUrl: readOptionalString(options.create_url),
    updateUrl: readOptionalString(options.update_url),
    confirmUrl: readOptionalString(options.confirm_url),
    createMethod: readMethod(options.create_method, ['POST', 'PUT'], 'POST'),
    updateMethod: readMethod(options.update_method, ['POST', 'PUT', 'PATCH'], 'PATCH'),
    confirmMethod: readMethod(options.confirm_method, ['POST', 'PUT', 'PATCH'], 'POST'),
  }
}

function normalizeCreateResponse(
  payload: unknown,
  fallbackItems: OrderCreateInput['items'],
): OrderCreateResult {
  const normalized = normalizeOrderPayload(payload, fallbackItems, 'open')
  return {
    order_id: normalized.orderId,
    total: normalized.total,
    item_count: normalized.itemCount,
    order_state: normalized.orderState === 'confirmed' ? 'open' : normalized.orderState,
    items: normalized.items,
    text:
      normalized.text ??
      `La orden ${normalized.orderId} quedó preparada por ${formatCurrency(normalized.total)}.`,
  }
}

function normalizeUpdateResponse(
  payload: unknown,
  fallbackItems: Array<{
    product_id: string
    quantity: number
    price: number
  }>,
  fallbackOrderId: string,
): OrderUpdateResult {
  const normalized = normalizeOrderPayload(payload, fallbackItems, 'open', fallbackOrderId)
  return {
    order_id: normalized.orderId,
    total: normalized.total,
    item_count: normalized.itemCount,
    order_state: normalized.orderState,
    items: normalized.items,
    text:
      normalized.text ??
      `Actualicé la orden ${normalized.orderId}. Nuevo total: ${formatCurrency(normalized.total)}.`,
  }
}

function normalizeConfirmResponse(payload: unknown, fallbackOrderId: string): OrderConfirmResult {
  const normalized = normalizeOrderPayload(payload, [], 'confirmed', fallbackOrderId)
  return {
    order_id: normalized.orderId,
    total: normalized.total,
    order_state: 'confirmed',
    payment_status: normalized.paymentStatus ?? 'awaiting_payment',
    items: normalized.items,
    text: normalized.text ?? `La orden ${normalized.orderId} quedó confirmada y lista para pago.`,
  }
}

function normalizeOrderPayload(
  payload: unknown,
  fallbackItems: Array<{
    product_id: string
    quantity: number
    price: number
  }>,
  fallbackState: 'open' | 'confirmed',
  fallbackOrderId?: string,
): {
  orderId: string
  total: number
  itemCount: number
  orderState: 'open' | 'confirmed'
  paymentStatus?: 'awaiting_payment'
  items: OrderLineResult[]
  text?: string
} {
  const record = toRecord(payload)
  const order = toRecord(record.order)
  const orderId =
    readOptionalString(record.order_id) ??
    readOptionalString(record.id) ??
    readOptionalString(order.order_id) ??
    readOptionalString(order.id) ??
    fallbackOrderId

  if (!orderId) {
    throw new RetailAdapterError({
      code: 'invalid_rest_response',
      message: 'REST order response must include order_id or id',
      retryable: false,
    })
  }

  const items = readOrderLines(record.items ?? record.lines ?? order.items, fallbackItems)
  const total = readNumber(record.total) ?? readNumber(order.total) ?? sumLineTotals(items)
  const itemCount = readNumber(record.item_count) ?? readNumber(order.item_count) ?? items.length
  const orderState = readOrderState(record.order_state ?? order.order_state, fallbackState)
  const paymentStatus =
    readPaymentStatus(record.payment_status ?? order.payment_status) ??
    (orderState === 'confirmed' ? 'awaiting_payment' : undefined)

  return {
    orderId,
    total,
    itemCount,
    orderState,
    paymentStatus,
    items,
    text: readOptionalString(record.text) ?? readOptionalString(order.text),
  }
}

function readOrderLines(
  value: unknown,
  fallbackItems: Array<{
    product_id: string
    quantity: number
    price: number
  }>,
): OrderLineResult[] {
  if (!Array.isArray(value) || value.length === 0) {
    return fallbackItems.map((item) => ({
      product_id: item.product_id,
      name: item.product_id,
      quantity: item.quantity,
      price: item.price,
      line_total: item.quantity * item.price,
    }))
  }

  return value
    .map((entry) => {
      const record = toRecord(entry)
      const productId = readOptionalString(record.product_id)
      if (!productId) {
        return null
      }

      const quantity = readNumber(record.quantity) ?? 0
      const price = readNumber(record.price) ?? 0
      return {
        product_id: productId,
        name: readOptionalString(record.name) ?? productId,
        quantity,
        price,
        line_total: readNumber(record.line_total) ?? quantity * price,
      }
    })
    .filter((entry) => entry !== null)
}

async function requestJson(args: {
  url: string | undefined
  headers: Record<string, string>
  timeoutMs: number
  method: 'GET' | 'POST' | 'PUT' | 'PATCH'
  body?: unknown
}): Promise<{
  status: number
  payload: unknown
}> {
  if (!args.url) {
    throw new RetailAdapterError({
      code: 'missing_rest_url',
      message: 'REST connector requires a url',
      retryable: false,
    })
  }

  const controller = new AbortController()
  const timeout = setTimeout(() => controller.abort(), args.timeoutMs)

  try {
    const response = await fetch(args.url, {
      method: args.method,
      headers: {
        accept: 'application/json',
        ...(args.body === undefined ? {} : { 'content-type': 'application/json' }),
        ...args.headers,
      },
      body: args.body === undefined ? undefined : JSON.stringify(args.body),
      signal: controller.signal,
    })

    if (!response.ok) {
      throw new RetailAdapterError({
        code: 'rest_connector_http_error',
        message: `REST connector returned HTTP ${response.status}`,
        retryable: response.status >= 500,
        details: {
          status: response.status,
          url: args.url,
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
        url: args.url,
      },
    }
    throw new RetailAdapterError(shape, { cause: error })
  } finally {
    clearTimeout(timeout)
  }
}

function resolveOrderUrl(
  baseUrl: string | undefined,
  override: string | undefined,
  orderId: string,
  suffix: string[],
): string | undefined {
  const resolved = resolveUrl(baseUrl, override)
  if (!resolved) {
    return undefined
  }

  if (resolved.includes('{order_id}')) {
    return resolved.replaceAll('{order_id}', encodeURIComponent(orderId))
  }

  if (override) {
    return resolved
  }

  return appendPath(resolved, orderId, ...suffix)
}

function resolveUrl(baseUrl: string | undefined, override: string | undefined): string | undefined {
  if (!override) {
    return baseUrl
  }

  if (/^https?:\/\//.test(override)) {
    return override
  }

  if (!baseUrl) {
    return override
  }

  return appendPath(baseUrl, override)
}

function appendPath(baseUrl: string, ...parts: string[]): string {
  const normalizedBase = baseUrl.replace(/\/+$/, '')
  const normalizedParts = parts.map((part) => part.replace(/^\/+|\/+$/g, '')).filter(Boolean)
  return [normalizedBase, ...normalizedParts].join('/')
}

function sumLineTotals(items: OrderLineResult[]): number {
  return items.reduce((sum, item) => sum + item.line_total, 0)
}

function formatCurrency(amount: number): string {
  return new Intl.NumberFormat('es', {
    style: 'currency',
    currency: 'USD',
  }).format(amount)
}

function readMethod<const T extends readonly string[]>(
  value: unknown,
  allowed: T,
  fallback: T[number],
): T[number] {
  if (typeof value !== 'string') {
    return fallback
  }

  const normalized = value.trim().toUpperCase()
  return allowed.includes(normalized) ? (normalized as T[number]) : fallback
}

function readOptionalString(value: unknown): string | undefined {
  return typeof value === 'string' && value.trim().length > 0 ? value.trim() : undefined
}

function readNumber(value: unknown): number | undefined {
  const parsed = Number(value)
  return Number.isFinite(parsed) ? parsed : undefined
}

function readOrderState(value: unknown, fallback: 'open' | 'confirmed'): 'open' | 'confirmed' {
  return value === 'confirmed' ? 'confirmed' : fallback
}

function readPaymentStatus(value: unknown): 'awaiting_payment' | undefined {
  return value === 'awaiting_payment' ? 'awaiting_payment' : undefined
}

function toRecord(value: unknown): Record<string, unknown> {
  return value && typeof value === 'object' ? (value as Record<string, unknown>) : {}
}
