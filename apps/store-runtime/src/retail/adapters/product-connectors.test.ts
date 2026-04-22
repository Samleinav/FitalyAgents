import { createServer } from 'node:http'
import { describe, expect, it } from 'vitest'
import { createRetailAdapterCatalog } from './catalog.js'
import {
  cleanupTempDir,
  closeTestDb,
  createBaseConfig,
  createTempDbPath,
  createTempDir,
  ensureDb,
} from '../../../test/helpers.js'
import {
  ApprovalRepository,
  CustomerRepository,
  DraftRepository,
  EmployeeRepository,
  OrderRepository,
  SessionRepository,
  WebhookRepository,
} from '../../storage/repositories/index.js'

describe('product connectors', () => {
  it('queries products and inventory from a sqlite connector', async () => {
    const dir = await createTempDir('store-runtime-sqlite-connector-')
    const runtimeDbPath = createTempDbPath(dir, 'runtime.db')
    const catalogDbPath = createTempDbPath(dir, 'catalog.db')
    const runtimeDb = ensureDb(runtimeDbPath)
    const catalogDb = ensureDb(catalogDbPath)

    try {
      seedCatalogDb(catalogDb)

      const config = createBaseConfig({
        storage: { sqlite_path: runtimeDbPath },
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

      const adapters = createRetailAdapterCatalog({
        db: runtimeDb,
        repositories: createRepositories(runtimeDb),
        config,
      })

      await expect(adapters.products.health()).resolves.toMatchObject({
        ok: true,
        driver: 'sqlite',
      })

      await expect(
        adapters.products.execute(
          'search',
          { query: 'Cloud', limit: 5 },
          { session_id: 'session-1', store_id: 'store-test' },
        ),
      ).resolves.toMatchObject({
        products: [
          expect.objectContaining({
            id: 'sku-1',
            name: 'Cloud Pace',
          }),
        ],
      })

      await expect(
        adapters.inventory.execute(
          'inventory_check',
          { product_id: 'sku-1' },
          { session_id: 'session-1', store_id: 'store-test' },
        ),
      ).resolves.toMatchObject({
        in_stock: true,
        products: [
          expect.objectContaining({
            id: 'sku-1',
            stock: 12,
          }),
        ],
      })
    } finally {
      closeTestDb(runtimeDbPath)
      closeTestDb(catalogDbPath)
      await cleanupTempDir(dir)
    }
  })

  it('queries products and inventory from a REST connector', async () => {
    const dir = await createTempDir('store-runtime-rest-connector-')
    const runtimeDbPath = createTempDbPath(dir, 'runtime.db')
    const runtimeDb = ensureDb(runtimeDbPath)
    const server = createServer((request, response) => {
      const requestUrl = new URL(request.url ?? '/', 'http://127.0.0.1')
      if (requestUrl.pathname === '/products') {
        response.setHeader('content-type', 'application/json')
        response.end(
          JSON.stringify({
            products: [
              {
                id: 'sku-rest-1',
                name: 'Tempo Rise',
                description: 'REST-backed product',
                price: 109.5,
                stock: 6,
                metadata: { source: 'rest' },
              },
            ],
            text: 'Encontré 1 producto remoto.',
          }),
        )
        return
      }

      if (requestUrl.pathname === '/inventory') {
        response.setHeader('content-type', 'application/json')
        response.end(
          JSON.stringify({
            products: [
              {
                id: 'sku-rest-1',
                name: 'Tempo Rise',
                description: 'REST-backed product',
                price: 109.5,
                stock: 6,
                metadata: { source: 'rest' },
              },
            ],
            in_stock: true,
            text: 'Stock remoto disponible.',
          }),
        )
        return
      }

      response.statusCode = 404
      response.end()
    })

    try {
      await new Promise<void>((resolve) => {
        server.listen(0, '127.0.0.1', () => resolve())
      })

      const address = server.address()
      if (!address || typeof address === 'string') {
        throw new Error('REST test server did not expose an address')
      }

      const baseUrl = `http://127.0.0.1:${address.port}`
      const config = createBaseConfig({
        storage: { sqlite_path: runtimeDbPath },
        connectors: {
          ...createBaseConfig().connectors,
          products: {
            driver: 'rest',
            url: `${baseUrl}/products`,
            headers: {},
            health_timeout_ms: 3000,
            retry_policy: { max_attempts: 3, backoff_ms: 250 },
            options: {},
          },
          inventory: {
            driver: 'rest',
            url: `${baseUrl}/inventory`,
            headers: {},
            health_timeout_ms: 3000,
            retry_policy: { max_attempts: 3, backoff_ms: 250 },
            options: {},
          },
        },
      })

      const adapters = createRetailAdapterCatalog({
        db: runtimeDb,
        repositories: createRepositories(runtimeDb),
        config,
      })

      await expect(adapters.products.health()).resolves.toMatchObject({
        ok: true,
        driver: 'rest',
      })

      await expect(
        adapters.products.execute(
          'search',
          { query: 'Tempo', limit: 5 },
          { session_id: 'session-1', store_id: 'store-test' },
        ),
      ).resolves.toMatchObject({
        products: [
          expect.objectContaining({
            id: 'sku-rest-1',
            name: 'Tempo Rise',
          }),
        ],
      })

      await expect(
        adapters.inventory.execute(
          'inventory_check',
          { query: 'Tempo', limit: 5 },
          { session_id: 'session-1', store_id: 'store-test' },
        ),
      ).resolves.toMatchObject({
        in_stock: true,
        text: 'Stock remoto disponible.',
      })
    } finally {
      await new Promise<void>((resolve, reject) => {
        server.close((error) => {
          if (error) {
            reject(error)
            return
          }
          resolve()
        })
      })
      closeTestDb(runtimeDbPath)
      await cleanupTempDir(dir)
    }
  })
})

function createRepositories(db: ReturnType<typeof ensureDb>) {
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

function seedCatalogDb(db: ReturnType<typeof ensureDb>): void {
  db.exec(`
    CREATE TABLE IF NOT EXISTS products (
      id TEXT PRIMARY KEY,
      name TEXT NOT NULL,
      description TEXT NOT NULL DEFAULT '',
      price REAL NOT NULL DEFAULT 0,
      stock INTEGER NOT NULL DEFAULT 0,
      metadata TEXT NOT NULL DEFAULT '{}'
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
    metadata: JSON.stringify({ source: 'sqlite-test' }),
    created_at: 1,
    updated_at: 1,
  })
}
