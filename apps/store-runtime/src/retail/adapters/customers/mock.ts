import type { RetailAdapterCatalogDeps } from '../catalog.js'
import type {
  AdapterHealth,
  CustomerAdapter,
  CustomerLookupResult,
  CustomerRegisterResult,
} from '../catalog.js'

export function createMockCustomerAdapter(deps: RetailAdapterCatalogDeps): CustomerAdapter {
  return {
    driver: 'mock',
    capabilities() {
      return ['lookup', 'register']
    },
    async health(): Promise<AdapterHealth> {
      return {
        ok: true,
        driver: 'mock',
        details: {
          connector: 'customers',
          mode: 'repository-seeded',
        },
      }
    },
    async execute(action, input, _context) {
      ensureMockCustomers(deps)

      if (action === 'register') {
        const registerInput = input as {
          name: string
          locale?: string
          metadata?: Record<string, unknown>
        }
        const now = Date.now()
        const customerId = `cust_${now}`
        deps.repositories.customers.upsert({
          id: customerId,
          name: registerInput.name.trim(),
          locale: registerInput.locale?.trim() || deps.config.store.locale,
          metadata: registerInput.metadata ?? {},
        })

        const result: CustomerRegisterResult = {
          customer_id: customerId,
          text: `Registré a ${registerInput.name.trim()} correctamente.`,
        }
        return result
      }

      const lookupInput = input as {
        customer_id?: string
        query?: string
        limit?: number
      }
      const byId =
        lookupInput.customer_id?.trim() &&
        deps.repositories.customers.findById(lookupInput.customer_id.trim())
      const matches = byId
        ? [byId]
        : deps.repositories.customers
            .list()
            .filter((customer) => {
              if (!lookupInput.query?.trim()) {
                return true
              }

              const query = lookupInput.query.toLowerCase()
              return (
                customer.name.toLowerCase().includes(query) ||
                customer.id.toLowerCase().includes(query)
              )
            })
            .slice(0, clampLimit(lookupInput.limit))

      const result: CustomerLookupResult = {
        customers: matches.map((customer) => ({
          id: customer.id,
          name: customer.name,
          locale: customer.locale,
          metadata: customer.metadata,
        })),
        text:
          matches.length > 0
            ? `Encontré ${matches.length} cliente(s) coincidente(s).`
            : 'No encontré clientes con esos datos.',
      }

      return result
    },
  }
}

function ensureMockCustomers(deps: RetailAdapterCatalogDeps): void {
  const customers = deps.repositories.customers.list()
  if (customers.length > 0) {
    return
  }

  deps.repositories.customers.upsert({
    id: 'cust_demo_001',
    name: 'Ana Gomez',
    locale: deps.config.store.locale,
    metadata: {
      loyalty_tier: 'gold',
      visits: 12,
    },
  })
  deps.repositories.customers.upsert({
    id: 'cust_demo_002',
    name: 'Luis Rivera',
    locale: deps.config.store.locale,
    metadata: {
      loyalty_tier: 'silver',
      visits: 4,
    },
  })
}

function clampLimit(value: number | undefined): number {
  if (!Number.isInteger(value) || !value) {
    return 5
  }

  return Math.max(1, Math.min(20, value))
}
