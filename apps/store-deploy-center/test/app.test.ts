import { describe, expect, it, vi } from 'vitest'
import type { DeployCenterConfig } from '../src/config/schema.js'
import { buildDeployCenterServer } from '../src/server/app.js'

describe('deploy-center HTTP server', () => {
  it('serves state and proxies deploy actions', async () => {
    const projectService = {
      getDashboardState: vi.fn().mockResolvedValue({
        project: {
          name: 'Deploy Center',
          store_config_path: '/tmp/store.config.json',
          compose_file_path: '/tmp/docker-compose.yml',
          working_directory: '/tmp',
          env_file_path: '/tmp/.env',
          profiles: [],
        },
        services: [],
        screens: [],
        store: {
          store_id: 'store-test',
          name: 'Store Test',
          locale: 'es',
          timezone: 'UTC',
        },
        retail: {
          service_mode: 'assisted-retail',
          store_position: 'cashier',
          greeting_style: 'Hola',
          upsell_policy: 'light',
          handoff_policy: 'manual',
          customer_display_enabled: false,
          customer_display_mode: 'order',
        },
        connectors: {
          products: {
            driver: 'mock',
            headers: {},
            health_timeout_ms: 3000,
            retry_policy: { max_attempts: 3, backoff_ms: 250 },
            options: {},
          },
          inventory: {
            driver: 'mock',
            headers: {},
            health_timeout_ms: 3000,
            retry_policy: { max_attempts: 3, backoff_ms: 250 },
            options: {},
          },
          customers: {
            driver: 'mock',
            headers: {},
            health_timeout_ms: 3000,
            retry_policy: { max_attempts: 3, backoff_ms: 250 },
            options: {},
          },
          orders: {
            driver: 'mock',
            headers: {},
            health_timeout_ms: 3000,
            retry_policy: { max_attempts: 3, backoff_ms: 250 },
            options: {},
          },
          payments: {
            driver: 'mock',
            headers: {},
            health_timeout_ms: 3000,
            retry_policy: { max_attempts: 3, backoff_ms: 250 },
            options: {},
          },
        },
        connector_presets: [
          {
            id: 'demo-local-mock',
            label: 'Demo Local Mock',
            summary: 'Mock',
            description: 'Mock',
            badges: ['Demo'],
            patch: { connectors: { products: { driver: 'mock' } } },
          },
        ],
        env_summary: {
          total: 3,
          configured: 1,
          source: 'file',
        },
      }),
      readStoreConfigRaw: vi.fn().mockResolvedValue({ store: { store_id: 'store-test' } }),
      readEnvState: vi.fn().mockResolvedValue({
        path: '/tmp/.env',
        source: 'file',
        entries: [],
      }),
      patchEnv: vi.fn().mockResolvedValue({
        path: '/tmp/.env',
        source: 'file',
        entries: [],
      }),
      patchStoreConfig: vi.fn().mockResolvedValue({ store: { store_id: 'store-test' } }),
      testProductsConnector: vi.fn().mockResolvedValue({
        health: { ok: true },
        results: { products: [] },
      }),
      testCustomersConnector: vi.fn().mockResolvedValue({
        health: { ok: true },
        results: { customers: [] },
      }),
      testOrdersConnector: vi.fn().mockResolvedValue({
        health: { ok: true },
        results: { order_id: 'ord-1' },
      }),
      testPaymentsConnector: vi.fn().mockResolvedValue({
        health: { ok: true },
        results: { payment_intent_id: 'pay-1' },
      }),
    }

    const supervisor = {
      deployAll: vi.fn().mockResolvedValue({
        command: 'docker',
        args: [],
        cwd: '/tmp',
        exitCode: 0,
        stdout: 'ok',
        stderr: '',
        ok: true,
      }),
      stopAll: vi.fn().mockResolvedValue({
        command: 'docker',
        args: [],
        cwd: '/tmp',
        exitCode: 0,
        stdout: 'ok',
        stderr: '',
        ok: true,
      }),
      restartService: vi.fn().mockResolvedValue({
        command: 'docker',
        args: [],
        cwd: '/tmp',
        exitCode: 0,
        stdout: 'ok',
        stderr: '',
        ok: true,
      }),
      startService: vi.fn().mockResolvedValue({
        command: 'docker',
        args: [],
        cwd: '/tmp',
        exitCode: 0,
        stdout: 'ok',
        stderr: '',
        ok: true,
      }),
      stopService: vi.fn().mockResolvedValue({
        command: 'docker',
        args: [],
        cwd: '/tmp',
        exitCode: 0,
        stdout: 'ok',
        stderr: '',
        ok: true,
      }),
      serviceLogs: vi.fn().mockResolvedValue({
        command: 'docker',
        args: [],
        cwd: '/tmp',
        exitCode: 0,
        stdout: 'ok',
        stderr: '',
        ok: true,
      }),
    }

    const server = buildDeployCenterServer({
      config: {
        project: {
          name: 'Deploy Center',
          store_config_path: '/tmp/store.config.json',
          compose_file_path: '/tmp/docker-compose.yml',
          working_directory: '/tmp',
          env_file_path: '/tmp/.env',
          env_example_path: '/tmp/.env.example',
          profiles: [],
          logs_tail_lines: 120,
        },
        http: {
          host: '127.0.0.1',
          port: 3030,
        },
        services: [],
        screens: [],
      } satisfies DeployCenterConfig,
      projectService,
      supervisor,
    })

    try {
      const stateResponse = await server.inject({
        method: 'GET',
        url: '/api/state',
      })
      expect(stateResponse.statusCode).toBe(200)
      expect(stateResponse.json()).toMatchObject({
        connector_presets: [
          expect.objectContaining({
            id: 'demo-local-mock',
          }),
        ],
      })

      const deployResponse = await server.inject({
        method: 'POST',
        url: '/api/deploy/up',
      })
      expect(deployResponse.statusCode).toBe(200)
      expect(supervisor.deployAll).toHaveBeenCalled()

      const envResponse = await server.inject({
        method: 'GET',
        url: '/api/env',
      })
      expect(envResponse.statusCode).toBe(200)

      const customersResponse = await server.inject({
        method: 'POST',
        url: '/api/connectors/customers/test',
        payload: {
          action: 'lookup',
          input: { query: 'Ana' },
        },
      })
      expect(customersResponse.statusCode).toBe(200)
      expect(projectService.testCustomersConnector).toHaveBeenCalledWith('lookup', { query: 'Ana' })

      const ordersResponse = await server.inject({
        method: 'POST',
        url: '/api/connectors/orders/test',
        payload: {
          action: 'create',
          input: {
            items: [{ product_id: 'sku-1', quantity: 1, price: 99 }],
          },
        },
      })
      expect(ordersResponse.statusCode).toBe(200)
      expect(projectService.testOrdersConnector).toHaveBeenCalledWith('create', {
        items: [{ product_id: 'sku-1', quantity: 1, price: 99 }],
      })

      const paymentsResponse = await server.inject({
        method: 'POST',
        url: '/api/connectors/payments/test',
        payload: {
          input: {
            order_id: 'ord-1',
            amount: 99,
            payment_method: 'card',
          },
        },
      })
      expect(paymentsResponse.statusCode).toBe(200)
      expect(projectService.testPaymentsConnector).toHaveBeenCalledWith({
        order_id: 'ord-1',
        amount: 99,
        payment_method: 'card',
      })

      const logsResponse = await server.inject({
        method: 'GET',
        url: '/api/services/store-runtime/logs?tail=40',
      })
      expect(logsResponse.statusCode).toBe(200)
      expect(supervisor.serviceLogs).toHaveBeenCalledWith('store-runtime', 40)
    } finally {
      await server.close()
    }
  })
})
