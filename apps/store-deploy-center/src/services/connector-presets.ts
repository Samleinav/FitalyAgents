export interface ConnectorPresetDefinition {
  id: string
  label: string
  summary: string
  description: string
  badges: string[]
  patch: Record<string, unknown>
}

export function getConnectorPresets(): ConnectorPresetDefinition[] {
  return [
    {
      id: 'demo-local-mock',
      label: 'Demo Local Mock',
      summary: 'Todo el flujo retail queda en mock para demos rápidas y smoke tests.',
      description:
        'Útil para validar voz, UI, avatar, customer display y herramientas retail sin depender de APIs ni bases externas.',
      badges: ['Demo', 'Sin backend', 'Listo en minutos'],
      patch: {
        connectors: {
          products: buildMockConnector(),
          inventory: buildMockConnector(),
          customers: buildMockConnector(),
          orders: buildMockConnector(),
          payments: buildMockConnector(),
          receipts: buildMockConnector(),
        },
        devices: {
          payment_terminal: buildMockDevice(),
          receipt_printer: buildMockDevice(),
          cash_drawer: buildMockDevice(),
          customer_display: buildMockDevice(),
        },
      },
    },
    {
      id: 'sqlite-local-retail',
      label: 'SQLite Local Retail',
      summary: 'Productos, clientes y órdenes quedan en SQLite local; payments sigue en mock.',
      description:
        'Pensado para una tienda o laboratorio en una sola PC donde quieres datos persistentes sin montar servicios externos.',
      badges: ['Single machine', 'Persistente', 'Fácil de mover'],
      patch: {
        connectors: {
          products: buildSqliteConnector('./data/retail-catalog.db'),
          inventory: buildSqliteConnector('./data/retail-catalog.db'),
          customers: buildSqliteConnector('./data/retail-customers.db'),
          orders: buildSqliteConnector('./data/retail-orders.db'),
          payments: buildMockConnector(),
          receipts: buildMockConnector(),
        },
        devices: {
          payment_terminal: buildMockDevice(),
          receipt_printer: buildMockDevice(),
          cash_drawer: buildMockDevice(),
          customer_display: buildMockDevice(),
        },
      },
    },
    {
      id: 'rest-backoffice',
      label: 'REST Backoffice',
      summary:
        'Conecta catálogo, inventario, clientes y órdenes a APIs externas; payments sigue en mock.',
      description:
        'Encaja cuando ya existe ERP, ecommerce o middleware y el store-runtime solo debe consumir endpoints REST normalizados.',
      badges: ['ERP / API', 'Integración', 'Producción inicial'],
      patch: {
        connectors: {
          products: buildRestConnector('https://api.store.local/products'),
          inventory: buildRestConnector('https://api.store.local/inventory'),
          customers: buildRestConnector('https://api.store.local/customers'),
          orders: buildRestConnector('https://api.store.local/orders'),
          payments: buildMockConnector(),
          receipts: buildMockConnector(),
        },
        devices: {
          payment_terminal: buildMockDevice(),
          receipt_printer: buildMockDevice(),
          cash_drawer: buildMockDevice(),
          customer_display: buildMockDevice(),
        },
      },
    },
  ]
}

function buildMockConnector(): Record<string, unknown> {
  return {
    driver: 'mock',
    url: null,
    database: null,
    connection_string: null,
    headers: {},
    health_timeout_ms: 3000,
    retry_policy: {
      max_attempts: 3,
      backoff_ms: 250,
    },
    options: {},
  }
}

function buildSqliteConnector(database: string): Record<string, unknown> {
  return {
    driver: 'sqlite',
    url: null,
    database,
    connection_string: database,
    headers: {},
    health_timeout_ms: 3000,
    retry_policy: {
      max_attempts: 3,
      backoff_ms: 250,
    },
    options: {},
  }
}

function buildRestConnector(url: string): Record<string, unknown> {
  return {
    driver: 'rest',
    url,
    database: null,
    connection_string: null,
    headers: {},
    health_timeout_ms: 3000,
    retry_policy: {
      max_attempts: 3,
      backoff_ms: 250,
    },
    options: {},
  }
}

function buildMockDevice(): Record<string, unknown> {
  return {
    driver: 'mock',
    timeout_ms: 2000,
    connection: {},
  }
}
