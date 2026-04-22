import Fastify, { type FastifyInstance } from 'fastify'
import { createBus, type IEventBus } from 'fitalyagents'
import { loadStoreConfig } from '../../config/load-store-config.js'
import { CustomerDisplayStateStore, type CustomerDisplayState } from './customer-display-state.js'
import { renderCustomerDisplayHtml } from './customer-display-page.js'

const DEFAULT_CUSTOMER_DISPLAY_HOST = '0.0.0.0'
const DEFAULT_CUSTOMER_DISPLAY_PORT = 3020
const CUSTOMER_DISPLAY_CHANNELS = [
  'bus:DRAFT_CREATED',
  'bus:DRAFT_CONFIRMED',
  'bus:DRAFT_CANCELLED',
  'bus:TOOL_RESULT',
  'bus:UI_UPDATE',
  'bus:ORDER_QUEUED_NO_APPROVER',
  'bus:APPROVAL_RESOLVED',
  'bus:ORDER_APPROVAL_TIMEOUT',
  'bus:AVATAR_SPEAK',
] as const

interface CustomerDisplayClient {
  send(chunk: string): void
}

export class CustomerDisplayEventStreamHub {
  private readonly clients = new Set<CustomerDisplayClient>()
  private lastState: CustomerDisplayState | null = null

  subscribe(client: CustomerDisplayClient): () => void {
    this.clients.add(client)
    client.send('retry: 3000\n\n')

    if (this.lastState) {
      client.send(formatSseEvent('customer_display_state', this.lastState))
    }

    return () => {
      this.clients.delete(client)
    }
  }

  publishState(state: CustomerDisplayState): void {
    this.lastState = state
    const payload = formatSseEvent('customer_display_state', state)
    for (const client of this.clients) {
      client.send(payload)
    }
  }

  getClientCount(): number {
    return this.clients.size
  }

  getLastState(): CustomerDisplayState | null {
    return this.lastState
  }
}

export function buildCustomerDisplayServer(deps: {
  hub: CustomerDisplayEventStreamHub
  storeId: string
  displayMode: 'order' | 'full'
  displayEnabled: boolean
  getState(): CustomerDisplayState
}): FastifyInstance {
  const server = Fastify({ logger: false })

  server.get('/', async (_request, reply) => {
    return reply.type('text/html; charset=utf-8').send(
      renderCustomerDisplayHtml({
        storeId: deps.storeId,
        mode: deps.displayMode,
      }),
    )
  })

  server.get('/health', async () => ({
    status: 'ok',
    store_id: deps.storeId,
    mode: deps.displayMode,
    enabled: deps.displayEnabled,
    subscribers: deps.hub.getClientCount(),
    has_state: deps.hub.getLastState() != null,
  }))

  server.get('/state', async () => deps.getState())

  server.get('/events', async (request, reply) => {
    reply.hijack()

    const response = reply.raw
    response.statusCode = 200
    response.setHeader('Content-Type', 'text/event-stream; charset=utf-8')
    response.setHeader('Cache-Control', 'no-cache, no-transform')
    response.setHeader('Connection', 'keep-alive')
    response.flushHeaders?.()

    const unsubscribe = deps.hub.subscribe({
      send(chunk) {
        response.write(chunk)
      },
    })

    const keepAlive = setInterval(() => {
      response.write(': ping\n\n')
    }, 15_000)

    request.raw.on('close', () => {
      clearInterval(keepAlive)
      unsubscribe()
      response.end()
    })
  })

  return server
}

export async function startCustomerDisplayService(deps: {
  configPath: string
  bus?: IEventBus
  host?: string
  port?: number
}): Promise<{
  hub: CustomerDisplayEventStreamHub
  stateStore: CustomerDisplayStateStore
  server: FastifyInstance
  shutdown(): Promise<void>
}> {
  const config = await loadStoreConfig(deps.configPath)

  if (!deps.bus && config.providers.bus.driver !== 'redis') {
    throw new Error('Customer display requires providers.bus.driver="redis"')
  }

  const bus =
    deps.bus ??
    (await createBus({
      redisUrl: config.providers.bus.driver === 'redis' ? config.providers.bus.url : undefined,
    }))

  const hub = new CustomerDisplayEventStreamHub()
  const stateStore = new CustomerDisplayStateStore(
    config.store.store_id,
    config.retail.customer_display_mode,
  )

  const unsubscribes = CUSTOMER_DISPLAY_CHANNELS.map((channel) =>
    bus.subscribe(channel, (payload) => {
      const state = stateStore.apply(channel, payload)
      hub.publishState(state)
    }),
  )

  hub.publishState(stateStore.getState())

  const server = buildCustomerDisplayServer({
    hub,
    storeId: config.store.store_id,
    displayMode: config.retail.customer_display_mode,
    displayEnabled: config.retail.customer_display_enabled,
    getState: () => stateStore.getState(),
  })

  await server.listen({
    host: deps.host ?? process.env.CUSTOMER_DISPLAY_HOST ?? DEFAULT_CUSTOMER_DISPLAY_HOST,
    port: deps.port ?? readPort(process.env.CUSTOMER_DISPLAY_PORT, DEFAULT_CUSTOMER_DISPLAY_PORT),
  })

  let closed = false

  return {
    hub,
    stateStore,
    server,
    async shutdown() {
      if (closed) {
        return
      }
      closed = true

      for (const unsubscribe of unsubscribes) {
        unsubscribe()
      }
      await server.close().catch(() => {})

      if (!deps.bus && 'disconnect' in bus && typeof bus.disconnect === 'function') {
        await bus.disconnect().catch(() => {})
      }
    },
  }
}

function formatSseEvent(event: string, payload: unknown): string {
  return `event: ${event}\ndata: ${JSON.stringify(payload)}\n\n`
}

function readPort(value: string | undefined, fallback: number): number {
  const parsed = value ? Number(value) : NaN
  return Number.isFinite(parsed) && parsed > 0 ? parsed : fallback
}
