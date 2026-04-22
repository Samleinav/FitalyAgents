import type Database from 'better-sqlite3'
import type { HumanRole } from 'fitalyagents'
import type { StoreConfig } from '../../config/schema.js'
import type { StoreRepositories } from '../../tools/registry.js'
import { createMockCustomerAdapter } from './customers/mock.js'
import { createRestCustomerAdapter } from './customers/rest.js'
import { createSqliteCustomerAdapter } from './customers/sqlite.js'
import { createMockDeviceAdapterCatalog } from './devices/mock.js'
import { createMockOrderAdapter } from './orders/mock.js'
import { createRestOrderAdapter } from './orders/rest.js'
import { createSqliteOrderAdapter } from './orders/sqlite.js'
import { createMockPaymentAdapter } from './payments/mock.js'
import { createMockInventoryAdapter, createMockProductAdapter } from './products/mock.js'
import { createRestInventoryAdapter, createRestProductAdapter } from './products/rest.js'
import { createSqliteInventoryAdapter, createSqliteProductAdapter } from './products/sqlite.js'

export interface AdapterExecutionContext {
  session_id: string
  store_id: string
  speaker_id?: string
  role?: HumanRole | null
}

export interface AdapterHealth {
  ok: boolean
  driver: string
  details?: Record<string, unknown>
}

export interface RetailAdapterErrorShape {
  code: string
  message: string
  retryable: boolean
  details?: Record<string, unknown>
}

export class RetailAdapterError extends Error {
  constructor(
    public readonly shape: RetailAdapterErrorShape,
    options?: {
      cause?: unknown
    },
  ) {
    super(shape.message, options)
    this.name = 'RetailAdapterError'
  }
}

export interface RetailAdapter {
  readonly driver: string
  capabilities(): string[]
  health(): Promise<AdapterHealth>
  dispose?(): Promise<void> | void
}

export interface ProductRecord {
  id: string
  name: string
  description: string
  price: number
  stock: number
  metadata: Record<string, unknown>
}

export interface ProductSearchResult {
  products: ProductRecord[]
  text: string
}

export interface InventoryCheckResult {
  products: ProductRecord[]
  in_stock: boolean
  text: string
}

export interface CustomerLookupResult {
  customers: Array<{
    id: string
    name: string
    locale: string
    metadata: Record<string, unknown>
  }>
  text: string
}

export interface CustomerRegisterResult {
  customer_id: string
  text: string
}

export interface OrderCreateInput {
  customer_id?: string | null
  items: Array<{
    product_id: string
    quantity: number
    price: number
  }>
}

export interface OrderLineResult {
  product_id: string
  name: string
  quantity: number
  price: number
  line_total: number
}

export interface OrderCreateResult {
  order_id: string
  total: number
  item_count: number
  order_state: 'open'
  items: OrderLineResult[]
  text: string
}

export interface OrderUpdateInput {
  order_id: string
  items?: Array<{
    product_id: string
    quantity: number
    price: number
  }>
  add_items?: Array<{
    product_id: string
    quantity: number
    price: number
  }>
  remove_product_ids?: string[]
}

export interface OrderUpdateResult {
  order_id: string
  total: number
  item_count: number
  order_state: 'open' | 'confirmed'
  items: OrderLineResult[]
  text: string
}

export interface OrderConfirmResult {
  order_id: string
  total: number
  order_state: 'confirmed'
  payment_status: 'awaiting_payment'
  items: OrderLineResult[]
  text: string
}

export interface PaymentIntentResult {
  payment_intent_id: string
  order_id: string
  amount: number
  payment_method: string
  status: 'ready'
  text: string
}

export interface ReceiptPrintResult {
  receipt_id: string
  print_job_id: string
  order_id: string
  status: 'printed'
  text: string
}

export interface ProductAdapter extends RetailAdapter {
  execute(
    action: 'search',
    input: {
      query: string
      limit?: number
    },
    context: AdapterExecutionContext,
  ): Promise<ProductSearchResult>
}

export interface InventoryAdapter extends RetailAdapter {
  execute(
    action: 'inventory_check',
    input: {
      product_id?: string
      query?: string
      limit?: number
    },
    context: AdapterExecutionContext,
  ): Promise<InventoryCheckResult>
}

export interface CustomerAdapter extends RetailAdapter {
  execute(
    action: 'lookup' | 'register',
    input:
      | {
          customer_id?: string
          query?: string
          limit?: number
        }
      | {
          name: string
          locale?: string
          metadata?: Record<string, unknown>
        },
    context: AdapterExecutionContext,
  ): Promise<CustomerLookupResult | CustomerRegisterResult>
}

export interface OrderAdapter extends RetailAdapter {
  execute(
    action: 'create' | 'update' | 'confirm',
    input: OrderCreateInput | OrderUpdateInput | { order_id: string },
    context: AdapterExecutionContext,
  ): Promise<OrderCreateResult | OrderUpdateResult | OrderConfirmResult>
}

export interface PaymentAdapter extends RetailAdapter {
  execute(
    action: 'create_intent',
    input: {
      order_id: string
      amount?: number
      payment_method?: string
    },
    context: AdapterExecutionContext,
  ): Promise<PaymentIntentResult>
}

export interface ReceiptPrinterAdapter extends RetailAdapter {
  execute(
    action: 'receipt_print',
    input: {
      order_id: string
      reprint?: boolean
    },
    context: AdapterExecutionContext,
  ): Promise<ReceiptPrintResult>
}

export interface RetailAdapterCatalog {
  products: ProductAdapter
  inventory: InventoryAdapter
  customers: CustomerAdapter
  orders: OrderAdapter
  payments: PaymentAdapter
  devices: {
    receiptPrinter: ReceiptPrinterAdapter
  }
}

export interface RetailAdapterCatalogDeps {
  db: Database.Database
  repositories: StoreRepositories
  config: StoreConfig
}

export function createRetailAdapterCatalog(deps: RetailAdapterCatalogDeps): RetailAdapterCatalog {
  return {
    products: createProductAdapter(deps),
    inventory: createInventoryAdapter(deps),
    customers: createCustomerAdapter(deps),
    orders: createOrderAdapter(deps),
    payments: createPaymentAdapter(deps),
    devices: createDeviceAdapterCatalog(deps),
  }
}

function createProductAdapter(deps: RetailAdapterCatalogDeps): ProductAdapter {
  switch (deps.config.connectors.products.driver) {
    case 'mock':
      return createMockProductAdapter(deps)
    case 'rest':
      return createRestProductAdapter(deps)
    case 'sqlite':
      return createSqliteProductAdapter(deps)
    default:
      throw unsupportedConnector('products', deps.config.connectors.products.driver)
  }
}

function createInventoryAdapter(deps: RetailAdapterCatalogDeps): InventoryAdapter {
  switch (deps.config.connectors.inventory.driver) {
    case 'mock':
      return createMockInventoryAdapter(deps)
    case 'rest':
      return createRestInventoryAdapter(deps)
    case 'sqlite':
      return createSqliteInventoryAdapter(deps)
    default:
      throw unsupportedConnector('inventory', deps.config.connectors.inventory.driver)
  }
}

function createCustomerAdapter(deps: RetailAdapterCatalogDeps): CustomerAdapter {
  switch (deps.config.connectors.customers.driver) {
    case 'mock':
      return createMockCustomerAdapter(deps)
    case 'rest':
      return createRestCustomerAdapter(deps)
    case 'sqlite':
      return createSqliteCustomerAdapter(deps)
    default:
      throw unsupportedConnector('customers', deps.config.connectors.customers.driver)
  }
}

function createOrderAdapter(deps: RetailAdapterCatalogDeps): OrderAdapter {
  switch (deps.config.connectors.orders.driver) {
    case 'mock':
      return createMockOrderAdapter(deps)
    case 'rest':
      return createRestOrderAdapter(deps)
    case 'sqlite':
      return createSqliteOrderAdapter(deps)
    default:
      throw unsupportedConnector('orders', deps.config.connectors.orders.driver)
  }
}

function createPaymentAdapter(deps: RetailAdapterCatalogDeps): PaymentAdapter {
  switch (deps.config.connectors.payments.driver) {
    case 'mock':
      return createMockPaymentAdapter(deps)
    default:
      throw unsupportedConnector('payments', deps.config.connectors.payments.driver)
  }
}

function createDeviceAdapterCatalog(deps: RetailAdapterCatalogDeps): {
  receiptPrinter: ReceiptPrinterAdapter
} {
  return createMockDeviceAdapterCatalog(deps)
}

function unsupportedConnector(kind: string, driver: string): RetailAdapterError {
  return new RetailAdapterError({
    code: 'driver_not_implemented',
    message: `Connector "${kind}" with driver "${driver}" is not implemented in store-runtime yet`,
    retryable: false,
    details: {
      kind,
      driver,
    },
  })
}
