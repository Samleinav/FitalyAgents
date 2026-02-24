import { describe, it, expect, beforeEach, afterEach } from 'vitest'
import { CapabilityRouter } from './capability-router.js'
import { AgentRegistry } from '../registry/agent-registry.js'
import { InMemoryLockManager } from '../locks/in-memory-lock-manager.js'
import { InMemoryTaskQueue } from '../tasks/in-memory-task-queue.js'
import { InMemoryContextStore } from '../context/in-memory-context-store.js'
import { InMemoryBus } from '../bus/in-memory-bus.js'
import type { AgentManifest } from '../types/index.js'
import type { TaskInput } from '../tasks/types.js'

// ── Fixtures ────────────────────────────────────────────────────────────────

function makeManifest(overrides: Partial<AgentManifest> = {}): AgentManifest {
  return {
    agent_id: 'agent_search',
    display_name: 'Search Agent',
    description: 'Searches for things',
    version: '1.0.0',
    domain: 'customer_facing',
    scope: 'hotel',
    capabilities: ['SEARCH', 'FILTER'],
    context_mode: 'stateful',
    context_access: { read: ['*'], write: ['results'], forbidden: ['secret_key'] },
    async_tools: [],
    input_channel: 'input:agent_search',
    output_channel: 'output:agent_search',
    priority: 5,
    max_concurrent: 3,
    timeout_ms: 5000,
    heartbeat_interval_ms: 3000,
    role: null,
    accepts_from: ['*'],
    requires_human_approval: false,
    ...overrides,
  }
}

function makeTaskInput(overrides: Partial<TaskInput> = {}): TaskInput {
  return {
    taskId: 'task_1',
    sessionId: 'sess_1',
    intentId: 'SEARCH',
    slots: { query: 'hotels' },
    contextSnapshot: {},
    priority: 5,
    timeoutMs: 5000,
    replyTo: 'results:dispatcher',
    ...overrides,
  }
}

// ── Tests ────────────────────────────────────────────────────────────────────

describe('CapabilityRouter', () => {
  let bus: InMemoryBus
  let registry: AgentRegistry
  let locks: InMemoryLockManager
  let taskQueue: InMemoryTaskQueue
  let contextStore: InMemoryContextStore
  let router: CapabilityRouter

  beforeEach(() => {
    bus = new InMemoryBus()
    registry = new AgentRegistry(bus)
    locks = new InMemoryLockManager()
    taskQueue = new InMemoryTaskQueue({ lockManager: locks, bus })
    contextStore = new InMemoryContextStore()

    router = new CapabilityRouter({
      registry,
      lockManager: locks,
      taskQueue,
      contextStore,
      bus,
      dispatcherAgentId: 'dispatcher',
    })
  })

  afterEach(() => {
    router.dispose()
    taskQueue.dispose()
    locks.dispose()
    registry.dispose()
  })

  // ── 7-step algorithm ──────────────────────────────────────────────────

  describe('7-step routing algorithm', () => {
    it('returns null when no agents are registered', async () => {
      const result = await router.route({
        capabilities: ['SEARCH'],
        callerAgentId: 'dispatcher',
      })
      expect(result).toBeNull()
    })

    it('step 1: filters by domain', async () => {
      registry.register(makeManifest({ agent_id: 'a1', domain: 'customer_facing' }))
      registry.register(makeManifest({ agent_id: 'a2', domain: 'internal_ops' }))

      const result = await router.route({
        domain: 'internal_ops',
        capabilities: ['SEARCH'],
        callerAgentId: 'dispatcher',
      })

      expect(result).not.toBeNull()
      expect(result!.agentId).toBe('a2')
    })

    it('step 2: filters by scope', async () => {
      registry.register(makeManifest({ agent_id: 'a1', scope: 'hotel' }))
      registry.register(makeManifest({ agent_id: 'a2', scope: 'flight' }))

      const result = await router.route({
        scope: 'flight',
        capabilities: ['SEARCH'],
        callerAgentId: 'dispatcher',
      })

      expect(result).not.toBeNull()
      expect(result!.agentId).toBe('a2')
    })

    it('step 3: filters by capabilities (superset)', async () => {
      registry.register(makeManifest({ agent_id: 'a1', capabilities: ['SEARCH'] }))
      registry.register(
        makeManifest({ agent_id: 'a2', capabilities: ['SEARCH', 'FILTER', 'SORT'] }),
      )

      const result = await router.route({
        capabilities: ['SEARCH', 'FILTER'],
        callerAgentId: 'dispatcher',
      })

      // a1 has ['SEARCH'] which doesn't include 'FILTER', so only a2 matches
      expect(result).not.toBeNull()
      expect(result!.agentId).toBe('a2')
    })

    it('step 4: filters by accepts_from', async () => {
      registry.register(makeManifest({ agent_id: 'a1', accepts_from: ['dispatcher'] }))
      registry.register(makeManifest({ agent_id: 'a2', accepts_from: ['other_agent'] }))

      const result = await router.route({
        capabilities: ['SEARCH'],
        callerAgentId: 'dispatcher',
      })

      expect(result).not.toBeNull()
      expect(result!.agentId).toBe('a1')
    })

    it('step 4: accepts_from wildcard allows all callers', async () => {
      registry.register(makeManifest({ agent_id: 'a1', accepts_from: ['*'] }))

      const result = await router.route({
        capabilities: ['SEARCH'],
        callerAgentId: 'any_agent',
      })

      expect(result).not.toBeNull()
      expect(result!.agentId).toBe('a1')
    })

    it('step 5: filters out agents at max load', async () => {
      registry.register(makeManifest({ agent_id: 'a1', max_concurrent: 1 }))
      registry.register(makeManifest({ agent_id: 'a2', max_concurrent: 3 }))

      // Max out a1's load
      await registry.incrementLoad('a1')

      const result = await router.route({
        capabilities: ['SEARCH'],
        callerAgentId: 'dispatcher',
      })

      expect(result).not.toBeNull()
      expect(result!.agentId).toBe('a2')
    })

    it('step 6: selects highest priority agent', async () => {
      registry.register(makeManifest({ agent_id: 'a_low', priority: 2 }))
      registry.register(makeManifest({ agent_id: 'a_high', priority: 9 }))
      registry.register(makeManifest({ agent_id: 'a_mid', priority: 5 }))

      const result = await router.route({
        capabilities: ['SEARCH'],
        callerAgentId: 'dispatcher',
      })

      expect(result!.agentId).toBe('a_high')
    })

    it('step 6: with equal priority, selects lowest load', async () => {
      registry.register(makeManifest({ agent_id: 'a1', priority: 5, max_concurrent: 5 }))
      registry.register(makeManifest({ agent_id: 'a2', priority: 5, max_concurrent: 5 }))

      // Give a1 more load
      await registry.incrementLoad('a1')
      await registry.incrementLoad('a1')

      const result = await router.route({
        capabilities: ['SEARCH'],
        callerAgentId: 'dispatcher',
      })

      expect(result!.agentId).toBe('a2')
    })

    it('3 candidates → picks highest priority with lowest load', async () => {
      registry.register(makeManifest({ agent_id: 'a1', priority: 3, max_concurrent: 5 }))
      registry.register(makeManifest({ agent_id: 'a2', priority: 8, max_concurrent: 5 }))
      registry.register(makeManifest({ agent_id: 'a3', priority: 8, max_concurrent: 5 }))

      // a2 and a3 have same priority, give a2 more load
      await registry.incrementLoad('a2')
      await registry.incrementLoad('a2')

      const result = await router.route({
        capabilities: ['SEARCH'],
        callerAgentId: 'dispatcher',
      })

      // a3 has same priority as a2 but lower load
      expect(result!.agentId).toBe('a3')
    })

    it('returns null when all candidates are at max load', async () => {
      registry.register(makeManifest({ agent_id: 'a1', max_concurrent: 1 }))
      await registry.incrementLoad('a1')

      const result = await router.route({
        capabilities: ['SEARCH'],
        callerAgentId: 'dispatcher',
      })

      expect(result).toBeNull()
    })

    it('returns null when no agent has required capabilities', async () => {
      registry.register(makeManifest({ agent_id: 'a1', capabilities: ['BOOKING'] }))

      const result = await router.route({
        capabilities: ['SEARCH'],
        callerAgentId: 'dispatcher',
      })

      expect(result).toBeNull()
    })
  })

  // ── buildContextSnapshot ──────────────────────────────────────────────

  describe('buildContextSnapshot', () => {
    it('builds snapshot respecting agent context_access.read', async () => {
      await contextStore.set('sess_1', 'locale', 'es-MX')
      await contextStore.set('sess_1', 'results', [1, 2, 3])
      await contextStore.set('sess_1', 'secret_key', 'abc123')
      await contextStore.set('sess_1', 'conversation_history', ['msg1', 'msg2'])

      const manifest = makeManifest({
        context_access: {
          read: ['*'],
          write: ['results'],
          forbidden: ['secret_key'],
        },
      })

      const snapshot = await router.buildContextSnapshot('sess_1', manifest)

      // Should include everything EXCEPT the forbidden field
      expect(snapshot).toHaveProperty('locale', 'es-MX')
      expect(snapshot).toHaveProperty('results', [1, 2, 3])
      expect(snapshot).toHaveProperty('conversation_history', ['msg1', 'msg2'])
      expect(snapshot).not.toHaveProperty('secret_key')
    })

    it('stateless agent with limited read gets filtered snapshot', async () => {
      await contextStore.set('sess_1', 'locale', 'es-MX')
      await contextStore.set('sess_1', 'results', [])
      await contextStore.set('sess_1', 'conversation_history', ['msg1'])

      const manifest = makeManifest({
        context_mode: 'stateless',
        context_access: {
          read: ['locale'],
          write: [],
          forbidden: [],
        },
      })

      const snapshot = await router.buildContextSnapshot('sess_1', manifest)

      // Stateless agent: only gets 'locale', NOT conversation_history
      expect(snapshot).toEqual({ locale: 'es-MX' })
    })
  })

  // ── Auto-routing via start() ──────────────────────────────────────────

  describe('auto-routing via start()', () => {
    it('auto-routes TASK_AVAILABLE to the best agent', async () => {
      // Register an agent
      registry.register(makeManifest({ agent_id: 'agent_search' }))

      // Set up context
      await contextStore.set('sess_1', 'locale', 'es-MX')

      // Start the router
      const unsub = router.start()

      // Track payloads delivered to the agent's input channel
      const payloads: unknown[] = []
      bus.subscribe('bus:input:agent_search', (data) => {
        payloads.push(data)
      })

      // Publish a task (this will emit TASK_AVAILABLE on the bus)
      await taskQueue.publish(makeTaskInput({ intentId: 'SEARCH' }))

      // Give the async handler time to fire
      await new Promise((r) => setTimeout(r, 50))

      // Task should be RUNNING
      expect(await taskQueue.getStatus('task_1')).toBe('RUNNING')

      // Payload should have been delivered
      expect(payloads.length).toBe(1)
      expect(payloads[0]).toHaveProperty('event', 'TASK_PAYLOAD')
      expect(payloads[0]).toHaveProperty('task_id', 'task_1')

      unsub()
    })

    it('no candidate → task stays AVAILABLE', async () => {
      // No agents registered
      const unsub = router.start()

      await taskQueue.publish(makeTaskInput())
      await new Promise((r) => setTimeout(r, 50))

      // Task should still be AVAILABLE (no one to route to)
      expect(await taskQueue.getStatus('task_1')).toBe('AVAILABLE')

      unsub()
    })

    it('race condition: 2 routers, only one wins', async () => {
      registry.register(makeManifest({ agent_id: 'agent_search' }))

      const router2 = new CapabilityRouter({
        registry,
        lockManager: locks,
        taskQueue,
        contextStore,
        bus,
        dispatcherAgentId: 'dispatcher',
      })

      const unsub1 = router.start()
      const unsub2 = router2.start()

      await taskQueue.publish(makeTaskInput({ intentId: 'SEARCH' }))
      await new Promise((r) => setTimeout(r, 50))

      // Task should be RUNNING (one router won)
      const status = await taskQueue.getStatus('task_1')
      expect(status).toBe('RUNNING')

      unsub1()
      unsub2()
      router2.dispose()
    })
  })
})
