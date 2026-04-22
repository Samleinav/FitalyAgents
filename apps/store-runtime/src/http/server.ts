import Fastify, { type FastifyInstance, type FastifyReply, type FastifyRequest } from 'fastify'
import type {
  IEventBus,
  InMemoryPresenceManager,
  InMemorySessionManager,
  HumanRole,
} from 'fitalyagents'
import type { StoreConfig } from '../config/schema.js'
import type {
  ApprovalRepository,
  EmployeeRepository,
  SessionRepository,
} from '../storage/repositories/index.js'
import { resolveApprovalLimitsForRole } from '../retail/staffing.js'

export async function startHttpServer(deps: {
  config: StoreConfig
  bus: IEventBus
  presenceManager: InMemoryPresenceManager
  sessionManager: InMemorySessionManager
  repositories: {
    approvals: ApprovalRepository
    employees: EmployeeRepository
    sessions: SessionRepository
  }
  readiness: { isReady(): boolean }
  agentCount: number
}): Promise<FastifyInstance> {
  const server = buildHttpServer(deps)
  await server.listen({
    port: deps.config.http.port,
    host: deps.config.http.host,
  })
  return server
}

export function buildHttpServer(deps: {
  config: StoreConfig
  bus: IEventBus
  presenceManager: InMemoryPresenceManager
  sessionManager: InMemorySessionManager
  repositories: {
    approvals: ApprovalRepository
    employees: EmployeeRepository
    sessions: SessionRepository
  }
  readiness: { isReady(): boolean }
  agentCount: number
}): FastifyInstance {
  const server = Fastify({
    logger: false,
  })

  const startedAt = Date.now()
  const adminSecret = process.env[deps.config.http.admin_secret_env] ?? ''
  const webhookSecret = process.env.WEBHOOK_AUTH_TOKEN ?? ''

  server.get('/health', async () => ({
    status: 'ok',
    store_id: deps.config.store.store_id,
    uptime_ms: Date.now() - startedAt,
    agent_count: deps.agentCount,
  }))

  server.get('/health/ready', async (_request, reply) => {
    if (deps.readiness.isReady()) {
      return { status: 'ready' }
    }

    reply.code(503)
    return { status: 'starting' }
  })

  server.post('/approvals/respond', async (request, reply) => {
    const auth = authorizeBearer(request, reply, webhookSecret, 'WEBHOOK_AUTH_TOKEN')
    if (!auth.ok) {
      return auth.payload
    }

    const body = request.body as {
      request_id?: string
      approved?: boolean
      approver_id?: string
      reason?: string
    }

    if (!body.request_id || typeof body.approved !== 'boolean' || !body.approver_id) {
      reply.code(400)
      return { ok: false, error: 'Invalid approval response payload' }
    }

    const approval = deps.repositories.approvals.findById(body.request_id)
    if (!approval) {
      reply.code(404)
      return { ok: false, error: 'Approval request not found' }
    }

    const payload = {
      request_id: body.request_id,
      approved: body.approved,
      approver_id: body.approver_id,
      reason: body.reason,
    }

    await deps.bus.publish('bus:APPROVAL_WEBHOOK_RESPONSE', payload)
    await deps.bus.publish('bus:APPROVAL_EXTERNAL_RESPONSE', payload)

    return { ok: true }
  })

  server.post('/presence/checkin', async (request, reply) => {
    const auth = authorizeBearer(request, reply, adminSecret, deps.config.http.admin_secret_env)
    if (!auth.ok) {
      return auth.payload
    }

    const body = request.body as {
      human_id?: string
      role?: HumanRole
      store_id?: string
      name?: string
    }

    if (!body.human_id) {
      reply.code(400)
      return { ok: false, error: 'human_id is required' }
    }

    const employee = deps.repositories.employees.findById(body.human_id)
    const role = body.role ?? (employee?.role as HumanRole | undefined)
    if (!role) {
      reply.code(400)
      return { ok: false, error: 'role is required when employee is unknown' }
    }

    await deps.bus.publish('bus:HUMAN_PRESENCE_CHANGED', {
      event: 'HUMAN_PRESENCE_CHANGED',
      human_id: body.human_id,
      name: body.name ?? employee?.name ?? body.human_id,
      role,
      status: 'available',
      store_id: body.store_id ?? deps.config.store.store_id,
      org_id: deps.config.store.store_id,
      approval_limits:
        employee?.approval_limits ?? resolveApprovalLimitsForRole(role, deps.config.policies),
      timestamp: Date.now(),
    })

    return { ok: true }
  })

  server.post('/presence/checkout', async (request, reply) => {
    const auth = authorizeBearer(request, reply, adminSecret, deps.config.http.admin_secret_env)
    if (!auth.ok) {
      return auth.payload
    }

    const body = request.body as { human_id?: string }
    if (!body.human_id) {
      reply.code(400)
      return { ok: false, error: 'human_id is required' }
    }

    const employee = deps.repositories.employees.findById(body.human_id)
    await deps.bus.publish('bus:HUMAN_PRESENCE_CHANGED', {
      event: 'HUMAN_PRESENCE_CHANGED',
      human_id: body.human_id,
      name: employee?.name ?? body.human_id,
      role: (employee?.role as HumanRole | undefined) ?? 'staff',
      status: 'offline',
      store_id: deps.config.store.store_id,
      org_id: deps.config.store.store_id,
      approval_limits:
        employee?.approval_limits ??
        resolveApprovalLimitsForRole(
          (employee?.role as HumanRole | undefined) ?? 'staff',
          deps.config.policies,
        ),
      timestamp: Date.now(),
    })

    return { ok: true }
  })

  server.get('/admin/sessions', async (request, reply) => {
    const auth = authorizeBearer(request, reply, adminSecret, deps.config.http.admin_secret_env)
    if (!auth.ok) {
      return auth.payload
    }

    const active = await deps.sessionManager.listActiveSessions()
    return {
      sessions: active,
      summaries: deps.repositories.sessions.list(50),
    }
  })

  return server
}

function authorizeBearer(
  request: FastifyRequest,
  reply: FastifyReply,
  secret: string,
  secretName: string,
): { ok: true } | { ok: false; payload: { ok: false; error: string } } {
  if (!secret) {
    reply.code(503)
    return {
      ok: false,
      payload: {
        ok: false,
        error: `Protected endpoint unavailable: missing ${secretName}`,
      },
    }
  }

  const header = request.headers.authorization
  if (header === `Bearer ${secret}`) {
    return { ok: true }
  }

  reply.code(401)
  return {
    ok: false,
    payload: {
      ok: false,
      error: 'Unauthorized',
    },
  }
}
