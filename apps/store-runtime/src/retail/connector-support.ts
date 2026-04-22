import type { StoreConfig } from '../config/schema.js'

const SUPPORTED_RETAIL_CONNECTOR_DRIVERS = {
  products: ['mock', 'rest', 'sqlite'],
  inventory: ['mock', 'rest', 'sqlite'],
  customers: ['mock', 'rest', 'sqlite'],
  orders: ['mock', 'rest', 'sqlite'],
  payments: ['mock'],
  receipts: ['mock'],
} as const satisfies Record<keyof StoreConfig['connectors'], readonly string[]>

export function assertSupportedRetailConnectorDrivers(connectors: StoreConfig['connectors']): void {
  const issues = Object.entries(SUPPORTED_RETAIL_CONNECTOR_DRIVERS)
    .map(([kind, supportedDrivers]) => {
      const driver = connectors[kind as keyof StoreConfig['connectors']].driver
      if ((supportedDrivers as readonly string[]).includes(driver)) {
        return null
      }

      return `- connectors.${kind}.driver: driver "${driver}" no está soportado por el runtime actual. Soportados: ${supportedDrivers.join(', ')}`
    })
    .filter((issue) => issue !== null)

  if (issues.length === 0) {
    return
  }

  throw new Error(`Invalid store config:\n${issues.join('\n')}`)
}
