import { describe, expect, it } from 'vitest'
import { InMemoryBus } from 'fitalyagents'
import { registerRetailPresetTools } from './preset.js'
import { ToolRegistry } from '../tools/registry.js'
import {
  ApprovalRepository,
  CustomerRepository,
  DraftRepository,
  EmployeeRepository,
  OrderRepository,
  SessionRepository,
  WebhookRepository,
} from '../storage/repositories/index.js'
import {
  cleanupTempDir,
  closeTestDb,
  createBaseConfig,
  createTempDbPath,
  createTempDir,
  ensureDb,
} from '../../test/helpers.js'

describe('retail phase-one tools', () => {
  it('registers the day-1 tools from the retail preset', async () => {
    const harness = await createRetailHarness()

    try {
      expect(harness.registry.list().map((tool) => tool.tool_id)).toEqual([
        'product_search',
        'inventory_check',
        'customer_lookup',
        'order_create',
        'order_update',
        'order_confirm',
        'payment_intent_create',
        'receipt_print',
      ])
    } finally {
      await cleanupRetailHarness(harness)
    }
  })

  it('runs the mock retail flow end-to-end', async () => {
    const harness = await createRetailHarness()

    try {
      const searchResult = await harness.registry.runWithContext(baseContext(), () =>
        harness.registry.execute('product_search', { query: 'Nike' }),
      )
      expect((searchResult as { products: unknown[] }).products.length).toBeGreaterThan(0)

      const inventoryResult = await harness.registry.runWithContext(baseContext(), () =>
        harness.registry.execute('inventory_check', { query: 'Nike' }),
      )
      expect(inventoryResult).toMatchObject({
        in_stock: true,
      })

      const customerLookup = await harness.registry.runWithContext(baseContext(), () =>
        harness.registry.execute('customer_lookup', { query: 'Ana' }),
      )
      expect(
        (customerLookup as { customers: Array<{ name: string }> }).customers[0]?.name,
      ).toContain('Ana')

      const orderResult = await harness.registry.runWithContext(baseContext(), () =>
        harness.registry.execute('order_create', {
          customer_id: 'cust_demo_001',
          items: [{ product_id: 'sku_nike_air_42', quantity: 1, price: 129.99 }],
        }),
      )
      const orderId = (orderResult as { order_id: string }).order_id
      expect(harness.repositories.orders.findById(orderId)?.result).toMatchObject({
        order_state: 'open',
      })

      const updateResult = await harness.registry.runWithContext(baseContext(), () =>
        harness.registry.execute('order_update', {
          order_id: orderId,
          add_items: [{ product_id: 'sku_adidas_daily', quantity: 1, price: 89.5 }],
        }),
      )
      expect(updateResult).toMatchObject({
        item_count: 2,
        order_state: 'open',
      })

      const confirmResult = await harness.registry.runWithContext(
        baseContext({ role: 'cashier' }),
        () =>
          harness.registry.execute('order_confirm', {
            order_id: orderId,
          }),
      )
      expect(confirmResult).toMatchObject({
        order_state: 'confirmed',
        payment_status: 'awaiting_payment',
      })

      const paymentIntent = await harness.registry.runWithContext(
        baseContext({ role: 'cashier' }),
        () =>
          harness.registry.execute('payment_intent_create', {
            order_id: orderId,
            payment_method: 'card',
          }),
      )
      expect(paymentIntent).toMatchObject({
        order_id: orderId,
        status: 'ready',
        payment_method: 'card',
      })

      const receiptResult = await harness.registry.runWithContext(
        baseContext({ role: 'cashier' }),
        () =>
          harness.registry.execute('receipt_print', {
            order_id: orderId,
          }),
      )
      expect(receiptResult).toMatchObject({
        order_id: orderId,
        status: 'printed',
      })
    } finally {
      await cleanupRetailHarness(harness)
    }
  })
})

async function createRetailHarness() {
  const dir = await createTempDir('store-runtime-retail-')
  const dbPath = createTempDbPath(dir)
  const db = ensureDb(dbPath)
  const bus = new InMemoryBus()
  const config = createBaseConfig()

  const repositories = {
    customers: new CustomerRepository(db),
    employees: new EmployeeRepository(db),
    drafts: new DraftRepository(db),
    orders: new OrderRepository(db),
    approvals: new ApprovalRepository(db),
    sessions: new SessionRepository(db),
    webhooks: new WebhookRepository(db),
  }

  const registry = new ToolRegistry({
    bus,
    db,
    storeId: 'store-test',
    repositories,
    approvalsConfig: config.approvals,
    employees: [
      {
        id: 'cash-1',
        name: 'Caja',
        role: 'cashier',
        approval_limits: {
          payment_max: 1000,
        },
      },
      {
        id: 'mgr-1',
        name: 'Gerente',
        role: 'manager',
        approval_limits: {
          refund_max: 250,
          discount_max_pct: 15,
        },
      },
    ],
    policies: config.policies,
  })

  registerRetailPresetTools({
    toolRegistry: registry,
    config,
    db,
    repositories,
  })

  return {
    registry,
    repositories,
    dbPath,
    dir,
  }
}

function baseContext(overrides: Partial<{ role: 'customer' | 'cashier' }> = {}) {
  return {
    session_id: 'session-1',
    store_id: 'store-test',
    speaker_id: 'speaker-1',
    role: overrides.role ?? 'customer',
  }
}

async function cleanupRetailHarness(harness: { dbPath: string; dir: string }) {
  closeTestDb(harness.dbPath)
  await cleanupTempDir(harness.dir)
}
