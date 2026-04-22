import { createServer, type IncomingMessage } from 'node:http'
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

describe('order connectors', () => {
  it('creates, updates and confirms orders through a sqlite connector', async () => {
    const dir = await createTempDir('store-runtime-order-sqlite-')
    const runtimeDbPath = createTempDbPath(dir, 'runtime.db')
    const ordersDbPath = createTempDbPath(dir, 'orders.db')
    const runtimeDb = ensureDb(runtimeDbPath)
    ensureDb(ordersDbPath)

    try {
      const config = createBaseConfig({
        storage: { sqlite_path: runtimeDbPath },
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

      const adapters = createRetailAdapterCatalog({
        db: runtimeDb,
        repositories: createRepositories(runtimeDb),
        config,
      })

      try {
        await expect(adapters.orders.health()).resolves.toMatchObject({
          ok: true,
          driver: 'sqlite',
        })

        const created = await adapters.orders.execute(
          'create',
          {
            customer_id: 'cust_sql_1',
            items: [{ product_id: 'sku_nike_air_42', quantity: 1, price: 129.99 }],
          },
          { session_id: 'session-1', store_id: 'store-test' },
        )

        expect(created).toMatchObject({
          order_id: expect.stringMatching(/^ord_/),
          total: 129.99,
          item_count: 1,
          order_state: 'open',
          items: [
            expect.objectContaining({
              product_id: 'sku_nike_air_42',
              name: 'Nike Air Runner 42',
            }),
          ],
        })

        const orderId = (created as { order_id: string }).order_id

        await expect(
          adapters.orders.execute(
            'update',
            {
              order_id: orderId,
              add_items: [{ product_id: 'sku_adidas_daily', quantity: 1, price: 89.5 }],
            },
            { session_id: 'session-1', store_id: 'store-test' },
          ),
        ).resolves.toMatchObject({
          order_id: orderId,
          total: 219.49,
          item_count: 2,
          order_state: 'open',
        })

        await expect(
          adapters.orders.execute(
            'confirm',
            { order_id: orderId },
            { session_id: 'session-1', store_id: 'store-test' },
          ),
        ).resolves.toMatchObject({
          order_id: orderId,
          total: 219.49,
          order_state: 'confirmed',
          payment_status: 'awaiting_payment',
        })
      } finally {
        await Promise.resolve(adapters.orders.dispose?.())
      }
    } finally {
      closeTestDb(runtimeDbPath)
      closeTestDb(ordersDbPath)
      await cleanupTempDir(dir)
    }
  })

  it('creates, updates and confirms orders through a REST connector', async () => {
    const dir = await createTempDir('store-runtime-order-rest-')
    const runtimeDbPath = createTempDbPath(dir, 'runtime.db')
    const runtimeDb = ensureDb(runtimeDbPath)
    const orderState = {
      order_id: 'ord_rest_1',
      items: [
        {
          product_id: 'sku-rest-1',
          name: 'Tempo Rise',
          quantity: 1,
          price: 109.5,
          line_total: 109.5,
        },
      ],
      total: 109.5,
      item_count: 1,
      order_state: 'open' as const,
    }

    const server = createServer(async (request, response) => {
      const requestUrl = new URL(request.url ?? '/', 'http://127.0.0.1')
      if (requestUrl.pathname === '/orders' && request.method === 'GET') {
        response.setHeader('content-type', 'application/json')
        response.end(JSON.stringify({ ok: true }))
        return
      }

      if (requestUrl.pathname === '/orders' && request.method === 'POST') {
        const body = await readJsonBody(request)
        const item = Array.isArray(body.items) ? body.items[0] : {}
        orderState.items = [
          {
            product_id:
              item && typeof item === 'object' && 'product_id' in item
                ? String((item as { product_id?: unknown }).product_id ?? '')
                : 'sku-rest-1',
            name: 'Tempo Rise',
            quantity:
              item && typeof item === 'object' && 'quantity' in item
                ? Number((item as { quantity?: unknown }).quantity ?? 1)
                : 1,
            price:
              item && typeof item === 'object' && 'price' in item
                ? Number((item as { price?: unknown }).price ?? 109.5)
                : 109.5,
            line_total:
              item && typeof item === 'object' && 'quantity' in item && 'price' in item
                ? Number((item as { quantity?: unknown }).quantity ?? 1) *
                  Number((item as { price?: unknown }).price ?? 109.5)
                : 109.5,
          },
        ]
        orderState.total = orderState.items.reduce((sum, entry) => sum + entry.line_total, 0)
        orderState.item_count = orderState.items.length

        response.statusCode = 201
        response.setHeader('content-type', 'application/json')
        response.end(
          JSON.stringify({
            ...orderState,
            text: 'Orden remota creada.',
          }),
        )
        return
      }

      if (requestUrl.pathname === '/orders/ord_rest_1' && request.method === 'PATCH') {
        orderState.items.push({
          product_id: 'sku-rest-2',
          name: 'Tempo Sprint',
          quantity: 1,
          price: 44.5,
          line_total: 44.5,
        })
        orderState.total = orderState.items.reduce((sum, entry) => sum + entry.line_total, 0)
        orderState.item_count = orderState.items.length

        response.setHeader('content-type', 'application/json')
        response.end(
          JSON.stringify({
            ...orderState,
            text: 'Orden remota actualizada.',
          }),
        )
        return
      }

      if (requestUrl.pathname === '/orders/ord_rest_1/confirm' && request.method === 'POST') {
        response.setHeader('content-type', 'application/json')
        response.end(
          JSON.stringify({
            ...orderState,
            order_state: 'confirmed',
            payment_status: 'awaiting_payment',
            text: 'Orden remota confirmada.',
          }),
        )
        return
      }

      response.statusCode = 404
      response.end()
    })

    try {
      await listen(server)

      const address = server.address()
      if (!address || typeof address === 'string') {
        throw new Error('REST test server did not expose an address')
      }

      const baseUrl = `http://127.0.0.1:${address.port}/orders`
      const config = createBaseConfig({
        storage: { sqlite_path: runtimeDbPath },
        connectors: {
          ...createBaseConfig().connectors,
          orders: {
            driver: 'rest',
            url: baseUrl,
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

      await expect(adapters.orders.health()).resolves.toMatchObject({
        ok: true,
        driver: 'rest',
      })

      await expect(
        adapters.orders.execute(
          'create',
          {
            items: [{ product_id: 'sku-rest-1', quantity: 1, price: 109.5 }],
          },
          { session_id: 'session-1', store_id: 'store-test' },
        ),
      ).resolves.toMatchObject({
        order_id: 'ord_rest_1',
        total: 109.5,
        item_count: 1,
        order_state: 'open',
      })

      await expect(
        adapters.orders.execute(
          'update',
          {
            order_id: 'ord_rest_1',
            add_items: [{ product_id: 'sku-rest-2', quantity: 1, price: 44.5 }],
          },
          { session_id: 'session-1', store_id: 'store-test' },
        ),
      ).resolves.toMatchObject({
        order_id: 'ord_rest_1',
        total: 154,
        item_count: 2,
        order_state: 'open',
      })

      await expect(
        adapters.orders.execute(
          'confirm',
          {
            order_id: 'ord_rest_1',
          },
          { session_id: 'session-1', store_id: 'store-test' },
        ),
      ).resolves.toMatchObject({
        order_id: 'ord_rest_1',
        total: 154,
        order_state: 'confirmed',
        payment_status: 'awaiting_payment',
      })
    } finally {
      await closeServer(server)
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

function listen(server: ReturnType<typeof createServer>): Promise<void> {
  return new Promise((resolve) => {
    server.listen(0, '127.0.0.1', () => resolve())
  })
}

function closeServer(server: ReturnType<typeof createServer>): Promise<void> {
  return new Promise((resolve, reject) => {
    server.close((error) => {
      if (error) {
        reject(error)
        return
      }
      resolve()
    })
  })
}

function readJsonBody(request: IncomingMessage): Promise<Record<string, unknown>> {
  return new Promise((resolve, reject) => {
    const chunks: Buffer[] = []

    request.on('data', (chunk: Buffer) => {
      chunks.push(chunk)
    })
    request.on('end', () => {
      const raw = Buffer.concat(chunks).toString('utf8').trim()
      if (!raw) {
        resolve({})
        return
      }

      try {
        const parsed = JSON.parse(raw)
        resolve(parsed && typeof parsed === 'object' ? (parsed as Record<string, unknown>) : {})
      } catch (error) {
        reject(error)
      }
    })
    request.on('error', reject)
  })
}
