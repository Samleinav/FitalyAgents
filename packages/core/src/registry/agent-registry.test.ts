import { describe, it, expect, beforeEach, afterEach } from 'vitest'
import { InMemoryBus } from '../bus/in-memory-bus.js'
import { AgentRegistry } from './agent-registry.js'
import type { AgentManifest } from '../types/index.js'

// ── Helpers ───────────────────────────────────────────────────────────────────

function makeManifest(overrides: Partial<AgentManifest> & { agent_id: string }): AgentManifest {
  return {
    description: 'Test agent',
    version: '0.1.0',
    domain: 'customer_facing',
    scope: 'commerce',
    capabilities: ['ECHO'],
    context_mode: 'stateless',
    context_access: { read: ['*'], write: [], forbidden: [] },
    async_tools: [],
    input_channel: `queue:${overrides.agent_id}:inbox`,
    output_channel: `queue:${overrides.agent_id}:outbox`,
    priority: 5,
    max_concurrent: 3,
    timeout_ms: 5000,
    heartbeat_interval_ms: 3000,
    role: null,
    accepts_from: ['DISPATCHER'],
    requires_human_approval: false,
    ...overrides,
  }
}

// ── Tests ─────────────────────────────────────────────────────────────────────

describe('AgentRegistry', () => {
  let bus: InMemoryBus
  let registry: AgentRegistry

  beforeEach(() => {
    bus = new InMemoryBus()
    registry = new AgentRegistry(bus)
    registry.listen()
  })

  afterEach(async () => {
    registry.dispose()
    await bus.disconnect()
  })

  // ── Manual register/unregister ────────────────────────────────────────

  describe('register() / unregister()', () => {
    it('registers an agent and makes it retrievable', async () => {
      const manifest = makeManifest({ agent_id: 'agent_1' })
      registry.register(manifest)

      const found = await registry.get('agent_1')
      expect(found).toEqual(manifest)
      expect(registry.size).toBe(1)
    })

    it('unregisters an agent', async () => {
      registry.register(makeManifest({ agent_id: 'agent_1' }))
      registry.unregister('agent_1')

      const found = await registry.get('agent_1')
      expect(found).toBeNull()
      expect(registry.size).toBe(0)
    })

    it('returns null for unknown agent', async () => {
      expect(await registry.get('ghost')).toBeNull()
    })
  })

  // ── Bus event sync ────────────────────────────────────────────────────

  describe('bus event synchronization', () => {
    it('auto-registers when AGENT_REGISTERED is published', async () => {
      const manifest = makeManifest({ agent_id: 'bus_agent' })
      await bus.publish('bus:AGENT_REGISTERED', {
        event: 'AGENT_REGISTERED',
        ...manifest,
      })

      const found = await registry.get('bus_agent')
      expect(found).toMatchObject({ agent_id: 'bus_agent', domain: 'customer_facing' })
    })

    it('auto-removes when AGENT_DEREGISTERED is published', async () => {
      registry.register(makeManifest({ agent_id: 'bus_agent' }))

      await bus.publish('bus:AGENT_DEREGISTERED', {
        event: 'AGENT_DEREGISTERED',
        agent_id: 'bus_agent',
        timestamp: Date.now(),
      })

      expect(await registry.get('bus_agent')).toBeNull()
      expect(registry.size).toBe(0)
    })

    it('records heartbeat when HEARTBEAT is published', async () => {
      registry.register(makeManifest({ agent_id: 'hb_agent' }))

      await bus.publish('bus:HEARTBEAT', {
        event: 'HEARTBEAT',
        agent_id: 'hb_agent',
        status: 'idle',
        current_tasks: 0,
        max_tasks: 3,
        timestamp: Date.now(),
      })

      const hb = registry.getHeartbeat('hb_agent')
      expect(hb).not.toBeNull()
      expect(hb!.status).toBe('idle')
    })
  })

  // ── list() with filters ───────────────────────────────────────────────

  describe('list()', () => {
    beforeEach(() => {
      registry.register(
        makeManifest({
          agent_id: 'search_agent',
          domain: 'customer_facing',
          scope: 'commerce',
          capabilities: ['PRODUCT_SEARCH', 'PRICE_CHECK'],
        }),
      )
      registry.register(
        makeManifest({
          agent_id: 'ops_agent',
          domain: 'internal_ops',
          scope: 'warehouse',
          capabilities: ['INVENTORY'],
        }),
      )
      registry.register(
        makeManifest({
          agent_id: 'price_agent',
          domain: 'customer_facing',
          scope: 'commerce',
          capabilities: ['PRICE_CHECK'],
        }),
      )
    })

    it('returns all agents with no filter', async () => {
      const all = await registry.list()
      expect(all).toHaveLength(3)
    })

    it('filters by domain', async () => {
      const results = await registry.list({ domain: 'customer_facing' })
      expect(results).toHaveLength(2)
      expect(results.every((a) => a.domain === 'customer_facing')).toBe(true)
    })

    it('filters by scope', async () => {
      const results = await registry.list({ scope: 'commerce' })
      expect(results).toHaveLength(2)
      expect(results.every((a) => a.scope === 'commerce')).toBe(true)
    })

    it('filters by capabilities — all must be present', async () => {
      const results = await registry.list({ capabilities: ['PRODUCT_SEARCH', 'PRICE_CHECK'] })
      expect(results).toHaveLength(1)
      expect(results[0]!.agent_id).toBe('search_agent')
    })

    it('filters by single capability', async () => {
      const results = await registry.list({ capabilities: ['PRICE_CHECK'] })
      expect(results).toHaveLength(2)
      const ids = results.map((a) => a.agent_id)
      expect(ids).toContain('search_agent')
      expect(ids).toContain('price_agent')
    })

    it('filters by role', async () => {
      registry.register(makeManifest({ agent_id: 'dispatcher', role: 'DISPATCHER' }))
      const results = await registry.list({ role: 'DISPATCHER' })
      expect(results).toHaveLength(1)
      expect(results[0]!.agent_id).toBe('dispatcher')
    })

    it('combines multiple filters', async () => {
      const results = await registry.list({
        domain: 'customer_facing',
        capabilities: ['PRICE_CHECK'],
      })
      // Both search_agent and price_agent qualify
      expect(results).toHaveLength(2)
    })

    it('returns empty array when no agents match', async () => {
      const results = await registry.list({ scope: 'nonexistent' })
      expect(results).toHaveLength(0)
    })
  })

  // ── getStale() ────────────────────────────────────────────────────────

  describe('getStale()', () => {
    it('returns agent that never sent a heartbeat', async () => {
      registry.register(makeManifest({ agent_id: 'silent_agent' }))

      const stale = await registry.getStale(5000)
      expect(stale).toHaveLength(1)
      expect(stale[0]!.agent_id).toBe('silent_agent')
    })

    it('returns agent whose heartbeat is older than threshold', async () => {
      registry.register(makeManifest({ agent_id: 'old_agent' }))

      // Set a heartbeat from the "past"
      const oldTimestamp = Date.now() - 10_000
      registry['heartbeats'].set('old_agent', {
        status: 'idle',
        current_tasks: 0,
        last_seen_at: oldTimestamp,
      })

      const stale = await registry.getStale(5000) // 5s threshold
      expect(stale).toHaveLength(1)
      expect(stale[0]!.agent_id).toBe('old_agent')
    })

    it('does NOT return agent with fresh heartbeat', async () => {
      registry.register(makeManifest({ agent_id: 'fresh_agent' }))
      registry.updateHeartbeat('fresh_agent', 'idle')

      const stale = await registry.getStale(5000)
      expect(stale).toHaveLength(0)
    })

    it('mixes stale and fresh agents correctly', async () => {
      registry.register(makeManifest({ agent_id: 'stale' }))
      registry.register(makeManifest({ agent_id: 'fresh' }))

      // Only update heartbeat for fresh
      registry.updateHeartbeat('fresh', 'idle')

      const stale = await registry.getStale(5000)
      expect(stale).toHaveLength(1)
      expect(stale[0]!.agent_id).toBe('stale')
    })
  })

  // ── Load tracking ─────────────────────────────────────────────────────

  describe('load tracking', () => {
    beforeEach(() => {
      registry.register(makeManifest({ agent_id: 'worker' }))
    })

    it('starts at 0', async () => {
      expect(await registry.getCurrentLoad('worker')).toBe(0)
    })

    it('increments correctly', async () => {
      await registry.incrementLoad('worker')
      await registry.incrementLoad('worker')
      expect(await registry.getCurrentLoad('worker')).toBe(2)
    })

    it('decrements correctly', async () => {
      await registry.incrementLoad('worker')
      await registry.incrementLoad('worker')
      await registry.decrementLoad('worker')
      expect(await registry.getCurrentLoad('worker')).toBe(1)
    })

    it('does not go below 0', async () => {
      await registry.decrementLoad('worker')
      expect(await registry.getCurrentLoad('worker')).toBe(0)
    })

    it('returns 0 for unknown agent', async () => {
      expect(await registry.getCurrentLoad('ghost')).toBe(0)
    })

    it('clears load on unregister', async () => {
      await registry.incrementLoad('worker')
      registry.unregister('worker')
      expect(await registry.getCurrentLoad('worker')).toBe(0)
    })
  })
})
