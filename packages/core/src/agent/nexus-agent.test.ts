import { describe, it, expect, beforeEach, afterEach } from 'vitest'
import { InMemoryBus } from '../bus/in-memory-bus.js'
import { NexusAgent } from './nexus-agent.js'
import type { TaskPayloadEvent, TaskResultEvent, AgentManifest } from '../types/index.js'

// ── Test Agent subclass ──────────────────────────────────────────────────────

class EchoAgent extends NexusAgent {
  public processedTasks: TaskPayloadEvent[] = []

  async process(task: TaskPayloadEvent): Promise<TaskResultEvent> {
    this.processedTasks.push(task)
    return {
      event: 'TASK_RESULT',
      task_id: task.task_id,
      session_id: task.session_id,
      status: 'completed',
      result: { echo: task.slots },
      context_patch: { last_action: { type: 'ECHO', result: task.slots } },
      completed_at: Date.now(),
    }
  }
}

class FailingAgent extends NexusAgent {
  async process(_task: TaskPayloadEvent): Promise<TaskResultEvent> {
    throw new Error('Something went wrong')
  }
}

// ── Helpers ──────────────────────────────────────────────────────────────────

function createManifest(overrides?: Partial<AgentManifest>): AgentManifest {
  return {
    agent_id: 'test_agent_v1',
    description: 'Test agent',
    version: '0.1.0',
    domain: 'customer_facing',
    scope: 'commerce',
    capabilities: ['ECHO'],
    context_mode: 'stateless',
    context_access: { read: ['*'], write: ['action_status'], forbidden: [] },
    async_tools: [],
    input_channel: 'queue:test_agent_v1:inbox',
    output_channel: 'queue:test_agent_v1:outbox',
    priority: 5,
    max_concurrent: 3,
    timeout_ms: 5000,
    heartbeat_interval_ms: 100, // Fast for tests
    role: null,
    accepts_from: ['DISPATCHER'],
    requires_human_approval: false,
    ...overrides,
  }
}

function createTask(overrides?: Partial<TaskPayloadEvent>): TaskPayloadEvent {
  return {
    event: 'TASK_PAYLOAD',
    task_id: 'task_001',
    session_id: 'sess_001',
    intent_id: 'echo',
    slots: { message: 'hello' },
    context_snapshot: {},
    cancel_token: null,
    timeout_ms: 5000,
    reply_to: 'queue:test_agent_v1:outbox',
    ...overrides,
  }
}

// ── Tests ────────────────────────────────────────────────────────────────────

describe('NexusAgent', () => {
  let bus: InMemoryBus

  beforeEach(() => {
    bus = new InMemoryBus()
  })

  afterEach(async () => {
    await bus.disconnect()
  })

  // ── Registration ─────────────────────────────────────────────────────

  describe('start()', () => {
    it('publishes AGENT_REGISTERED on start', async () => {
      const events: unknown[] = []
      bus.subscribe('bus:AGENT_REGISTERED', (data) => events.push(data))

      const manifest = createManifest()
      const agent = new EchoAgent({ bus, manifest })
      await agent.start()

      expect(events).toHaveLength(1)
      expect(events[0]).toMatchObject({
        event: 'AGENT_REGISTERED',
        agent_id: 'test_agent_v1',
        domain: 'customer_facing',
        capabilities: ['ECHO'],
      })

      await agent.shutdown()
    })

    it('starts publishing heartbeats', async () => {
      const heartbeats: unknown[] = []
      bus.subscribe('bus:HEARTBEAT', (data) => heartbeats.push(data))

      const manifest = createManifest({ heartbeat_interval_ms: 50 })
      const agent = new EchoAgent({ bus, manifest })
      await agent.start()

      // Wait for at least 2 heartbeats
      await new Promise((r) => setTimeout(r, 120))

      expect(heartbeats.length).toBeGreaterThanOrEqual(2)
      expect(heartbeats[0]).toMatchObject({
        event: 'HEARTBEAT',
        agent_id: 'test_agent_v1',
        status: 'idle',
      })

      await agent.shutdown()
    })
  })

  // ── Shutdown ─────────────────────────────────────────────────────────

  describe('shutdown()', () => {
    it('publishes AGENT_DEREGISTERED on shutdown', async () => {
      const events: unknown[] = []
      bus.subscribe('bus:AGENT_DEREGISTERED', (data) => events.push(data))

      const agent = new EchoAgent({ bus, manifest: createManifest() })
      await agent.start()
      await agent.shutdown()

      expect(events).toHaveLength(1)
      expect(events[0]).toMatchObject({
        event: 'AGENT_DEREGISTERED',
        agent_id: 'test_agent_v1',
      })
    })

    it('stops heartbeats after shutdown', async () => {
      const heartbeats: unknown[] = []
      bus.subscribe('bus:HEARTBEAT', (data) => heartbeats.push(data))

      const agent = new EchoAgent({
        bus,
        manifest: createManifest({ heartbeat_interval_ms: 30 }),
      })
      await agent.start()
      await new Promise((r) => setTimeout(r, 80))
      const countBefore = heartbeats.length
      await agent.shutdown()
      await new Promise((r) => setTimeout(r, 80))
      expect(heartbeats.length).toBe(countBefore)
    })
  })

  // ── Task processing ──────────────────────────────────────────────────

  describe('process()', () => {
    it('processes a task from inbox and publishes result to outbox', async () => {
      const manifest = createManifest()
      const agent = new EchoAgent({ bus, manifest })
      await agent.start()

      // Push a task to the inbox
      const task = createTask()
      await bus.lpush(manifest.input_channel, task)

      // Wait for processing
      await new Promise((r) => setTimeout(r, 200))

      // Check the outbox
      const result = await bus.brpop(manifest.output_channel, 1)

      expect(result).toMatchObject({
        event: 'TASK_RESULT',
        task_id: 'task_001',
        session_id: 'sess_001',
        status: 'completed',
        result: { echo: { message: 'hello' } },
      })

      expect(agent.processedTasks).toHaveLength(1)
      await agent.shutdown()
    })

    it('publishes status: failed when process() throws', async () => {
      const manifest = createManifest({ agent_id: 'fail_agent' })
      const agent = new FailingAgent({
        bus,
        manifest: {
          ...manifest,
          input_channel: 'queue:fail_agent:inbox',
          output_channel: 'queue:fail_agent:outbox',
        },
      })
      await agent.start()

      // Push a task
      await bus.lpush(
        'queue:fail_agent:inbox',
        createTask({
          reply_to: 'queue:fail_agent:outbox',
        }),
      )

      await new Promise((r) => setTimeout(r, 200))

      const result = (await bus.brpop('queue:fail_agent:outbox', 1)) as TaskResultEvent
      expect(result).toMatchObject({
        event: 'TASK_RESULT',
        task_id: 'task_001',
        status: 'failed',
        error: 'Something went wrong',
      })

      await agent.shutdown()
    })

    it('processes multiple tasks sequentially', async () => {
      const manifest = createManifest()
      const agent = new EchoAgent({ bus, manifest })
      await agent.start()

      await bus.lpush(manifest.input_channel, createTask({ task_id: 'task_A' }))
      await bus.lpush(manifest.input_channel, createTask({ task_id: 'task_B' }))

      await new Promise((r) => setTimeout(r, 300))

      expect(agent.processedTasks).toHaveLength(2)
      const taskIds = agent.processedTasks.map((t) => t.task_id)
      expect(taskIds).toContain('task_A')
      expect(taskIds).toContain('task_B')

      await agent.shutdown()
    })
  })
})

// ── InMemoryBus unit tests ───────────────────────────────────────────────────

describe('InMemoryBus', () => {
  let bus: InMemoryBus

  beforeEach(() => {
    bus = new InMemoryBus()
  })

  afterEach(async () => {
    await bus.disconnect()
  })

  it('delivers published messages to subscribers', async () => {
    const received: unknown[] = []
    bus.subscribe('test', (data) => received.push(data))

    await bus.publish('test', { hello: 'world' })

    expect(received).toEqual([{ hello: 'world' }])
  })

  it('unsubscribe stops delivery', async () => {
    const received: unknown[] = []
    const unsub = bus.subscribe('test', (data) => received.push(data))

    await bus.publish('test', { a: 1 })
    unsub()
    await bus.publish('test', { a: 2 })

    expect(received).toEqual([{ a: 1 }])
  })

  it('psubscribe matches pattern', async () => {
    const received: Array<{ channel: string; data: unknown }> = []
    bus.psubscribe('bus:*', (channel, data) => received.push({ channel, data }))

    await bus.publish('bus:HEARTBEAT', { hb: true })
    await bus.publish('other:channel', { other: true })

    expect(received).toHaveLength(1)
    expect(received[0]).toEqual({ channel: 'bus:HEARTBEAT', data: { hb: true } })
  })

  it('lpush/brpop queue operations', async () => {
    await bus.lpush('q1', { item: 1 })
    await bus.lpush('q1', { item: 2 })

    const first = await bus.brpop('q1', 1)
    const second = await bus.brpop('q1', 1)

    expect(first).toEqual({ item: 1 })
    expect(second).toEqual({ item: 2 })
  })

  it('brpop blocks and waits for lpush', async () => {
    // Start waiting before pushing
    const promise = bus.brpop('q2', 5)

    // Push after a short delay
    setTimeout(() => bus.lpush('q2', { delayed: true }), 50)

    const result = await promise
    expect(result).toEqual({ delayed: true })
  })

  it('brpop returns null on timeout', async () => {
    const result = await bus.brpop('empty_queue', 0.1)
    expect(result).toBeNull()
  })
})
