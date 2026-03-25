import { describe, it, expect } from 'vitest'
import { AmbientAgent } from './ambient-agent.js'
import { InMemoryBus } from '../bus/in-memory-bus.js'
import { InMemoryContextStore } from '../context/in-memory-context-store.js'
import type { IStreamingLLM } from './interaction-agent.js'

// ── Helpers ──────────────────────────────────────────────────────────────────

function createMockLLM(
  response:
    | string
    | (() => string) = '{ "product": null, "sentiment": null, "purchase_intent": false, "language": null }',
): IStreamingLLM {
  return {
    stream: async function* (_params) {
      const text = typeof response === 'function' ? response() : response
      yield { type: 'text' as const, text }
      yield { type: 'end' as const, stop_reason: 'end_turn' as const }
    },
  }
}

function createErrorLLM(): IStreamingLLM {
  return {
    stream: async function* (_params) {
      throw new Error('LLM connection failed')
    },
  }
}

function createInvalidJsonLLM(): IStreamingLLM {
  return {
    stream: async function* (_params) {
      yield { type: 'text' as const, text: 'this is not json at all' }
      yield { type: 'end' as const, stop_reason: 'end_turn' as const }
    },
  }
}

function createAmbientAgent(opts?: { llm?: IStreamingLLM; maxFragmentsPerMinute?: number }) {
  const bus = new InMemoryBus()
  const contextStore = new InMemoryContextStore()
  const llm = opts?.llm ?? createMockLLM()

  const agent = new AmbientAgent({
    bus,
    llm,
    contextStore,
    config: {
      maxFragmentsPerMinute: opts?.maxFragmentsPerMinute,
    },
  })

  return { agent, bus, contextStore, llm }
}

// ── Tests ────────────────────────────────────────────────────────────────────

describe('AmbientAgent', () => {
  // ── Core functionality ────────────────────────────────────────────

  describe('product detection', () => {
    it('updates contextStore when product is mentioned', async () => {
      const llm = createMockLLM(
        '{ "product": "Nike Air Max", "sentiment": "positive", "purchase_intent": true, "language": "es" }',
      )
      const { agent, contextStore } = createAmbientAgent({ llm })

      await agent.onEvent('bus:AMBIENT_CONTEXT', {
        event: 'AMBIENT_CONTEXT',
        session_id: 'session-1',
        speaker_id: 'spk_A',
        text: 'Mira esos Nike Air Max, están bonitos',
        timestamp: 1000,
      })

      const ambient = await contextStore.getAmbient('session-1')
      expect(ambient).not.toBeNull()
      expect(ambient!.last_product_mentioned).toBe('Nike Air Max')
      expect(ambient!.conversation_snippets).toHaveLength(1)
      expect(ambient!.conversation_snippets[0].text).toBe('Mira esos Nike Air Max, están bonitos')
      expect(ambient!.conversation_snippets[0].speaker_id).toBe('spk_A')
    })
  })

  describe('no relevant info', () => {
    it('does NOT update contextStore when product is null', async () => {
      const llm = createMockLLM(
        '{ "product": null, "sentiment": null, "purchase_intent": false, "language": null }',
      )
      const { agent, contextStore } = createAmbientAgent({ llm })

      await agent.onEvent('bus:AMBIENT_CONTEXT', {
        event: 'AMBIENT_CONTEXT',
        session_id: 'session-1',
        speaker_id: 'spk_A',
        text: '¿Qué hora es?',
        timestamp: 1000,
      })

      const ambient = await contextStore.getAmbient('session-1')
      expect(ambient).toBeNull()
    })
  })

  describe('sentiment detection', () => {
    it('stores sentiment correctly in contextStore', async () => {
      const llm = createMockLLM(
        '{ "product": "Adidas Superstar", "sentiment": "negative", "purchase_intent": false, "language": "es" }',
      )
      const { agent, contextStore } = createAmbientAgent({ llm })

      await agent.onEvent('bus:AMBIENT_CONTEXT', {
        event: 'AMBIENT_CONTEXT',
        session_id: 'session-1',
        speaker_id: 'spk_B',
        text: 'Esos Adidas están muy caros, no me gustan',
        timestamp: 2000,
      })

      const ambient = await contextStore.getAmbient('session-1')
      expect(ambient).not.toBeNull()
      expect(ambient!.last_product_mentioned).toBe('Adidas Superstar')
    })
  })

  describe('purchase intent', () => {
    it('detects purchase_intent correctly', async () => {
      const llm = createMockLLM(
        '{ "product": "Converse Chuck", "sentiment": "positive", "purchase_intent": true, "language": "es" }',
      )
      const { agent, contextStore } = createAmbientAgent({ llm })

      await agent.onEvent('bus:AMBIENT_CONTEXT', {
        event: 'AMBIENT_CONTEXT',
        session_id: 'session-1',
        speaker_id: 'spk_A',
        text: 'Sí, me los quiero llevar, esos Converse',
        timestamp: 3000,
      })

      const ambient = await contextStore.getAmbient('session-1')
      expect(ambient).not.toBeNull()
      expect(ambient!.last_product_mentioned).toBe('Converse Chuck')
    })
  })

  // ── Rate limiting ─────────────────────────────────────────────────

  describe('rate limiting', () => {
    it('stops processing after exceeding maxFragmentsPerMinute', async () => {
      const llm = createMockLLM(
        '{ "product": "TestProduct", "sentiment": "neutral", "purchase_intent": false, "language": "es" }',
      )
      const { agent, contextStore } = createAmbientAgent({
        llm,
        maxFragmentsPerMinute: 3,
      })

      // Process 3 fragments (within limit)
      for (let i = 0; i < 3; i++) {
        await agent.onEvent('bus:AMBIENT_CONTEXT', {
          event: 'AMBIENT_CONTEXT',
          session_id: `session-${i}`,
          speaker_id: 'spk_A',
          text: `Fragment ${i} about TestProduct`,
          timestamp: Date.now(),
        })
      }

      // 4th fragment should be rate-limited (no context update)
      await agent.onEvent('bus:AMBIENT_CONTEXT', {
        event: 'AMBIENT_CONTEXT',
        session_id: 'session-limited',
        speaker_id: 'spk_A',
        text: 'This should be rate-limited',
        timestamp: Date.now(),
      })

      // The 3 sessions should have context, but session-limited should not
      for (let i = 0; i < 3; i++) {
        const ambient = await contextStore.getAmbient(`session-${i}`)
        expect(ambient).not.toBeNull()
      }

      const limited = await contextStore.getAmbient('session-limited')
      expect(limited).toBeNull()
    })
  })

  // ── Multiple speakers ─────────────────────────────────────────────

  describe('multiple speakers', () => {
    it('enriches context for different sessions independently', async () => {
      const callCount = { n: 0 }
      const products = ['Nike Air', 'Puma Suede']
      const llm: IStreamingLLM = {
        stream: async function* (_params) {
          const product = products[callCount.n % products.length]
          callCount.n++
          yield {
            type: 'text' as const,
            text: `{ "product": "${product}", "sentiment": "positive", "purchase_intent": true, "language": "es" }`,
          }
          yield { type: 'end' as const, stop_reason: 'end_turn' as const }
        },
      }

      const { agent, contextStore } = createAmbientAgent({ llm })

      await agent.onEvent('bus:AMBIENT_CONTEXT', {
        event: 'AMBIENT_CONTEXT',
        session_id: 'session-A',
        speaker_id: 'spk_A',
        text: 'Me gustan los Nike Air',
        timestamp: 1000,
      })

      await agent.onEvent('bus:AMBIENT_CONTEXT', {
        event: 'AMBIENT_CONTEXT',
        session_id: 'session-B',
        speaker_id: 'spk_B',
        text: 'Prefiero los Puma Suede',
        timestamp: 2000,
      })

      const ambientA = await contextStore.getAmbient('session-A')
      const ambientB = await contextStore.getAmbient('session-B')

      expect(ambientA!.last_product_mentioned).toBe('Nike Air')
      expect(ambientB!.last_product_mentioned).toBe('Puma Suede')
    })
  })

  // ── Error handling ────────────────────────────────────────────────

  describe('error handling', () => {
    it('does not crash when LLM throws an error', async () => {
      const llm = createErrorLLM()
      const { agent, contextStore } = createAmbientAgent({ llm })

      // Should not throw
      await agent.onEvent('bus:AMBIENT_CONTEXT', {
        event: 'AMBIENT_CONTEXT',
        session_id: 'session-1',
        speaker_id: 'spk_A',
        text: 'Something about shoes',
        timestamp: 1000,
      })

      const ambient = await contextStore.getAmbient('session-1')
      expect(ambient).toBeNull()
    })

    it('does not crash when LLM returns invalid JSON', async () => {
      const llm = createInvalidJsonLLM()
      const { agent, contextStore } = createAmbientAgent({ llm })

      // Should not throw
      await agent.onEvent('bus:AMBIENT_CONTEXT', {
        event: 'AMBIENT_CONTEXT',
        session_id: 'session-1',
        speaker_id: 'spk_A',
        text: 'Some ambient chatter',
        timestamp: 1000,
      })

      // No product found → no ambient context stored
      const ambient = await contextStore.getAmbient('session-1')
      expect(ambient).toBeNull()
    })
  })

  // ── Integration: InteractionAgent reads enriched context ──────────

  describe('enriched context', () => {
    it('InteractionAgent can read ambient context set by AmbientAgent', async () => {
      const llm = createMockLLM(
        '{ "product": "Nike Air 42", "sentiment": "interested", "purchase_intent": true, "language": "es" }',
      )
      const { agent, contextStore } = createAmbientAgent({ llm })

      // AmbientAgent processes a fragment
      await agent.onEvent('bus:AMBIENT_CONTEXT', {
        event: 'AMBIENT_CONTEXT',
        session_id: 'session-1',
        speaker_id: 'spk_customer',
        text: 'Esos Nike Air 42 se ven increíbles',
        timestamp: 5000,
      })

      // Simulate InteractionAgent reading the enriched context
      const ambient = await contextStore.getAmbient('session-1')
      expect(ambient).not.toBeNull()
      expect(ambient!.last_product_mentioned).toBe('Nike Air 42')
      expect(ambient!.conversation_snippets).toHaveLength(1)
      expect(ambient!.conversation_snippets[0].speaker_id).toBe('spk_customer')

      // InteractionAgent could use this context to proactively suggest product info
      expect(ambient!.timestamp).toBeGreaterThan(0)
    })
  })

  // ── Edge cases ────────────────────────────────────────────────────

  describe('edge cases', () => {
    it('ignores events without session_id', async () => {
      const llm = createMockLLM()
      const { agent, contextStore } = createAmbientAgent({ llm })

      await agent.onEvent('bus:AMBIENT_CONTEXT', {
        event: 'AMBIENT_CONTEXT',
        text: 'no session id here',
        timestamp: 1000,
      })

      // Nothing should be stored anywhere
      expect(await contextStore.getAmbient('undefined')).toBeNull()
    })

    it('ignores events without text', async () => {
      const llm = createMockLLM()
      const { agent, contextStore } = createAmbientAgent({ llm })

      await agent.onEvent('bus:AMBIENT_CONTEXT', {
        event: 'AMBIENT_CONTEXT',
        session_id: 'session-1',
        speaker_id: 'spk_A',
        timestamp: 1000,
      })

      expect(await contextStore.getAmbient('session-1')).toBeNull()
    })

    it('ignores non-AMBIENT_CONTEXT channels', async () => {
      const llm = createMockLLM()
      const { agent, contextStore } = createAmbientAgent({ llm })

      await agent.onEvent('bus:SPEECH_FINAL', {
        event: 'SPEECH_FINAL',
        session_id: 'session-1',
        text: 'This is speech, not ambient',
      })

      expect(await contextStore.getAmbient('session-1')).toBeNull()
    })

    it('accumulates snippets across multiple ambient events', async () => {
      const callCount = { n: 0 }
      const llm: IStreamingLLM = {
        stream: async function* (_params) {
          callCount.n++
          yield {
            type: 'text' as const,
            text: `{ "product": "Nike ${callCount.n}", "sentiment": "neutral", "purchase_intent": false, "language": "es" }`,
          }
          yield { type: 'end' as const, stop_reason: 'end_turn' as const }
        },
      }

      const { agent, contextStore } = createAmbientAgent({ llm })

      await agent.onEvent('bus:AMBIENT_CONTEXT', {
        event: 'AMBIENT_CONTEXT',
        session_id: 'session-1',
        speaker_id: 'spk_A',
        text: 'First mention of Nike',
        timestamp: 1000,
      })

      await agent.onEvent('bus:AMBIENT_CONTEXT', {
        event: 'AMBIENT_CONTEXT',
        session_id: 'session-1',
        speaker_id: 'spk_B',
        text: 'Second mention of Nike',
        timestamp: 2000,
      })

      const ambient = await contextStore.getAmbient('session-1')
      expect(ambient).not.toBeNull()
      expect(ambient!.conversation_snippets).toHaveLength(2)
      expect(ambient!.conversation_snippets[0].speaker_id).toBe('spk_A')
      expect(ambient!.conversation_snippets[1].speaker_id).toBe('spk_B')
      // last_product_mentioned should be from the latest analysis
      expect(ambient!.last_product_mentioned).toBe('Nike 2')
    })
  })
})
