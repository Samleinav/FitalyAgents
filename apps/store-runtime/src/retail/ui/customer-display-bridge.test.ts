import path from 'node:path'
import { describe, expect, it } from 'vitest'
import { InMemoryBus } from 'fitalyagents'
import { startCustomerDisplayService } from './customer-display-bridge.js'
import {
  cleanupTempDir,
  createBaseConfig,
  createTempDir,
  writeJsonFile,
} from '../../../test/helpers.js'

describe('customer-display-bridge', () => {
  it('serves a customer display snapshot built from curated retail events', async () => {
    const dir = await createTempDir('customer-display-')
    const configPath = path.join(dir, 'store.config.json')
    const bus = new InMemoryBus()

    await writeJsonFile(configPath, {
      ...createBaseConfig(),
      retail: {
        ...createBaseConfig().retail,
        customer_display_enabled: true,
        customer_display_mode: 'full',
      },
    })

    const service = await startCustomerDisplayService({
      configPath,
      bus,
      host: '127.0.0.1',
      port: 0,
    })

    try {
      await bus.publish('bus:DRAFT_CREATED', {
        event: 'DRAFT_CREATED',
        draft_id: 'draft-1',
        session_id: 'session-1',
        intent_id: 'order_create',
        summary: {
          items: [{ product_id: 'sku-1', name: 'Cloud Pace', quantity: 1, price: 89.9 }],
        },
        timestamp: 1,
      })
      await bus.publish('bus:TOOL_RESULT', {
        event: 'TOOL_RESULT',
        tool_name: 'order_create',
        session_id: 'session-1',
        result: {
          order_id: 'ord-1',
          order_state: 'open',
          total: 89.9,
          items: [
            {
              product_id: 'sku-1',
              name: 'Cloud Pace',
              quantity: 1,
              price: 89.9,
              line_total: 89.9,
            },
          ],
          text: 'La orden quedó preparada.',
        },
        timestamp: 2,
      })
      await bus.publish('bus:TOOL_RESULT', {
        event: 'TOOL_RESULT',
        tool_name: 'payment_intent_create',
        session_id: 'session-1',
        result: {
          order_id: 'ord-1',
          amount: 89.9,
          payment_method: 'card',
          status: 'ready',
          text: 'Preparé el cobro.',
        },
        timestamp: 3,
      })
      await bus.publish('bus:APPROVAL_RESOLVED', {
        event: 'APPROVAL_RESOLVED',
        request_id: 'approval-1',
        session_id: 'session-1',
        approved: true,
        approver_id: 'mgr-1',
        timestamp: 4,
      })

      expect(service.hub.getLastState()).toMatchObject({
        storeId: 'store-test',
        mode: 'full',
        order: {
          orderId: 'ord-1',
          paymentStatus: 'waiting',
          approvalStatus: 'approved',
        },
      })

      const health = await service.server.inject({
        method: 'GET',
        url: '/health',
      })
      expect(health.statusCode).toBe(200)
      expect(health.json()).toEqual({
        status: 'ok',
        store_id: 'store-test',
        mode: 'full',
        enabled: true,
        subscribers: 0,
        has_state: true,
      })

      const stateResponse = await service.server.inject({
        method: 'GET',
        url: '/state',
      })
      expect(stateResponse.statusCode).toBe(200)
      expect(stateResponse.json()).toMatchObject({
        storeId: 'store-test',
        order: {
          orderId: 'ord-1',
          total: 89.9,
        },
      })

      const page = await service.server.inject({
        method: 'GET',
        url: '/',
      })
      expect(page.statusCode).toBe(200)
      expect(page.body).toContain('Pantalla Cliente')
      expect(page.body).toContain('customer_display_state')
    } finally {
      await service.shutdown()
      await cleanupTempDir(dir)
    }
  })
})
