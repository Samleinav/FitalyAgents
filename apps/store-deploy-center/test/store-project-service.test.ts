import { readFile, writeFile } from 'node:fs/promises'
import path from 'node:path'
import { describe, expect, it } from 'vitest'
import {
  CustomerRepository,
  OrderRepository,
} from '../../store-runtime/src/storage/repositories/index.js'
import type { DeployCenterConfig } from '../src/config/schema.js'
import { StoreProjectService } from '../src/services/store-project-service.js'
import {
  cleanupTempDir,
  closeTestDb,
  createBaseConfig,
  createTempDbPath,
  createTempDir,
  ensureDb,
  writeJsonFile,
} from '../../store-runtime/test/helpers.js'

describe('StoreProjectService', () => {
  it('patches store config and tests a sqlite product connector', async () => {
    const dir = await createTempDir('deploy-center-store-project-')
    const storeConfigPath = path.join(dir, 'store.config.json')
    const runtimeDbPath = createTempDbPath(dir, 'runtime.db')
    const catalogDbPath = createTempDbPath(dir, 'catalog.db')
    ensureDb(runtimeDbPath)
    const catalogDb = ensureDb(catalogDbPath)

    try {
      seedCatalogDb(catalogDb)
      await writeJsonFile(storeConfigPath, {
        ...createBaseConfig(),
        storage: {
          sqlite_path: runtimeDbPath,
        },
        connectors: {
          ...createBaseConfig().connectors,
          products: {
            driver: 'sqlite',
            database: catalogDbPath,
            headers: {},
            health_timeout_ms: 3000,
            retry_policy: { max_attempts: 3, backoff_ms: 250 },
            options: {},
          },
          inventory: {
            driver: 'sqlite',
            database: catalogDbPath,
            headers: {},
            health_timeout_ms: 3000,
            retry_policy: { max_attempts: 3, backoff_ms: 250 },
            options: {},
          },
        },
      })

      const service = new StoreProjectService(createDeployCenterConfig(storeConfigPath, dir))

      const patched = await service.patchStoreConfig({
        store: {
          name: 'Store Patched',
        },
      })

      expect(patched.store.name).toBe('Store Patched')

      const tested = await service.testProductsConnector('Cloud')

      expect(tested.health).toMatchObject({
        ok: true,
        driver: 'sqlite',
      })
      expect(tested.results).toMatchObject({
        products: [
          expect.objectContaining({
            id: 'sku-1',
            name: 'Cloud Pace',
          }),
        ],
      })
    } finally {
      closeTestDb(runtimeDbPath)
      closeTestDb(catalogDbPath)
      await cleanupTempDir(dir)
    }
  })

  it('tests a sqlite customers connector for lookup and register', async () => {
    const dir = await createTempDir('deploy-center-store-project-customers-')
    const storeConfigPath = path.join(dir, 'store.config.json')
    const runtimeDbPath = createTempDbPath(dir, 'runtime.db')
    const customersDbPath = createTempDbPath(dir, 'customers.db')
    ensureDb(runtimeDbPath)
    const customersDb = ensureDb(customersDbPath)

    try {
      seedCustomersDb(customersDb)
      await writeJsonFile(storeConfigPath, {
        ...createBaseConfig(),
        storage: {
          sqlite_path: runtimeDbPath,
        },
        connectors: {
          ...createBaseConfig().connectors,
          customers: {
            driver: 'sqlite',
            database: customersDbPath,
            headers: {},
            health_timeout_ms: 3000,
            retry_policy: { max_attempts: 3, backoff_ms: 250 },
            options: {},
          },
        },
      })

      const service = new StoreProjectService(createDeployCenterConfig(storeConfigPath, dir))

      const lookup = await service.testCustomersConnector('lookup', {
        query: 'Ana',
        limit: 5,
      })
      expect(lookup.health).toMatchObject({
        ok: true,
        driver: 'sqlite',
      })
      expect(lookup.results).toMatchObject({
        customers: [
          expect.objectContaining({
            id: 'cust_sql_1',
            name: 'Ana Gomez',
          }),
        ],
      })

      const registered = await service.testCustomersConnector('register', {
        name: 'Mario Rojas',
        locale: 'es-CR',
        metadata: { visits: 3 },
      })
      expect(registered.results).toMatchObject({
        customer_id: expect.stringMatching(/^cust_/),
      })
    } finally {
      closeTestDb(runtimeDbPath)
      closeTestDb(customersDbPath)
      await cleanupTempDir(dir)
    }
  })

  it('tests a sqlite orders connector for create update and confirm', async () => {
    const dir = await createTempDir('deploy-center-store-project-orders-')
    const storeConfigPath = path.join(dir, 'store.config.json')
    const runtimeDbPath = createTempDbPath(dir, 'runtime.db')
    const ordersDbPath = createTempDbPath(dir, 'orders.db')
    ensureDb(runtimeDbPath)
    ensureDb(ordersDbPath)

    try {
      await writeJsonFile(storeConfigPath, {
        ...createBaseConfig(),
        storage: {
          sqlite_path: runtimeDbPath,
        },
        connectors: {
          ...createBaseConfig().connectors,
          orders: {
            driver: 'sqlite',
            database: ordersDbPath,
            headers: {},
            health_timeout_ms: 3000,
            retry_policy: { max_attempts: 3, backoff_ms: 250 },
            options: {},
          },
        },
      })

      const service = new StoreProjectService(createDeployCenterConfig(storeConfigPath, dir))

      const created = await service.testOrdersConnector('create', {
        items: [
          {
            product_id: 'sku_nike_air_42',
            quantity: 1,
            price: 129.99,
          },
        ],
      })
      expect(created.health).toMatchObject({
        ok: true,
        driver: 'sqlite',
      })
      expect(created.results).toMatchObject({
        order_id: expect.stringMatching(/^ord_/),
        total: 129.99,
        order_state: 'open',
      })

      const orderId = (created.results as { order_id: string }).order_id

      const updated = await service.testOrdersConnector('update', {
        order_id: orderId,
        add_items: [
          {
            product_id: 'sku_adidas_daily',
            quantity: 1,
            price: 89.5,
          },
        ],
      })
      expect(updated.results).toMatchObject({
        order_id: orderId,
        total: 219.49,
        item_count: 2,
      })

      const confirmed = await service.testOrdersConnector('confirm', {
        order_id: orderId,
      })
      expect(confirmed.results).toMatchObject({
        order_id: orderId,
        order_state: 'confirmed',
        payment_status: 'awaiting_payment',
      })
    } finally {
      closeTestDb(runtimeDbPath)
      closeTestDb(ordersDbPath)
      await cleanupTempDir(dir)
    }
  })

  it('tests the mock payments connector with an auto-created preview order', async () => {
    const dir = await createTempDir('deploy-center-store-project-payments-')
    const storeConfigPath = path.join(dir, 'store.config.json')
    const runtimeDbPath = createTempDbPath(dir, 'runtime.db')
    ensureDb(runtimeDbPath)

    try {
      await writeJsonFile(storeConfigPath, {
        ...createBaseConfig(),
        storage: {
          sqlite_path: runtimeDbPath,
        },
      })

      const service = new StoreProjectService(createDeployCenterConfig(storeConfigPath, dir))

      const tested = await service.testPaymentsConnector({
        order_id: 'ord_preview_payment_1',
        amount: 219.49,
        payment_method: 'card',
      })

      expect(tested.health).toMatchObject({
        ok: true,
        driver: 'mock',
      })
      expect(tested.results).toMatchObject({
        payment_intent_id: expect.stringMatching(/^pay_/),
        order_id: 'ord_preview_payment_1',
        amount: 219.49,
        payment_method: 'card',
        status: 'ready',
      })

      const storedOrder = new OrderRepository(ensureDb(runtimeDbPath)).findById(
        'ord_preview_payment_1',
      )
      expect(storedOrder?.result).toMatchObject({
        order_id: 'ord_preview_payment_1',
        total: 219.49,
        order_state: 'confirmed',
        payment_status: 'awaiting_payment',
      })
    } finally {
      closeTestDb(runtimeDbPath)
      await cleanupTempDir(dir)
    }
  })

  it('exposes guided connector presets and applies the REST preset cleanly', async () => {
    const dir = await createTempDir('deploy-center-store-project-presets-')
    const storeConfigPath = path.join(dir, 'store.config.json')
    const runtimeDbPath = createTempDbPath(dir, 'runtime.db')
    ensureDb(runtimeDbPath)

    try {
      await writeJsonFile(storeConfigPath, {
        ...createBaseConfig(),
        storage: {
          sqlite_path: runtimeDbPath,
        },
        connectors: {
          ...createBaseConfig().connectors,
          products: {
            driver: 'sqlite',
            database: './data/legacy-products.db',
            connection_string: './data/legacy-products.db',
            headers: {},
            health_timeout_ms: 3000,
            retry_policy: { max_attempts: 3, backoff_ms: 250 },
            options: {},
          },
          customers: {
            driver: 'sqlite',
            database: './data/legacy-customers.db',
            connection_string: './data/legacy-customers.db',
            headers: {},
            health_timeout_ms: 3000,
            retry_policy: { max_attempts: 3, backoff_ms: 250 },
            options: {},
          },
          orders: {
            driver: 'sqlite',
            database: './data/legacy-orders.db',
            connection_string: './data/legacy-orders.db',
            headers: {},
            health_timeout_ms: 3000,
            retry_policy: { max_attempts: 3, backoff_ms: 250 },
            options: {},
          },
        },
      })

      const service = new StoreProjectService(createDeployCenterConfig(storeConfigPath, dir))
      const dashboard = await service.getDashboardState()

      expect(dashboard.connector_presets.map((preset) => preset.id)).toEqual([
        'demo-local-mock',
        'sqlite-local-retail',
        'rest-backoffice',
      ])

      const restPreset = dashboard.connector_presets.find(
        (preset) => preset.id === 'rest-backoffice',
      )
      expect(restPreset).toBeDefined()

      const patched = await service.patchStoreConfig(restPreset?.patch as Record<string, unknown>)

      expect(patched.connectors.products).toMatchObject({
        driver: 'rest',
        url: 'https://api.store.local/products',
      })
      expect(patched.connectors.products.database).toBeUndefined()
      expect(patched.connectors.products.connection_string).toBeUndefined()
      expect(patched.connectors.customers).toMatchObject({
        driver: 'rest',
        url: 'https://api.store.local/customers',
      })
      expect(patched.connectors.orders).toMatchObject({
        driver: 'rest',
        url: 'https://api.store.local/orders',
      })
      expect(patched.connectors.payments.driver).toBe('mock')
      expect(patched.connectors.receipts.driver).toBe('mock')
    } finally {
      closeTestDb(runtimeDbPath)
      await cleanupTempDir(dir)
    }
  })

  it('can clear connector URLs from the store config', async () => {
    const dir = await createTempDir('deploy-center-store-project-clear-')
    const storeConfigPath = path.join(dir, 'store.config.json')
    const runtimeDbPath = createTempDbPath(dir, 'runtime.db')
    ensureDb(runtimeDbPath)

    try {
      await writeJsonFile(storeConfigPath, {
        ...createBaseConfig(),
        storage: {
          sqlite_path: runtimeDbPath,
        },
        connectors: {
          ...createBaseConfig().connectors,
          products: {
            driver: 'rest',
            url: 'https://api.example.test/products',
            headers: {},
            health_timeout_ms: 3000,
            retry_policy: { max_attempts: 3, backoff_ms: 250 },
            options: {},
          },
        },
      })

      const service = new StoreProjectService(createDeployCenterConfig(storeConfigPath, dir))

      await service.patchStoreConfig({
        connectors: {
          products: {
            driver: 'mock',
            url: null,
            database: null,
            connection_string: null,
          },
        },
      })

      const rawConfig = await service.readStoreConfigRaw()
      expect(rawConfig).toMatchObject({
        connectors: {
          products: {
            driver: 'mock',
          },
        },
      })
      expect(
        (rawConfig as { connectors?: { products?: { url?: unknown; database?: unknown } } })
          .connectors?.products?.url,
      ).toBeUndefined()
      expect(
        (rawConfig as { connectors?: { products?: { url?: unknown; database?: unknown } } })
          .connectors?.products?.database,
      ).toBeUndefined()
    } finally {
      closeTestDb(runtimeDbPath)
      await cleanupTempDir(dir)
    }
  })

  it('rejects connector drivers that the runtime still does not support', async () => {
    const dir = await createTempDir('deploy-center-store-project-unsupported-')
    const storeConfigPath = path.join(dir, 'store.config.json')
    const runtimeDbPath = createTempDbPath(dir, 'runtime.db')
    ensureDb(runtimeDbPath)

    try {
      await writeJsonFile(storeConfigPath, {
        ...createBaseConfig(),
        storage: {
          sqlite_path: runtimeDbPath,
        },
      })

      const service = new StoreProjectService(createDeployCenterConfig(storeConfigPath, dir))

      await expect(
        service.patchStoreConfig({
          connectors: {
            payments: {
              driver: 'rest',
              url: 'https://api.example.test/payments',
              headers: {},
              health_timeout_ms: 3000,
              retry_policy: { max_attempts: 3, backoff_ms: 250 },
              options: {},
            },
          },
        }),
      ).rejects.toThrow(/connectors\.payments\.driver/)

      const rawConfig = await service.readStoreConfigRaw()
      expect(rawConfig).toMatchObject({
        connectors: {
          payments: {
            driver: 'mock',
          },
        },
      })
    } finally {
      closeTestDb(runtimeDbPath)
      await cleanupTempDir(dir)
    }
  })

  it('keeps product preview isolated from unsupported non-product connectors', async () => {
    const dir = await createTempDir('deploy-center-store-project-isolated-')
    const storeConfigPath = path.join(dir, 'store.config.json')
    const runtimeDbPath = createTempDbPath(dir, 'runtime.db')
    const catalogDbPath = createTempDbPath(dir, 'catalog.db')
    ensureDb(runtimeDbPath)
    const catalogDb = ensureDb(catalogDbPath)

    try {
      seedCatalogDb(catalogDb)
      await writeJsonFile(storeConfigPath, {
        ...createBaseConfig(),
        storage: {
          sqlite_path: runtimeDbPath,
        },
        connectors: {
          ...createBaseConfig().connectors,
          products: {
            driver: 'sqlite',
            database: catalogDbPath,
            headers: {},
            health_timeout_ms: 3000,
            retry_policy: { max_attempts: 3, backoff_ms: 250 },
            options: {},
          },
          inventory: {
            driver: 'sqlite',
            database: catalogDbPath,
            headers: {},
            health_timeout_ms: 3000,
            retry_policy: { max_attempts: 3, backoff_ms: 250 },
            options: {},
          },
          customers: {
            driver: 'rest',
            url: 'https://api.invalid/customers',
            headers: {},
            health_timeout_ms: 3000,
            retry_policy: { max_attempts: 3, backoff_ms: 250 },
            options: {},
          },
        },
      })

      const service = new StoreProjectService(createDeployCenterConfig(storeConfigPath, dir))
      const tested = await service.testProductsConnector('Cloud')

      expect(tested.results).toMatchObject({
        products: [
          expect.objectContaining({
            id: 'sku-1',
          }),
        ],
      })
    } finally {
      closeTestDb(runtimeDbPath)
      closeTestDb(catalogDbPath)
      await cleanupTempDir(dir)
    }
  })

  it('reads env entries from the example and writes them to the env file', async () => {
    const dir = await createTempDir('deploy-center-env-')
    const storeConfigPath = path.join(dir, 'store.config.json')
    const envFilePath = path.join(dir, '.env')
    const envExamplePath = path.join(dir, '.env.example')
    const runtimeDbPath = createTempDbPath(dir, 'runtime.db')
    ensureDb(runtimeDbPath)

    try {
      await writeJsonFile(storeConfigPath, {
        ...createBaseConfig(),
        storage: {
          sqlite_path: runtimeDbPath,
        },
      })
      await writeFile(
        envExamplePath,
        'OPENAI_API_KEY=\nREDIS_URL=redis://redis:6379\nSTORE_ADMIN_SECRET=\n',
        'utf8',
      )

      const service = new StoreProjectService({
        ...createDeployCenterConfig(storeConfigPath, dir),
        project: {
          ...createDeployCenterConfig(storeConfigPath, dir).project,
          env_file_path: envFilePath,
          env_example_path: envExamplePath,
        },
      })

      const envState = await service.readEnvState()
      expect(envState.source).toBe('example')
      expect(envState.entries[0]).toMatchObject({
        key: 'OPENAI_API_KEY',
        secret: true,
      })

      const saved = await service.patchEnv({
        OPENAI_API_KEY: 'sk-test',
        STORE_ADMIN_SECRET: 'admin-secret',
      })

      expect(saved.entries).toEqual(
        expect.arrayContaining([
          expect.objectContaining({
            key: 'OPENAI_API_KEY',
            value: 'sk-test',
          }),
          expect.objectContaining({
            key: 'STORE_ADMIN_SECRET',
            value: 'admin-secret',
          }),
        ]),
      )

      await expect(readFile(envFilePath, 'utf8')).resolves.toContain('OPENAI_API_KEY=sk-test')
    } finally {
      closeTestDb(runtimeDbPath)
      await cleanupTempDir(dir)
    }
  })
})

function createDeployCenterConfig(storeConfigPath: string, dir: string): DeployCenterConfig {
  return {
    project: {
      name: 'Deploy Center Test',
      store_config_path: storeConfigPath,
      compose_file_path: path.join(dir, 'docker-compose.yml'),
      working_directory: dir,
      env_file_path: path.join(dir, '.env'),
      env_example_path: path.join(dir, '.env.example'),
      profiles: [],
      logs_tail_lines: 120,
    },
    http: {
      host: '127.0.0.1',
      port: 3030,
    },
    services: [],
    screens: [],
  }
}

function seedCatalogDb(db: ReturnType<typeof ensureDb>): void {
  db.exec(`
    CREATE TABLE IF NOT EXISTS products (
      id TEXT PRIMARY KEY,
      name TEXT NOT NULL,
      description TEXT NOT NULL DEFAULT '',
      price REAL NOT NULL DEFAULT 0,
      stock INTEGER NOT NULL DEFAULT 0,
      metadata TEXT NOT NULL DEFAULT '{}',
      created_at INTEGER NOT NULL,
      updated_at INTEGER NOT NULL
    );
  `)

  db.prepare(
    `
      INSERT INTO products (id, name, description, price, stock, metadata, created_at, updated_at)
      VALUES (@id, @name, @description, @price, @stock, @metadata, @created_at, @updated_at)
    `,
  ).run({
    id: 'sku-1',
    name: 'Cloud Pace',
    description: 'Daily trainer',
    price: 89.9,
    stock: 12,
    metadata: JSON.stringify({ source: 'deploy-center-test' }),
    created_at: 1,
    updated_at: 1,
  })
}

function seedCustomersDb(db: ReturnType<typeof ensureDb>): void {
  const repository = new CustomerRepository(db)
  repository.upsert({
    id: 'cust_sql_1',
    name: 'Ana Gomez',
    locale: 'es',
    metadata: { loyalty_tier: 'gold' },
  })
}
