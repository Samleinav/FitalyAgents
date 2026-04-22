import Fastify, { type FastifyInstance } from 'fastify'
import type { DeployCenterConfig } from '../config/schema.js'
import type { DeploySupervisor } from '../control/docker-compose-driver.js'
import type { StoreProjectApi } from '../services/store-project-service.js'
import { renderDeployCenterHtml } from '../ui/page.js'

export function buildDeployCenterServer(deps: {
  config: DeployCenterConfig
  projectService: StoreProjectApi
  supervisor: DeploySupervisor
}): FastifyInstance {
  const server = Fastify({ logger: false })

  server.get('/', async (_request, reply) => {
    return reply.type('text/html; charset=utf-8').send(
      renderDeployCenterHtml({
        projectName: deps.config.project.name,
      }),
    )
  })

  server.get('/health', async () => ({
    status: 'ok',
    project: deps.config.project.name,
  }))

  server.get('/api/state', async () => deps.projectService.getDashboardState())
  server.get('/api/store-config', async () => deps.projectService.readStoreConfigRaw())
  server.get('/api/env', async () => deps.projectService.readEnvState())

  server.patch('/api/store-config', async (request, reply) => {
    try {
      const patch = request.body as Record<string, unknown>
      const config = await deps.projectService.patchStoreConfig(patch)
      return {
        ok: true,
        store_id: config.store.store_id,
      }
    } catch (error) {
      reply.code(400)
      return {
        ok: false,
        error: error instanceof Error ? error.message : String(error),
      }
    }
  })

  server.patch('/api/env', async (request, reply) => {
    try {
      const body = (request.body as { values?: Record<string, string> } | undefined) ?? {}
      return {
        ok: true,
        ...(await deps.projectService.patchEnv(body.values ?? {})),
      }
    } catch (error) {
      reply.code(400)
      return {
        ok: false,
        error: error instanceof Error ? error.message : String(error),
      }
    }
  })

  server.post('/api/connectors/products/test', async (request, reply) => {
    try {
      const body = (request.body as { query?: string } | undefined) ?? {}
      const query = body.query?.trim() || 'Nike'
      return {
        ok: true,
        ...(await deps.projectService.testProductsConnector(query)),
      }
    } catch (error) {
      reply.code(400)
      return {
        ok: false,
        error: error instanceof Error ? error.message : String(error),
      }
    }
  })

  server.post('/api/connectors/customers/test', async (request, reply) => {
    try {
      const body = (request.body as { action?: unknown; input?: unknown } | undefined) ?? {}
      const action = parseCustomerAction(body.action)
      return {
        ok: true,
        ...(await deps.projectService.testCustomersConnector(action, readBodyInput(body.input))),
      }
    } catch (error) {
      reply.code(400)
      return {
        ok: false,
        error: error instanceof Error ? error.message : String(error),
      }
    }
  })

  server.post('/api/connectors/orders/test', async (request, reply) => {
    try {
      const body = (request.body as { action?: unknown; input?: unknown } | undefined) ?? {}
      const action = parseOrderAction(body.action)
      return {
        ok: true,
        ...(await deps.projectService.testOrdersConnector(action, readBodyInput(body.input))),
      }
    } catch (error) {
      reply.code(400)
      return {
        ok: false,
        error: error instanceof Error ? error.message : String(error),
      }
    }
  })

  server.post('/api/connectors/payments/test', async (request, reply) => {
    try {
      const body = (request.body as { input?: unknown } | undefined) ?? {}
      return {
        ok: true,
        ...(await deps.projectService.testPaymentsConnector(readBodyInput(body.input))),
      }
    } catch (error) {
      reply.code(400)
      return {
        ok: false,
        error: error instanceof Error ? error.message : String(error),
      }
    }
  })

  server.post('/api/deploy/up', async (request, reply) => {
    try {
      return await deps.supervisor.deployAll()
    } catch (error) {
      reply.code(500)
      return {
        ok: false,
        error: error instanceof Error ? error.message : String(error),
      }
    }
  })

  server.post('/api/deploy/down', async (request, reply) => {
    try {
      return await deps.supervisor.stopAll()
    } catch (error) {
      reply.code(500)
      return {
        ok: false,
        error: error instanceof Error ? error.message : String(error),
      }
    }
  })

  server.post('/api/services/:serviceId/restart', async (request, reply) => {
    try {
      const params = request.params as { serviceId: string }
      return await deps.supervisor.restartService(params.serviceId)
    } catch (error) {
      reply.code(400)
      return {
        ok: false,
        error: error instanceof Error ? error.message : String(error),
      }
    }
  })

  server.post('/api/services/:serviceId/start', async (request, reply) => {
    try {
      const params = request.params as { serviceId: string }
      return await deps.supervisor.startService(params.serviceId)
    } catch (error) {
      reply.code(400)
      return {
        ok: false,
        error: error instanceof Error ? error.message : String(error),
      }
    }
  })

  server.post('/api/services/:serviceId/stop', async (request, reply) => {
    try {
      const params = request.params as { serviceId: string }
      return await deps.supervisor.stopService(params.serviceId)
    } catch (error) {
      reply.code(400)
      return {
        ok: false,
        error: error instanceof Error ? error.message : String(error),
      }
    }
  })

  server.get('/api/services/:serviceId/logs', async (request, reply) => {
    try {
      const params = request.params as { serviceId: string }
      const query = request.query as { tail?: string }
      const parsedTail = query.tail ? Number(query.tail) : undefined
      const tail =
        parsedTail != null && Number.isInteger(parsedTail) && parsedTail > 0
          ? parsedTail
          : undefined
      return await deps.supervisor.serviceLogs(params.serviceId, tail)
    } catch (error) {
      reply.code(400)
      return {
        ok: false,
        error: error instanceof Error ? error.message : String(error),
      }
    }
  })

  return server
}

function parseCustomerAction(value: unknown): 'lookup' | 'register' {
  if (value === 'lookup' || value === 'register') {
    return value
  }

  throw new Error('customers test action must be "lookup" or "register"')
}

function parseOrderAction(value: unknown): 'create' | 'update' | 'confirm' {
  if (value === 'create' || value === 'update' || value === 'confirm') {
    return value
  }

  throw new Error('orders test action must be "create", "update" or "confirm"')
}

function readBodyInput(value: unknown): Record<string, unknown> {
  return value && typeof value === 'object' && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : {}
}
