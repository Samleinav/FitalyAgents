import { describe, expect, it, vi } from 'vitest'
import { InMemoryBus, InMemoryPresenceManager, InMemorySessionManager } from 'fitalyagents'
import { buildHttpServer } from './server.js'
import {
  ApprovalRepository,
  EmployeeRepository,
  SessionRepository,
} from '../storage/repositories/index.js'
import {
  cleanupTempDir,
  closeTestDb,
  createBaseConfig,
  createTempDbPath,
  createTempDir,
  ensureDb,
} from '../../test/helpers.js'

describe('HTTP server', () => {
  it('returns health without requiring auth', async () => {
    const { server, dbPath, dir } = await createServerHarness()

    try {
      const response = await server.inject({
        method: 'GET',
        url: '/health',
      })

      expect(response.statusCode).toBe(200)
      expect(response.json()).toMatchObject({
        status: 'ok',
        store_id: 'store-test',
      })
    } finally {
      await server.close()
      closeTestDb(dbPath)
      await cleanupTempDir(dir)
    }
  })

  it('protects admin endpoints when the secret is missing', async () => {
    vi.unstubAllEnvs()
    const { server, dbPath, dir } = await createServerHarness()

    try {
      const response = await server.inject({
        method: 'POST',
        url: '/presence/checkin',
        payload: { human_id: 'mgr-1', role: 'manager' },
      })

      expect(response.statusCode).toBe(503)
      expect(response.json().error).toMatch(/STORE_ADMIN_SECRET/)
    } finally {
      await server.close()
      closeTestDb(dbPath)
      await cleanupTempDir(dir)
      vi.unstubAllEnvs()
    }
  })

  it('accepts authorized presence checkins and updates presence state', async () => {
    vi.stubEnv('STORE_ADMIN_SECRET', 'secret-123')
    const { server, dbPath, dir, presenceManager } = await createServerHarness()
    presenceManager.start()

    try {
      const response = await server.inject({
        method: 'POST',
        url: '/presence/checkin',
        headers: {
          authorization: 'Bearer secret-123',
        },
        payload: {
          human_id: 'mgr-1',
          role: 'manager',
          name: 'Manager One',
        },
      })

      expect(response.statusCode).toBe(200)
      expect(presenceManager.getStatus('mgr-1')).toBe('available')
    } finally {
      await server.close()
      closeTestDb(dbPath)
      await cleanupTempDir(dir)
      vi.unstubAllEnvs()
    }
  })
})

async function createServerHarness() {
  const dir = await createTempDir()
  const dbPath = createTempDbPath(dir)
  const db = ensureDb(dbPath)
  const bus = new InMemoryBus()
  const presenceManager = new InMemoryPresenceManager({ bus })
  const sessionManager = new InMemorySessionManager()

  const server = buildHttpServer({
    config: {
      ...createBaseConfig(),
      storage: { sqlite_path: dbPath },
    },
    bus,
    presenceManager,
    sessionManager,
    repositories: {
      approvals: new ApprovalRepository(db),
      employees: new EmployeeRepository(db),
      sessions: new SessionRepository(db),
    },
    readiness: {
      isReady: () => true,
    },
    agentCount: 3,
  })

  return {
    server,
    dbPath,
    dir,
    presenceManager,
  }
}
