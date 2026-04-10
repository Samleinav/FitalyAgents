import { describe, it, expect, vi, afterEach } from 'vitest'
import { ProactiveAgent } from './proactive-agent.js'
import { InMemoryBus } from '../bus/in-memory-bus.js'
import { InMemoryContextStore } from '../context/in-memory-context-store.js'

// ── Helpers ──────────────────────────────────────────────────────────────────

function createAgent(config?: { idleTimeoutMs?: number; enableIdleDetection?: boolean }) {
  const bus = new InMemoryBus()
  const contextStore = new InMemoryContextStore()
  const triggers: unknown[] = []
  bus.subscribe('bus:PROACTIVE_TRIGGER', (data) => triggers.push(data))

  const agent = new ProactiveAgent({ bus, contextStore, config })
  return { agent, bus, contextStore, triggers }
}

afterEach(() => {
  vi.useRealTimers()
})

// ── Tests ────────────────────────────────────────────────────────────────────

describe('ProactiveAgent', () => {
  // ── idle_customer ─────────────────────────────────────────────────

  describe('idle_customer', () => {
    it('triggers after configured timeout', async () => {
      vi.useFakeTimers()

      const { agent, bus, triggers } = createAgent({ idleTimeoutMs: 500 })
      await agent.start()

      // Customer speaks
      await bus.publish('bus:SPEECH_FINAL', {
        session_id: 'ses-1',
        text: 'hola',
      })

      // Advance past idle timeout
      await vi.advanceTimersByTimeAsync(600)

      expect(triggers).toHaveLength(1)
      expect(triggers[0]).toHaveProperty('reason', 'idle_customer')
      expect(triggers[0]).toHaveProperty('session_id', 'ses-1')

      await agent.stop()
    })

    it('resets timer when customer speaks again', async () => {
      vi.useFakeTimers()

      const { agent, bus, triggers } = createAgent({ idleTimeoutMs: 500 })
      await agent.start()

      // First speech
      await bus.publish('bus:SPEECH_FINAL', {
        session_id: 'ses-1',
        text: 'hola',
      })

      // Wait 300ms (less than timeout)
      await vi.advanceTimersByTimeAsync(300)

      // Second speech — resets timer
      await bus.publish('bus:SPEECH_FINAL', {
        session_id: 'ses-1',
        text: 'busco tenis',
      })

      // Wait another 300ms (total 600ms from first, but only 300ms from second)
      await vi.advanceTimersByTimeAsync(300)

      // Should NOT have triggered yet (only 300ms since last speech)
      expect(triggers).toHaveLength(0)

      // Wait remaining 200ms
      await vi.advanceTimersByTimeAsync(200)

      expect(triggers).toHaveLength(1)

      await agent.stop()
    })

    it('does not trigger when disabled', async () => {
      vi.useFakeTimers()

      const { agent, bus, triggers } = createAgent({
        idleTimeoutMs: 100,
        enableIdleDetection: false,
      })
      await agent.start()

      await bus.publish('bus:SPEECH_FINAL', {
        session_id: 'ses-1',
        text: 'hola',
      })

      await vi.advanceTimersByTimeAsync(500)

      expect(triggers).toHaveLength(0)

      await agent.stop()
    })

    it('tracks multiple sessions independently', async () => {
      vi.useFakeTimers()

      const { agent, bus, triggers } = createAgent({ idleTimeoutMs: 500 })
      await agent.start()

      await bus.publish('bus:SPEECH_FINAL', {
        session_id: 'ses-1',
        text: 'hola',
      })

      await vi.advanceTimersByTimeAsync(200)

      await bus.publish('bus:SPEECH_FINAL', {
        session_id: 'ses-2',
        text: 'hola',
      })

      // At 500ms from ses-1 start — ses-1 triggers, ses-2 not yet
      await vi.advanceTimersByTimeAsync(300)

      expect(triggers).toHaveLength(1)
      expect(triggers[0]).toHaveProperty('session_id', 'ses-1')

      // At 700ms from ses-1 (500ms from ses-2) — ses-2 triggers
      await vi.advanceTimersByTimeAsync(200)

      expect(triggers).toHaveLength(2)
      expect(triggers[1]).toHaveProperty('session_id', 'ses-2')

      await agent.stop()
    })
  })

  // ── out_of_stock ──────────────────────────────────────────────────

  describe('out_of_stock', () => {
    it('triggers when tool returns stock=0', async () => {
      const { agent, bus, triggers } = createAgent({ enableIdleDetection: false })
      await agent.start()

      await bus.publish('bus:ACTION_COMPLETED', {
        session_id: 'ses-1',
        intent_id: 'product_search',
        result: { products: [], stock: 0 },
      })

      await new Promise((r) => setTimeout(r, 20))

      expect(triggers).toHaveLength(1)
      expect(triggers[0]).toHaveProperty('reason', 'out_of_stock')
    })

    it('triggers when products array is empty', async () => {
      const { agent, bus, triggers } = createAgent({ enableIdleDetection: false })
      await agent.start()

      await bus.publish('bus:ACTION_COMPLETED', {
        session_id: 'ses-1',
        intent_id: 'product_search',
        result: { products: [] },
      })

      await new Promise((r) => setTimeout(r, 20))

      expect(triggers).toHaveLength(1)
      expect(triggers[0]).toHaveProperty('reason', 'out_of_stock')
    })

    it('triggers when in_stock is false', async () => {
      const { agent, bus, triggers } = createAgent({ enableIdleDetection: false })
      await agent.start()

      await bus.publish('bus:ACTION_COMPLETED', {
        session_id: 'ses-1',
        intent_id: 'price_check',
        result: { in_stock: false, price: 150 },
      })

      await new Promise((r) => setTimeout(r, 20))

      expect(triggers).toHaveLength(1)
    })

    it('does NOT trigger when products found', async () => {
      const { agent, bus, triggers } = createAgent({ enableIdleDetection: false })
      await agent.start()

      await bus.publish('bus:ACTION_COMPLETED', {
        session_id: 'ses-1',
        intent_id: 'product_search',
        result: { products: ['Nike Air'] },
      })

      await new Promise((r) => setTimeout(r, 20))

      expect(triggers).toHaveLength(0)
    })
  })

  // ── draft_expired ─────────────────────────────────────────────────

  describe('draft_expired', () => {
    it('triggers on DRAFT_CANCELLED with ttl_expired', async () => {
      const { agent, bus, triggers } = createAgent({ enableIdleDetection: false })
      await agent.start()

      await bus.publish('bus:DRAFT_CANCELLED', {
        session_id: 'ses-1',
        draft_id: 'draft_001',
        reason: 'ttl_expired',
      })

      await new Promise((r) => setTimeout(r, 20))

      expect(triggers).toHaveLength(1)
      expect(triggers[0]).toHaveProperty('reason', 'draft_expired')
      expect((triggers[0] as any).context.draft_id).toBe('draft_001')
    })

    it('does NOT trigger on user-initiated cancel', async () => {
      const { agent, bus, triggers } = createAgent({ enableIdleDetection: false })
      await agent.start()

      await bus.publish('bus:DRAFT_CANCELLED', {
        session_id: 'ses-1',
        draft_id: 'draft_001',
        reason: 'cancelled_by_user',
      })

      await new Promise((r) => setTimeout(r, 20))

      expect(triggers).toHaveLength(0)
    })
  })

  // ── sentiment_alert ───────────────────────────────────────────────

  describe('sentiment_alert', () => {
    it('turns SESSION_SENTIMENT_ALERT into a proactive trigger', async () => {
      const { agent, bus, triggers } = createAgent({ enableIdleDetection: false })
      await agent.start()

      await bus.publish('bus:SESSION_SENTIMENT_ALERT', {
        event: 'SESSION_SENTIMENT_ALERT',
        session_id: 'ses-1',
        level: 'angry',
        consecutive_count: 2,
        trigger_text: 'This is ridiculous.',
        speaker_id: 'cust_ana',
        timestamp: Date.now(),
      })

      await new Promise((r) => setTimeout(r, 20))

      expect(triggers).toHaveLength(1)
      expect(triggers[0]).toMatchObject({
        event: 'PROACTIVE_TRIGGER',
        session_id: 'ses-1',
        reason: 'sentiment_alert',
        context: {
          level: 'angry',
          consecutive_count: 2,
          trigger_text: 'This is ridiculous.',
          speaker_id: 'cust_ana',
        },
      })
    })
  })

  // ── Lifecycle ─────────────────────────────────────────────────────

  describe('lifecycle', () => {
    it('clears timers on stop', async () => {
      vi.useFakeTimers()

      const { agent, bus, triggers } = createAgent({ idleTimeoutMs: 500 })
      await agent.start()

      await bus.publish('bus:SPEECH_FINAL', {
        session_id: 'ses-1',
        text: 'hola',
      })

      await agent.stop()

      // Timer should have been cleared
      await vi.advanceTimersByTimeAsync(1000)

      expect(triggers).toHaveLength(0)
    })
  })
})
