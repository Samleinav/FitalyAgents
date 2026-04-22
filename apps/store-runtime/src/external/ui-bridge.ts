import dotenv from 'dotenv'
import Fastify, { type FastifyInstance } from 'fastify'
import { createBus, type IEventBus } from 'fitalyagents'
import { isEntrypoint } from '../cli/is-entrypoint.js'
import { resolveConfigPath } from '../cli/resolve-config-path.js'
import { loadStoreConfig } from '../config/load-store-config.js'
import { renderUiDashboardHtml } from './ui-dashboard-page.js'
import { StoreDashboardStateStore, type StoreDashboardState } from './ui-dashboard-state.js'

const DEFAULT_UI_BRIDGE_HOST = '0.0.0.0'
const DEFAULT_UI_BRIDGE_PORT = 3010
const UI_BRIDGE_CHANNELS = [
  'bus:UI_UPDATE',
  'bus:TARGET_GROUP_CHANGED',
  'bus:SPEECH_FINAL',
  'bus:RESPONSE_START',
  'bus:AVATAR_SPEAK',
  'bus:RESPONSE_END',
  'bus:ORDER_QUEUED_NO_APPROVER',
  'bus:APPROVAL_RESOLVED',
  'bus:ORDER_APPROVAL_TIMEOUT',
] as const

interface UIEventClient {
  send(chunk: string): void
}

export class UIEventStreamHub {
  private readonly clients = new Set<UIEventClient>()
  private lastUpdate: unknown = null
  private lastState: StoreDashboardState | null = null

  subscribe(client: UIEventClient): () => void {
    this.clients.add(client)
    client.send('retry: 3000\n\n')

    if (this.lastState != null) {
      client.send(formatSseEvent('dashboard_state', this.lastState))
    } else if (this.lastUpdate != null) {
      client.send(formatSseEvent('ui_update', this.lastUpdate))
    }

    return () => {
      this.clients.delete(client)
    }
  }

  publish(update: unknown): void {
    this.lastUpdate = update

    const payload = formatSseEvent('ui_update', update)
    for (const client of this.clients) {
      client.send(payload)
    }
  }

  publishState(state: StoreDashboardState): void {
    this.lastState = state

    const payload = formatSseEvent('dashboard_state', state)
    for (const client of this.clients) {
      client.send(payload)
    }
  }

  getClientCount(): number {
    return this.clients.size
  }

  getLastUpdate(): unknown {
    return this.lastUpdate
  }

  getLastState(): StoreDashboardState | null {
    return this.lastState
  }
}

export function buildUiBridgeServer(deps: {
  hub: UIEventStreamHub
  storeId: string
  getState(): StoreDashboardState
}): FastifyInstance {
  const server = Fastify({ logger: false })

  server.get('/', async (_request, reply) => {
    return reply.type('text/html; charset=utf-8').send(
      renderUiDashboardHtml({
        storeId: deps.storeId,
      }),
    )
  })

  server.get('/health', async () => ({
    status: 'ok',
    store_id: deps.storeId,
    subscribers: deps.hub.getClientCount(),
    has_last_update: deps.hub.getLastUpdate() != null,
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

export async function startUiBridgeService(deps: {
  configPath: string
  bus?: IEventBus
  host?: string
  port?: number
}): Promise<{
  hub: UIEventStreamHub
  stateStore: StoreDashboardStateStore
  server: FastifyInstance
  shutdown(): Promise<void>
}> {
  const config = await loadStoreConfig(deps.configPath)

  if (!deps.bus && config.providers.bus.driver !== 'redis') {
    throw new Error('External UI bridge requires providers.bus.driver="redis"')
  }

  const bus =
    deps.bus ??
    (await createBus({
      redisUrl: config.providers.bus.driver === 'redis' ? config.providers.bus.url : undefined,
    }))

  const hub = new UIEventStreamHub()
  const stateStore = new StoreDashboardStateStore(config.store.store_id)
  const unsubscribes = UI_BRIDGE_CHANNELS.map((channel) =>
    bus.subscribe(channel, (payload) => {
      if (channel === 'bus:UI_UPDATE') {
        hub.publish(payload)
      }
      const state = stateStore.apply(channel, payload)
      hub.publishState(state)
    }),
  )

  const server = buildUiBridgeServer({
    hub,
    storeId: config.store.store_id,
    getState: () => stateStore.getState(),
  })

  await server.listen({
    host: deps.host ?? process.env.UI_BRIDGE_HOST ?? DEFAULT_UI_BRIDGE_HOST,
    port: deps.port ?? readPort(process.env.UI_BRIDGE_PORT, DEFAULT_UI_BRIDGE_PORT),
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

async function main(): Promise<void> {
  dotenv.config()

  const configPath = resolveConfigPath(process.argv.slice(2))
  const service = await startUiBridgeService({ configPath })

  const shutdown = async () => {
    await service.shutdown()
  }

  process.on('SIGTERM', () => {
    void shutdown()
  })
  process.on('SIGINT', () => {
    void shutdown()
  })
}

function formatSseEvent(event: string, payload: unknown): string {
  const serialized = JSON.stringify(payload)
  return `event: ${event}\ndata: ${serialized}\n\n`
}

function readPort(value: string | undefined, fallback: number): number {
  const parsed = value ? Number(value) : NaN
  return Number.isFinite(parsed) && parsed > 0 ? parsed : fallback
}

if (isEntrypoint(import.meta.url)) {
  main().catch((error) => {
    console.error(
      '[store-runtime/ui-bridge] Boot failed:',
      error instanceof Error ? error.message : error,
    )
    process.exitCode = 1
  })
}
