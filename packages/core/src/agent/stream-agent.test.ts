import { describe, it, expect, vi, afterEach } from 'vitest'
import { StreamAgent } from './stream-agent.js'
import { InMemoryBus } from '../bus/in-memory-bus.js'

// ── Test Agent ───────────────────────────────────────────────────────────────

class TestAgent extends StreamAgent {
  public receivedEvents: Array<{ channel: string; payload: unknown }> = []

  constructor(
    bus: InMemoryBus,
    private readonly _channels: string[],
  ) {
    super(bus)
  }

  protected get channels(): string[] {
    return this._channels
  }

  async onEvent(channel: string, payload: unknown): Promise<void> {
    this.receivedEvents.push({ channel, payload })
  }
}

class FailingAgent extends StreamAgent {
  protected get channels(): string[] {
    return ['bus:SPEECH_FINAL']
  }

  async onEvent(): Promise<void> {
    throw new Error('stream failure')
  }
}

// ── Tests ────────────────────────────────────────────────────────────────────

describe('StreamAgent', () => {
  let bus: InMemoryBus

  afterEach(() => {
    // Ensure no leaked timers
    vi.restoreAllMocks()
  })

  // ── start() ─────────────────────────────────────────────────────────

  describe('start()', () => {
    it('subscribes to configured channels', async () => {
      bus = new InMemoryBus()
      const agent = new TestAgent(bus, ['bus:SPEECH_FINAL', 'bus:ACTION_COMPLETED'])

      await agent.start()

      // Publish events to both channels
      await bus.publish('bus:SPEECH_FINAL', { text: 'hello' })
      await bus.publish('bus:ACTION_COMPLETED', { result: 'ok' })

      // Give async handlers a tick
      await new Promise((r) => setTimeout(r, 10))

      expect(agent.receivedEvents).toHaveLength(2)
      expect(agent.receivedEvents[0].channel).toBe('bus:SPEECH_FINAL')
      expect(agent.receivedEvents[1].channel).toBe('bus:ACTION_COMPLETED')
    })

    it('is idempotent — calling start() twice does not double-subscribe', async () => {
      bus = new InMemoryBus()
      const agent = new TestAgent(bus, ['bus:SPEECH_FINAL'])

      await agent.start()
      await agent.start() // second call

      await bus.publish('bus:SPEECH_FINAL', { text: 'test' })
      await new Promise((r) => setTimeout(r, 10))

      // Should only receive 1 event, not 2
      expect(agent.receivedEvents).toHaveLength(1)
    })

    it('works with no channels', async () => {
      bus = new InMemoryBus()
      const agent = new TestAgent(bus, [])

      await agent.start()

      await bus.publish('bus:SPEECH_FINAL', { text: 'test' })
      await new Promise((r) => setTimeout(r, 10))

      expect(agent.receivedEvents).toHaveLength(0)
    })
  })

  // ── stop() ──────────────────────────────────────────────────────────

  describe('stop()', () => {
    it('unsubscribes from all channels', async () => {
      bus = new InMemoryBus()
      const agent = new TestAgent(bus, ['bus:SPEECH_FINAL', 'bus:ACTION_COMPLETED'])

      await agent.start()
      await agent.stop()

      // Events after stop should NOT be received
      await bus.publish('bus:SPEECH_FINAL', { text: 'after stop' })
      await bus.publish('bus:ACTION_COMPLETED', { result: 'after stop' })
      await new Promise((r) => setTimeout(r, 10))

      expect(agent.receivedEvents).toHaveLength(0)
    })

    it('is idempotent — calling stop() twice does not throw', async () => {
      bus = new InMemoryBus()
      const agent = new TestAgent(bus, ['bus:SPEECH_FINAL'])

      await agent.start()
      await agent.stop()
      await agent.stop() // should not throw

      expect(agent.receivedEvents).toHaveLength(0)
    })

    it('can restart after stop', async () => {
      bus = new InMemoryBus()
      const agent = new TestAgent(bus, ['bus:SPEECH_FINAL'])

      await agent.start()
      await agent.stop()
      await agent.start()

      await bus.publish('bus:SPEECH_FINAL', { text: 'restarted' })
      await new Promise((r) => setTimeout(r, 10))

      expect(agent.receivedEvents).toHaveLength(1)
      expect(agent.receivedEvents[0].payload).toEqual({ text: 'restarted' })
    })
  })

  // ── onEvent() ───────────────────────────────────────────────────────

  describe('onEvent()', () => {
    it('receives the correct channel and payload', async () => {
      bus = new InMemoryBus()
      const agent = new TestAgent(bus, ['bus:SPEECH_FINAL'])

      await agent.start()

      const payload = { session_id: 'ses-1', text: '¿busco tenis nike?', timestamp: Date.now() }
      await bus.publish('bus:SPEECH_FINAL', payload)
      await new Promise((r) => setTimeout(r, 10))

      expect(agent.receivedEvents[0].channel).toBe('bus:SPEECH_FINAL')
      expect(agent.receivedEvents[0].payload).toEqual(payload)
    })

    it('handles multiple events in sequence', async () => {
      bus = new InMemoryBus()
      const agent = new TestAgent(bus, ['bus:SPEECH_FINAL'])

      await agent.start()

      for (let i = 0; i < 5; i++) {
        await bus.publish('bus:SPEECH_FINAL', { index: i })
      }
      await new Promise((r) => setTimeout(r, 50))

      expect(agent.receivedEvents).toHaveLength(5)
      for (let i = 0; i < 5; i++) {
        expect(agent.receivedEvents[i].payload).toEqual({ index: i })
      }
    })

    it('publishes AGENT_ERROR when a handler throws', async () => {
      bus = new InMemoryBus()
      const errors: unknown[] = []
      bus.subscribe('bus:AGENT_ERROR', (data) => {
        errors.push(data)
      })

      const agent = new FailingAgent(bus)
      await agent.start()

      await expect(bus.publish('bus:SPEECH_FINAL', { text: 'boom' })).rejects.toThrow(
        'stream failure',
      )
      expect(errors).toHaveLength(1)
      expect(errors[0]).toMatchObject({
        event: 'AGENT_ERROR',
        agent_id: 'FailingAgent',
        channel: 'bus:SPEECH_FINAL',
        error: 'stream failure',
      })
    })
  })

  // ── dispose() ───────────────────────────────────────────────────────

  describe('dispose()', () => {
    it('stops the agent', async () => {
      bus = new InMemoryBus()
      const agent = new TestAgent(bus, ['bus:SPEECH_FINAL'])

      await agent.start()
      agent.dispose()

      // Wait for async stop
      await new Promise((r) => setTimeout(r, 10))

      await bus.publish('bus:SPEECH_FINAL', { text: 'after dispose' })
      await new Promise((r) => setTimeout(r, 10))

      expect(agent.receivedEvents).toHaveLength(0)
    })
  })

  // ── heartbeat ───────────────────────────────────────────────────────

  describe('heartbeat', () => {
    it('publishes heartbeats at configured interval', async () => {
      vi.useFakeTimers()

      bus = new InMemoryBus()
      const heartbeats: unknown[] = []
      bus.subscribe('bus:HEARTBEAT', (data) => heartbeats.push(data))

      // Create agent with heartbeat
      class HeartbeatAgent extends StreamAgent {
        protected get channels(): string[] {
          return []
        }
        async onEvent(): Promise<void> {}
      }

      const agent = new HeartbeatAgent(bus)
      await agent.start()

      // Access protected method via subclass trick
      ;(agent as any).publishHeartbeat(100)

      // Advance timers
      await vi.advanceTimersByTimeAsync(350)

      expect(heartbeats.length).toBeGreaterThanOrEqual(3)
      expect(heartbeats[0]).toHaveProperty('event', 'HEARTBEAT')
      expect(heartbeats[0]).toHaveProperty('agent_id', 'HeartbeatAgent')

      await agent.stop()
      vi.useRealTimers()
    })

    it('stops heartbeat on stop()', async () => {
      vi.useFakeTimers()

      bus = new InMemoryBus()
      const heartbeats: unknown[] = []
      bus.subscribe('bus:HEARTBEAT', (data) => heartbeats.push(data))

      class HeartbeatAgent extends StreamAgent {
        protected get channels(): string[] {
          return []
        }
        async onEvent(): Promise<void> {}
      }

      const agent = new HeartbeatAgent(bus)
      await agent.start()
      ;(agent as any).publishHeartbeat(100)

      await vi.advanceTimersByTimeAsync(250)
      const countBefore = heartbeats.length

      await agent.stop()

      await vi.advanceTimersByTimeAsync(500)
      const countAfter = heartbeats.length

      // No new heartbeats after stop
      expect(countAfter).toBe(countBefore)

      vi.useRealTimers()
    })
  })
})
