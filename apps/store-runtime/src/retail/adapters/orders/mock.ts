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

interface OrderLine {
  product_id: string
  quantity: number
  price: number
}

export function createMockOrderAdapter(deps: RetailAdapterCatalogDeps): OrderAdapter {
  return {
    driver: 'mock',
    capabilities() {
      return ['create', 'update', 'confirm']
    },
    async health(): Promise<AdapterHealth> {
      return {
        ok: true,
        driver: 'mock',
        details: {
          connector: 'orders',
          mode: 'sqlite-repository',
        },
      }
    },
    async execute(action, input, context) {
      switch (action) {
        case 'create':
          return createOrder(deps, input as OrderCreateInput, context)
        case 'update':
          return updateOrder(deps, input as OrderUpdateInput)
        case 'confirm':
          return confirmOrder(deps, (input as { order_id: string }).order_id)
      }
    },
  }
}

function createOrder(
  deps: RetailAdapterCatalogDeps,
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

  deps.repositories.orders.insert({
    id: orderId,
    session_id: context.session_id,
    draft_id: null,
    tool_id: 'order_create',
    params: {
      customer_id: input.customer_id ?? null,
      items,
    },
    result: {
      order_id: orderId,
      total,
      item_count: items.length,
      order_state: 'open',
    },
    status: 'completed',
    created_at: now,
    updated_at: now,
  })

  return {
    order_id: orderId,
    total,
    item_count: items.length,
    order_state: 'open',
    items: expandOrderLines(deps, items),
    text: `La orden ${orderId} quedó preparada por ${formatCurrency(total)}.`,
  }
}

function updateOrder(deps: RetailAdapterCatalogDeps, input: OrderUpdateInput): OrderUpdateResult {
  const existing = deps.repositories.orders.findById(input.order_id)
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

  deps.repositories.orders.update(existing.id, {
    params: {
      ...existing.params,
      items,
    },
    result: {
      ...previousResult,
      order_id: existing.id,
      total,
      item_count: items.length,
      order_state: orderState,
    },
  })

  return {
    order_id: existing.id,
    total,
    item_count: items.length,
    order_state: orderState,
    items: expandOrderLines(deps, items),
    text: `Actualicé la orden ${existing.id}. Nuevo total: ${formatCurrency(total)}.`,
  }
}

function confirmOrder(deps: RetailAdapterCatalogDeps, orderId: string): OrderConfirmResult {
  const existing = deps.repositories.orders.findById(orderId)
  if (!existing) {
    throw new Error(`Order ${orderId} was not found`)
  }

  const previousResult = existing.result ?? {}
  const total =
    typeof previousResult.total === 'number'
      ? previousResult.total
      : sumTotal(
          Array.isArray(existing.params.items)
            ? (existing.params.items as unknown[])
                .map(normalizeLine)
                .filter((line) => line.product_id && line.quantity > 0)
            : [],
        )

  deps.repositories.orders.update(existing.id, {
    result: {
      ...previousResult,
      order_id: existing.id,
      total,
      item_count:
        typeof previousResult.item_count === 'number'
          ? previousResult.item_count
          : Array.isArray(existing.params.items)
            ? existing.params.items.length
            : 0,
      order_state: 'confirmed',
      payment_status: 'awaiting_payment',
      confirmed_at: Date.now(),
    },
  })

  return {
    order_id: existing.id,
    total,
    order_state: 'confirmed',
    payment_status: 'awaiting_payment',
    items: expandOrderLines(
      deps,
      Array.isArray(existing.params.items)
        ? (existing.params.items as unknown[])
            .map(normalizeLine)
            .filter((line) => line.product_id && line.quantity > 0)
        : [],
    ),
    text: `La orden ${existing.id} quedó confirmada y lista para pago.`,
  }
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

function expandOrderLines(deps: RetailAdapterCatalogDeps, items: OrderLine[]): OrderLineResult[] {
  return items.map((item) => {
    const row = deps.db.prepare('SELECT name FROM products WHERE id = ?').get(item.product_id) as
      | Record<string, unknown>
      | undefined

    return {
      product_id: item.product_id,
      name: typeof row?.name === 'string' ? row.name : item.product_id,
      quantity: item.quantity,
      price: item.price,
      line_total: item.quantity * item.price,
    }
  })
}

function formatCurrency(amount: number): string {
  return new Intl.NumberFormat('es', {
    style: 'currency',
    currency: 'USD',
  }).format(amount)
}
