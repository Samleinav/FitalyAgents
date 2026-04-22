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

describe('customer connectors', () => {
  it('queries and registers customers through a sqlite connector', async () => {
    const dir = await createTempDir('store-runtime-customer-sqlite-')
    const runtimeDbPath = createTempDbPath(dir, 'runtime.db')
    const customersDbPath = createTempDbPath(dir, 'customers.db')
    const runtimeDb = ensureDb(runtimeDbPath)
    const customersDb = ensureDb(customersDbPath)

    try {
      seedCustomersDb(customersDb)

      const config = createBaseConfig({
        storage: { sqlite_path: runtimeDbPath },
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

      const adapters = createRetailAdapterCatalog({
        db: runtimeDb,
        repositories: createRepositories(runtimeDb),
        config,
      })

      try {
        await expect(adapters.customers.health()).resolves.toMatchObject({
          ok: true,
          driver: 'sqlite',
        })

        await expect(
          adapters.customers.execute(
            'lookup',
            { query: 'Ana', limit: 5 },
            { session_id: 'session-1', store_id: 'store-test' },
          ),
        ).resolves.toMatchObject({
          customers: [
            expect.objectContaining({
              id: 'cust_sql_1',
              name: 'Ana Gomez',
            }),
          ],
        })

        const registered = await adapters.customers.execute(
          'register',
          {
            name: 'Maria Lopez',
            locale: 'es-CR',
            metadata: { loyalty_tier: 'bronze' },
          },
          { session_id: 'session-2', store_id: 'store-test' },
        )

        expect(registered).toMatchObject({
          customer_id: expect.stringMatching(/^cust_/),
        })

        const registeredId = (registered as { customer_id: string }).customer_id

        await expect(
          adapters.customers.execute(
            'lookup',
            { customer_id: registeredId },
            { session_id: 'session-3', store_id: 'store-test' },
          ),
        ).resolves.toMatchObject({
          customers: [
            expect.objectContaining({
              id: registeredId,
              name: 'Maria Lopez',
              locale: 'es-CR',
            }),
          ],
        })
      } finally {
        await Promise.resolve(adapters.customers.dispose?.())
      }
    } finally {
      closeTestDb(runtimeDbPath)
      closeTestDb(customersDbPath)
      await cleanupTempDir(dir)
    }
  })

  it('queries and registers customers through a REST connector', async () => {
    const dir = await createTempDir('store-runtime-customer-rest-')
    const runtimeDbPath = createTempDbPath(dir, 'runtime.db')
    const runtimeDb = ensureDb(runtimeDbPath)
    const customers: Array<{
      id: string
      name: string
      locale: string
      metadata: Record<string, unknown>
    }> = [
      {
        id: 'cust_rest_1',
        name: 'Lucia Torres',
        locale: 'es',
        metadata: { source: 'rest' },
      },
    ]

    const server = createServer(async (request, response) => {
      const requestUrl = new URL(request.url ?? '/', 'http://127.0.0.1')
      if (requestUrl.pathname !== '/customers') {
        response.statusCode = 404
        response.end()
        return
      }

      if (request.method === 'GET') {
        const query = requestUrl.searchParams.get('query')
        const customerId = requestUrl.searchParams.get('customer_id')
        const matches = customers.filter((customer) => {
          if (customerId) {
            return customer.id === customerId
          }

          if (query) {
            return customer.name.includes(query) || customer.id.includes(query)
          }

          return true
        })

        response.setHeader('content-type', 'application/json')
        response.end(
          JSON.stringify({
            customers: matches,
            text: 'Clientes remotos encontrados.',
          }),
        )
        return
      }

      if (request.method === 'POST') {
        const body = await readJsonBody(request)
        const created = {
          id: 'cust_rest_2',
          name: String(body.name ?? '').trim(),
          locale: String(body.locale ?? 'es').trim() || 'es',
          metadata:
            body.metadata && typeof body.metadata === 'object'
              ? (body.metadata as Record<string, unknown>)
              : {},
        }
        customers.push(created)

        response.statusCode = 201
        response.setHeader('content-type', 'application/json')
        response.end(
          JSON.stringify({
            customer_id: created.id,
            text: 'Cliente remoto registrado.',
          }),
        )
        return
      }

      response.statusCode = 405
      response.end()
    })

    try {
      await listen(server)

      const address = server.address()
      if (!address || typeof address === 'string') {
        throw new Error('REST test server did not expose an address')
      }

      const baseUrl = `http://127.0.0.1:${address.port}/customers`
      const config = createBaseConfig({
        storage: { sqlite_path: runtimeDbPath },
        connectors: {
          ...createBaseConfig().connectors,
          customers: {
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

      await expect(adapters.customers.health()).resolves.toMatchObject({
        ok: true,
        driver: 'rest',
      })

      await expect(
        adapters.customers.execute(
          'lookup',
          { query: 'Lucia' },
          { session_id: 'session-1', store_id: 'store-test' },
        ),
      ).resolves.toMatchObject({
        customers: [
          expect.objectContaining({
            id: 'cust_rest_1',
            name: 'Lucia Torres',
          }),
        ],
      })

      await expect(
        adapters.customers.execute(
          'register',
          {
            name: 'Mario Rojas',
            locale: 'es-CR',
            metadata: { visits: 3 },
          },
          { session_id: 'session-2', store_id: 'store-test' },
        ),
      ).resolves.toMatchObject({
        customer_id: 'cust_rest_2',
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

function seedCustomersDb(db: ReturnType<typeof ensureDb>): void {
  const repository = new CustomerRepository(db)
  repository.upsert({
    id: 'cust_sql_1',
    name: 'Ana Gomez',
    locale: 'es',
    metadata: { loyalty_tier: 'gold' },
  })
  repository.upsert({
    id: 'cust_sql_2',
    name: 'Luis Rivera',
    locale: 'es',
    metadata: { loyalty_tier: 'silver' },
  })
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
