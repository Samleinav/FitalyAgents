import { readFile, writeFile } from 'node:fs/promises'
import type { StoreConfig } from '../../../store-runtime/src/config/schema.js'
import { StoreConfigSchema } from '../../../store-runtime/src/config/schema.js'
import { loadStoreConfig } from '../../../store-runtime/src/config/load-store-config.js'
import {
  createRetailAdapterCatalog,
  type RetailAdapterCatalog,
} from '../../../store-runtime/src/retail/adapters/catalog.js'
import { assertSupportedRetailConnectorDrivers } from '../../../store-runtime/src/retail/connector-support.js'
import { closeDb, getDb } from '../../../store-runtime/src/storage/db.js'
import {
  ApprovalRepository,
  CustomerRepository,
  DraftRepository,
  EmployeeRepository,
  OrderRepository,
  SessionRepository,
  WebhookRepository,
} from '../../../store-runtime/src/storage/repositories/index.js'
import type { DeployCenterConfig, DeployScreenConfig } from '../config/schema.js'
import { resolveServiceStatuses, type DeployServiceStatus } from './service-state.js'
import { getConnectorPresets, type ConnectorPresetDefinition } from './connector-presets.js'
import { patchEnvEntries, readEnvEntries, type DeployEnvEntry } from './env-file.js'

export interface DeployCenterDashboardState {
  project: {
    name: string
    store_config_path: string
    compose_file_path: string
    working_directory: string
    env_file_path: string
    profiles: string[]
  }
  services: DeployServiceStatus[]
  screens: DeployScreenConfig[]
  store: StoreConfig['store']
  retail: StoreConfig['retail']
  connectors: Pick<
    StoreConfig['connectors'],
    'products' | 'inventory' | 'customers' | 'orders' | 'payments'
  >
  connector_presets: ConnectorPresetDefinition[]
  env_summary: {
    total: number
    configured: number
    source: 'file' | 'example'
  }
}

export interface StoreProjectApi {
  getDashboardState(): Promise<DeployCenterDashboardState>
  readStoreConfigRaw(): Promise<unknown>
  readEnvState(): Promise<{
    path: string
    source: 'file' | 'example'
    entries: DeployEnvEntry[]
  }>
  patchEnv(values: Record<string, string>): Promise<{
    path: string
    source: 'file' | 'example'
    entries: DeployEnvEntry[]
  }>
  patchStoreConfig(patch: Record<string, unknown>): Promise<StoreConfig>
  testProductsConnector(query: string): Promise<{
    health: unknown
    results: unknown
  }>
  testCustomersConnector(
    action: 'lookup' | 'register',
    input: Record<string, unknown>,
  ): Promise<{
    health: unknown
    results: unknown
  }>
  testOrdersConnector(
    action: 'create' | 'update' | 'confirm',
    input: Record<string, unknown>,
  ): Promise<{
    health: unknown
    results: unknown
  }>
  testPaymentsConnector(input: Record<string, unknown>): Promise<{
    health: unknown
    results: unknown
  }>
}

interface StoreProjectRepositories {
  customers: CustomerRepository
  employees: EmployeeRepository
  drafts: DraftRepository
  orders: OrderRepository
  approvals: ApprovalRepository
  sessions: SessionRepository
  webhooks: WebhookRepository
}

export class StoreProjectService implements StoreProjectApi {
  constructor(private readonly config: DeployCenterConfig) {}

  async getDashboardState(): Promise<DeployCenterDashboardState> {
    const storeConfig = await loadStoreConfig(this.config.project.store_config_path)
    const services = await resolveServiceStatuses(this.config.services)
    const envState = await this.readEnvState()

    return {
      project: {
        name: this.config.project.name,
        store_config_path: this.config.project.store_config_path,
        compose_file_path: this.config.project.compose_file_path,
        working_directory: this.config.project.working_directory,
        env_file_path: this.config.project.env_file_path,
        profiles: this.config.project.profiles,
      },
      services,
      screens: this.config.screens,
      store: storeConfig.store,
      retail: storeConfig.retail,
      connectors: {
        products: storeConfig.connectors.products,
        inventory: storeConfig.connectors.inventory,
        customers: storeConfig.connectors.customers,
        orders: storeConfig.connectors.orders,
        payments: storeConfig.connectors.payments,
      },
      connector_presets: getConnectorPresets(),
      env_summary: {
        total: envState.entries.length,
        configured: envState.entries.filter((entry) => entry.value.trim().length > 0).length,
        source: envState.source,
      },
    }
  }

  async readStoreConfigRaw(): Promise<unknown> {
    const raw = await readFile(this.config.project.store_config_path, 'utf8')
    return JSON.parse(raw)
  }

  readEnvState(): Promise<{
    path: string
    source: 'file' | 'example'
    entries: DeployEnvEntry[]
  }> {
    return readEnvEntries({
      envFilePath: this.config.project.env_file_path,
      envExamplePath: this.config.project.env_example_path,
    })
  }

  patchEnv(values: Record<string, string>): Promise<{
    path: string
    source: 'file' | 'example'
    entries: DeployEnvEntry[]
  }> {
    return patchEnvEntries({
      envFilePath: this.config.project.env_file_path,
      envExamplePath: this.config.project.env_example_path,
      values,
    })
  }

  async patchStoreConfig(patch: Record<string, unknown>): Promise<StoreConfig> {
    const raw = await this.readStoreConfigRaw()
    const merged = stripNulls(deepMerge(raw, patch))
    const parsed = StoreConfigSchema.parse(merged)
    assertSupportedRetailConnectorDrivers(parsed.connectors)

    await writeFile(this.config.project.store_config_path, JSON.stringify(parsed, null, 2), 'utf8')

    return loadStoreConfig(this.config.project.store_config_path)
  }

  async testProductsConnector(query: string): Promise<{
    health: unknown
    results: unknown
  }> {
    return this.withConnectorPreview('products', async ({ adapters, storeConfig }) => {
      const health = await adapters.products.health()
      const results = await adapters.products.execute(
        'search',
        {
          query,
          limit: 5,
        },
        {
          session_id: 'deploy-center-preview-products',
          store_id: storeConfig.store.store_id,
        },
      )

      return {
        health,
        results,
      }
    })
  }

  async testCustomersConnector(
    action: 'lookup' | 'register',
    input: Record<string, unknown>,
  ): Promise<{
    health: unknown
    results: unknown
  }> {
    return this.withConnectorPreview('customers', async ({ adapters, storeConfig }) => {
      const health = await adapters.customers.health()
      const results = await adapters.customers.execute(action, input, {
        session_id: `deploy-center-preview-customers-${action}`,
        store_id: storeConfig.store.store_id,
      })

      return {
        health,
        results,
      }
    })
  }

  async testOrdersConnector(
    action: 'create' | 'update' | 'confirm',
    input: Record<string, unknown>,
  ): Promise<{
    health: unknown
    results: unknown
  }> {
    return this.withConnectorPreview('orders', async ({ adapters, storeConfig }) => {
      const health = await adapters.orders.health()
      const results = await adapters.orders.execute(
        action,
        input as Parameters<RetailAdapterCatalog['orders']['execute']>[1],
        {
          session_id: `deploy-center-preview-orders-${action}`,
          store_id: storeConfig.store.store_id,
        },
      )

      return {
        health,
        results,
      }
    })
  }

  async testPaymentsConnector(input: Record<string, unknown>): Promise<{
    health: unknown
    results: unknown
  }> {
    return this.withConnectorPreview(
      'payments',
      async ({ adapters, repositories, storeConfig }) => {
        const health = await adapters.payments.health()
        const paymentInput = ensurePaymentPreviewOrder(
          repositories.orders,
          input,
          storeConfig.policies.allowed_payment_methods,
        )
        const results = await adapters.payments.execute('create_intent', paymentInput, {
          session_id: 'deploy-center-preview-payments-create-intent',
          store_id: storeConfig.store.store_id,
        })

        return {
          health,
          results,
        }
      },
    )
  }

  private async withConnectorPreview<T>(
    kind: 'products' | 'customers' | 'orders' | 'payments',
    run: (context: {
      adapters: RetailAdapterCatalog
      repositories: StoreProjectRepositories
      storeConfig: StoreConfig
    }) => Promise<T>,
  ): Promise<T> {
    const loadedConfig = await loadStoreConfig(this.config.project.store_config_path)
    const storeConfig = isolateConnectorPreviewConnectors(loadedConfig, kind)
    const db = getDb(storeConfig.storage.sqlite_path)
    const repositories = createRepositories(db)

    const adapters = createRetailAdapterCatalog({
      db,
      repositories,
      config: storeConfig,
    })

    try {
      return await run({
        adapters,
        repositories,
        storeConfig,
      })
    } finally {
      await Promise.allSettled([
        Promise.resolve(adapters.products.dispose?.()),
        Promise.resolve(adapters.inventory.dispose?.()),
        Promise.resolve(adapters.customers.dispose?.()),
        Promise.resolve(adapters.orders.dispose?.()),
        Promise.resolve(adapters.payments.dispose?.()),
        Promise.resolve(adapters.devices.receiptPrinter.dispose?.()),
      ])
      closeDb(storeConfig.storage.sqlite_path)
    }
  }
}

function deepMerge(base: unknown, patch: unknown): unknown {
  if (!isPlainObject(base) || !isPlainObject(patch)) {
    return patch
  }

  const next: Record<string, unknown> = { ...base }
  for (const [key, value] of Object.entries(patch)) {
    if (isPlainObject(value) && isPlainObject(next[key])) {
      next[key] = deepMerge(next[key], value)
      continue
    }

    next[key] = value
  }

  return next
}

function isPlainObject(value: unknown): value is Record<string, unknown> {
  return value != null && typeof value === 'object' && !Array.isArray(value)
}

function stripNulls(value: unknown): unknown {
  if (Array.isArray(value)) {
    return value.map(stripNulls)
  }

  if (!isPlainObject(value)) {
    return value
  }

  return Object.fromEntries(
    Object.entries(value)
      .filter(([, entry]) => entry !== null)
      .map(([key, entry]) => [key, stripNulls(entry)]),
  )
}

function createRepositories(db: ReturnType<typeof getDb>): StoreProjectRepositories {
  return {
    customers: new CustomerRepository(db),
    employees: new EmployeeRepository(db),
    drafts: new DraftRepository(db),
    orders: new OrderRepository(db),
    approvals: new ApprovalRepository(db),
    sessions: new SessionRepository(db),
    webhooks: new WebhookRepository(db),
  }
}

function isolateConnectorPreviewConnectors(
  config: StoreConfig,
  activeKind: 'products' | 'customers' | 'orders' | 'payments',
): StoreConfig {
  return {
    ...config,
    connectors: {
      ...config.connectors,
      products:
        activeKind === 'products'
          ? config.connectors.products
          : toMockConnector(config.connectors.products),
      inventory: toMockConnector(config.connectors.inventory),
      customers: {
        ...(activeKind === 'customers'
          ? config.connectors.customers
          : toMockConnector(config.connectors.customers)),
      },
      orders: {
        ...(activeKind === 'orders'
          ? config.connectors.orders
          : toMockConnector(config.connectors.orders)),
      },
      payments:
        activeKind === 'payments'
          ? config.connectors.payments
          : toMockConnector(config.connectors.payments),
      receipts: toMockConnector(config.connectors.receipts),
    },
  }
}

function ensurePaymentPreviewOrder(
  orderRepository: OrderRepository,
  input: Record<string, unknown>,
  allowedMethods: string[],
): Parameters<RetailAdapterCatalog['payments']['execute']>[1] {
  const requestedOrderId = readNonEmptyString(input.order_id)
  const existingOrder = requestedOrderId ? orderRepository.findById(requestedOrderId) : null
  const existingTotal = readOrderTotal(existingOrder?.result)
  const requestedAmount = readNumber(input.amount)
  const previewTotal =
    requestedAmount && requestedAmount > 0 ? requestedAmount : (existingTotal ?? 129.99)
  const orderId = existingOrder?.id ?? requestedOrderId ?? `ord_preview_${Date.now()}`
  const paymentMethod = readNonEmptyString(input.payment_method) ?? allowedMethods[0] ?? 'card'

  if (!existingOrder) {
    const now = Date.now()
    orderRepository.insert({
      id: orderId,
      session_id: 'deploy-center-preview-payments',
      draft_id: null,
      tool_id: 'order_confirm',
      params: {
        source: 'deploy-center-preview',
        payment_method: paymentMethod,
      },
      result: {
        order_id: orderId,
        total: previewTotal,
        order_state: 'confirmed',
        payment_status: 'awaiting_payment',
        items: [],
        text: 'Orden preview creada automáticamente para probar payments.',
      },
      status: 'completed',
      created_at: now,
      updated_at: now,
    })
  }

  return {
    order_id: orderId,
    amount: requestedAmount ?? undefined,
    payment_method: paymentMethod,
  }
}

function toMockConnector<T extends StoreConfig['connectors'][keyof StoreConfig['connectors']]>(
  connector: T,
): T {
  return {
    ...connector,
    driver: 'mock',
  } as T
}

function readNonEmptyString(value: unknown): string | undefined {
  if (typeof value !== 'string') {
    return undefined
  }

  const trimmed = value.trim()
  return trimmed.length > 0 ? trimmed : undefined
}

function readNumber(value: unknown): number | undefined {
  const numeric =
    typeof value === 'number' ? value : typeof value === 'string' ? Number(value) : NaN
  return Number.isFinite(numeric) ? numeric : undefined
}

function readOrderTotal(value: unknown): number | undefined {
  if (!isPlainObject(value)) {
    return undefined
  }

  return readNumber(value.total)
}
