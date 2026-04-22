import path from 'node:path'
import { fileURLToPath } from 'node:url'
import { describe, expect, it } from 'vitest'
import { loadStoreConfig } from './load-store-config.js'
import {
  cleanupTempDir,
  createBaseConfig,
  createTempDir,
  writeJsonFile,
} from '../../test/helpers.js'

describe('loadStoreConfig', () => {
  it('loads config and resolves sqlite path relative to the config file', async () => {
    const dir = await createTempDir()

    try {
      const filePath = path.join(dir, 'store.config.json')
      await writeJsonFile(filePath, createBaseConfig())

      const config = await loadStoreConfig(filePath)

      expect(config.store.store_id).toBe('store-test')
      expect(config.storage.sqlite_path).toBe(path.join(dir, 'data/store.db'))
      expect(config.retail.service_mode).toBe('assisted-retail')
      expect(config.connectors.products.driver).toBe('mock')
      expect(config.devices.receipt_printer.driver).toBe('mock')
      expect(config.policies.allowed_payment_methods).toEqual(['card', 'cash'])
      expect(config.policies.role_approval_defaults).toEqual({})
    } finally {
      await cleanupTempDir(dir)
    }
  })

  it('resolves capture pipe paths relative to the config file', async () => {
    const dir = await createTempDir()

    try {
      const filePath = path.join(dir, 'store.config.json')
      await writeJsonFile(filePath, {
        ...createBaseConfig(),
        capture: {
          driver: 'voice-events',
          input: 'pipe',
          pipe_path: './run/voice.ndjson',
          format: 'ndjson',
        },
      })

      const config = await loadStoreConfig(filePath)

      expect(config.capture).toEqual({
        driver: 'voice-events',
        input: 'pipe',
        pipe_path: path.join(dir, 'run/voice.ndjson'),
        format: 'ndjson',
      })
    } finally {
      await cleanupTempDir(dir)
    }
  })

  it('resolves sqlite connector paths relative to the config file', async () => {
    const dir = await createTempDir()

    try {
      const filePath = path.join(dir, 'store.config.json')
      await writeJsonFile(filePath, {
        ...createBaseConfig(),
        connectors: {
          ...createBaseConfig().connectors,
          products: {
            driver: 'sqlite',
            database: './catalog/products.db',
            headers: {},
            health_timeout_ms: 3000,
            retry_policy: { max_attempts: 3, backoff_ms: 250 },
            options: {},
          },
          inventory: {
            driver: 'sqlite',
            connection_string: './catalog/products.db',
            headers: {},
            health_timeout_ms: 3000,
            retry_policy: { max_attempts: 3, backoff_ms: 250 },
            options: {},
          },
        },
      })

      const config = await loadStoreConfig(filePath)

      expect(config.connectors.products).toMatchObject({
        driver: 'sqlite',
        database: path.join(dir, 'catalog/products.db'),
      })
      expect(config.connectors.inventory).toMatchObject({
        driver: 'sqlite',
        connection_string: path.join(dir, 'catalog/products.db'),
      })
    } finally {
      await cleanupTempDir(dir)
    }
  })

  it('throws a detailed validation error for invalid configs', async () => {
    const dir = await createTempDir()

    try {
      const filePath = path.join(dir, 'broken.config.json')
      await writeJsonFile(filePath, {
        ...createBaseConfig(),
        store: {
          store_id: '',
          name: '',
        },
      })

      await expect(loadStoreConfig(filePath)).rejects.toThrow(/Invalid store config/)
      await expect(loadStoreConfig(filePath)).rejects.toThrow(/store.store_id/)
    } finally {
      await cleanupTempDir(dir)
    }
  })

  it('rejects connector drivers that the runtime does not implement yet', async () => {
    const dir = await createTempDir()

    try {
      const filePath = path.join(dir, 'unsupported-driver.config.json')
      await writeJsonFile(filePath, {
        ...createBaseConfig(),
        connectors: {
          ...createBaseConfig().connectors,
          payments: {
            driver: 'rest',
            url: 'https://api.example.test/payments',
            headers: {},
            health_timeout_ms: 3000,
            retry_policy: { max_attempts: 3, backoff_ms: 250 },
            options: {},
          },
        },
      })

      await expect(loadStoreConfig(filePath)).rejects.toThrow(/Invalid store config/)
      await expect(loadStoreConfig(filePath)).rejects.toThrow(/connectors\.payments\.driver/)
    } finally {
      await cleanupTempDir(dir)
    }
  })

  it('loads the committed retail config examples', async () => {
    const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../..')

    await expect(loadStoreConfig(path.join(root, 'store.config.json'))).resolves.toMatchObject({
      store: {
        store_id: 'store-001',
      },
      retail: {
        service_mode: 'assisted-retail',
      },
    })

    await expect(
      loadStoreConfig(path.join(root, 'store.config.redis.json')),
    ).resolves.toMatchObject({
      providers: {
        bus: {
          driver: 'redis',
        },
      },
      retail: {
        customer_display_enabled: true,
      },
    })

    await expect(
      loadStoreConfig(path.join(root, 'store.config.example.json')),
    ).resolves.toMatchObject({
      devices: {
        customer_display: {
          driver: 'web',
        },
      },
    })
  })

  it('normalizes employee approval limits from retail policy defaults', async () => {
    const dir = await createTempDir()

    try {
      const filePath = path.join(dir, 'store.config.json')
      await writeJsonFile(filePath, {
        ...createBaseConfig(),
        employees: [
          {
            id: 'cash-1',
            name: 'Caja',
            role: 'cashier',
            approval_limits: {
              payment_max: 900,
            },
          },
          {
            id: 'mgr-1',
            name: 'Gerencia',
            role: 'manager',
            approval_limits: {},
          },
        ],
        policies: {
          ...createBaseConfig().policies,
          discount_max_pct: 12,
          refund_max: 220,
          role_approval_defaults: {
            cashier: {
              refund_max: 30,
            },
          },
        },
      })

      const config = await loadStoreConfig(filePath)

      expect(config.employees[0]?.approval_limits).toMatchObject({
        payment_max: 900,
        refund_max: 30,
      })
      expect(config.employees[1]?.approval_limits).toMatchObject({
        refund_max: 220,
        discount_max_pct: 12,
        can_override_price: true,
      })
    } finally {
      await cleanupTempDir(dir)
    }
  })
})
