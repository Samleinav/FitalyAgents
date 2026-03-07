import { describe, it, expect } from 'vitest'
import { ContextBuilderAgent } from './context-builder-agent.js'
import { InMemoryBus } from '../bus/in-memory-bus.js'
import { InMemoryContextStore } from '../context/in-memory-context-store.js'

// ── Helpers ──────────────────────────────────────────────────────────────────

function createAgent(config?: { maxTurns?: number; maxActions?: number }) {
  const bus = new InMemoryBus()
  const contextStore = new InMemoryContextStore()
  const agent = new ContextBuilderAgent({ bus, contextStore, config })
  return { agent, bus, contextStore }
}

// ── Tests ────────────────────────────────────────────────────────────────────

describe('ContextBuilderAgent', () => {
  // ── Multi-turn conversation ───────────────────────────────────────

  describe('conversation history', () => {
    it('accumulates user turns from SPEECH_FINAL', async () => {
      const { agent, bus } = createAgent()
      await agent.start()

      await bus.publish('bus:SPEECH_FINAL', {
        session_id: 'ses-1',
        text: '¿tienen tenis Nike?',
      })
      await bus.publish('bus:SPEECH_FINAL', {
        session_id: 'ses-1',
        text: 'muéstrame los blancos',
      })

      // Give async handlers time
      await new Promise((r) => setTimeout(r, 20))

      const ctx = await agent.getEnrichedContext('ses-1')
      expect(ctx.conversation_history).toHaveLength(2)
      expect(ctx.conversation_history[0].role).toBe('user')
      expect(ctx.conversation_history[0].content).toBe('¿tienen tenis Nike?')
      expect(ctx.conversation_history[1].content).toBe('muéstrame los blancos')
    })

    it('respects maxTurns limit', async () => {
      const { agent, bus } = createAgent({ maxTurns: 3 })
      await agent.start()

      for (let i = 0; i < 5; i++) {
        await bus.publish('bus:SPEECH_FINAL', {
          session_id: 'ses-1',
          text: `turno ${i}`,
        })
      }

      await new Promise((r) => setTimeout(r, 30))

      const ctx = await agent.getEnrichedContext('ses-1')
      expect(ctx.conversation_history).toHaveLength(3)
      // Oldest turns should be evicted
      expect(ctx.conversation_history[0].content).toBe('turno 2')
    })

    it('isolates sessions', async () => {
      const { agent, bus } = createAgent()
      await agent.start()

      await bus.publish('bus:SPEECH_FINAL', {
        session_id: 'ses-1',
        text: 'hola session 1',
      })
      await bus.publish('bus:SPEECH_FINAL', {
        session_id: 'ses-2',
        text: 'hola session 2',
      })

      await new Promise((r) => setTimeout(r, 20))

      const ctx1 = await agent.getEnrichedContext('ses-1')
      const ctx2 = await agent.getEnrichedContext('ses-2')

      expect(ctx1.conversation_history).toHaveLength(1)
      expect(ctx1.conversation_history[0].content).toBe('hola session 1')
      expect(ctx2.conversation_history).toHaveLength(1)
      expect(ctx2.conversation_history[0].content).toBe('hola session 2')
    })

    it('adds assistant turns from ACTION_COMPLETED with text result', async () => {
      const { agent, bus } = createAgent()
      await agent.start()

      await bus.publish('bus:SPEECH_FINAL', {
        session_id: 'ses-1',
        text: 'busco zapatos',
      })
      await bus.publish('bus:ACTION_COMPLETED', {
        session_id: 'ses-1',
        intent_id: 'product_search',
        result: { text: 'Encontré 3 opciones de zapatos.' },
      })

      await new Promise((r) => setTimeout(r, 20))

      const ctx = await agent.getEnrichedContext('ses-1')
      expect(ctx.conversation_history).toHaveLength(2)
      expect(ctx.conversation_history[1].role).toBe('assistant')
      expect(ctx.conversation_history[1].content).toBe('Encontré 3 opciones de zapatos.')
    })
  })

  // ── AMBIENT_CONTEXT ───────────────────────────────────────────────

  describe('ambient context', () => {
    it('stores ambient context without generating conversation turns', async () => {
      const { agent, bus } = createAgent()
      await agent.start()

      await bus.publish('bus:AMBIENT_CONTEXT', {
        session_id: 'ses-1',
        noise_level: 'high',
        speaker_count: 2,
      })

      await new Promise((r) => setTimeout(r, 20))

      const ctx = await agent.getEnrichedContext('ses-1')
      expect(ctx.conversation_history).toHaveLength(0) // No turns added
      expect(ctx.ambient_context.noise_level).toBe('high')
      expect(ctx.ambient_context.speaker_count).toBe(2)
    })

    it('merges multiple ambient updates', async () => {
      const { agent, bus } = createAgent()
      await agent.start()

      await bus.publish('bus:AMBIENT_CONTEXT', {
        session_id: 'ses-1',
        noise_level: 'low',
      })
      await bus.publish('bus:AMBIENT_CONTEXT', {
        session_id: 'ses-1',
        temperature: 22,
      })

      await new Promise((r) => setTimeout(r, 20))

      const ctx = await agent.getEnrichedContext('ses-1')
      expect(ctx.ambient_context.noise_level).toBe('low')
      expect(ctx.ambient_context.temperature).toBe(22)
    })
  })

  // ── Ambient Context Pipeline (Sprint 5.3) ─────────────────────────

  describe('ambient context pipeline', () => {
    it('AMBIENT_CONTEXT with text extracts product mention into structured ambient', async () => {
      const { agent, bus, contextStore } = createAgent()
      await agent.start()

      await bus.publish('bus:AMBIENT_CONTEXT', {
        session_id: 'ses-1',
        text: 'busco tenis Nike para regalo',
        speaker_id: 'spk-ambient',
      })

      await new Promise((r) => setTimeout(r, 20))

      const ambient = await contextStore.getAmbient('ses-1')
      expect(ambient).not.toBeNull()
      expect(ambient!.last_product_mentioned).toBe('tenis Nike para regalo')
      expect(ambient!.conversation_snippets).toHaveLength(1)
      expect(ambient!.conversation_snippets[0].text).toBe('busco tenis Nike para regalo')
      expect(ambient!.conversation_snippets[0].speaker_id).toBe('spk-ambient')

      await agent.stop()
    })

    it('ambient last_product_mentioned resolves in getEnrichedContext', async () => {
      // Scenario: customer mentions Nike to a friend (ambient),
      // then asks "¿los tienen en azul?" — context resolves product = Nike
      const { agent, bus } = createAgent()
      await agent.start()

      // Customer overheard saying they like Nike
      await bus.publish('bus:AMBIENT_CONTEXT', {
        session_id: 'ses-1',
        text: 'me gustan los tenis Nike',
        speaker_id: 'spk-1',
      })

      await new Promise((r) => setTimeout(r, 20))

      // Customer now asks directly (no product mentioned in direct speech)
      await bus.publish('bus:SPEECH_FINAL', {
        session_id: 'ses-1',
        text: '¿los tienen en azul?',
      })

      await new Promise((r) => setTimeout(r, 20))

      const ctx = await agent.getEnrichedContext('ses-1')
      // Direct speech didn't mention a product, but ambient context has 'tenis Nike'
      expect(ctx.last_product_mentioned).not.toBeNull()
      // Ambient product surfaces via fallback
      expect(ctx.ambient_context.last_product_mentioned).toBeTruthy()

      await agent.stop()
    })

    it('direct speech product overrides ambient product', async () => {
      const { agent, bus } = createAgent()
      await agent.start()

      // Ambient mention
      await bus.publish('bus:AMBIENT_CONTEXT', {
        session_id: 'ses-1',
        text: 'busco tenis Nike',
      })
      await new Promise((r) => setTimeout(r, 20))

      // Direct speech with different product
      await bus.publish('bus:SPEECH_FINAL', {
        session_id: 'ses-1',
        text: 'quiero zapatos Adidas',
      })
      await new Promise((r) => setTimeout(r, 20))

      const ctx = await agent.getEnrichedContext('ses-1')
      // Direct speech product takes precedence
      expect(ctx.last_product_mentioned).toContain('Adidas')

      await agent.stop()
    })

    it('accumulates multiple ambient text snippets', async () => {
      const { agent, bus, contextStore } = createAgent()
      await agent.start()

      await bus.publish('bus:AMBIENT_CONTEXT', {
        session_id: 'ses-1',
        text: 'me gustan los tenis Nike',
      })
      await bus.publish('bus:AMBIENT_CONTEXT', {
        session_id: 'ses-1',
        text: 'y también los de Adidas',
      })

      await new Promise((r) => setTimeout(r, 20))

      const ambient = await contextStore.getAmbient('ses-1')
      expect(ambient!.conversation_snippets).toHaveLength(2)

      await agent.stop()
    })

    it('ambient snippets appear in enriched context ambient_context', async () => {
      const { agent, bus } = createAgent()
      await agent.start()

      await bus.publish('bus:AMBIENT_CONTEXT', {
        session_id: 'ses-1',
        text: 'busco tenis Nike',
      })

      await new Promise((r) => setTimeout(r, 20))

      const ctx = await agent.getEnrichedContext('ses-1')
      expect(Array.isArray(ctx.ambient_context.conversation_snippets)).toBe(true)
      expect((ctx.ambient_context.conversation_snippets as unknown[]).length).toBeGreaterThan(0)

      await agent.stop()
    })

    it('non-text ambient events do not affect structured ambient', async () => {
      const { agent, bus, contextStore } = createAgent()
      await agent.start()

      await bus.publish('bus:AMBIENT_CONTEXT', {
        session_id: 'ses-1',
        noise_level: 'high',
        speaker_count: 3,
      })

      await new Promise((r) => setTimeout(r, 20))

      // Flat context still updated
      const ctx = await agent.getEnrichedContext('ses-1')
      expect(ctx.ambient_context.noise_level).toBe('high')

      // Structured ambient not touched
      const ambient = await contextStore.getAmbient('ses-1')
      expect(ambient).toBeNull()

      await agent.stop()
    })
  })

  // ── Draft states ──────────────────────────────────────────────────

  describe('draft states', () => {
    it('reflects DRAFT_CREATED in context', async () => {
      const { agent, bus } = createAgent()
      await agent.start()

      await bus.publish('bus:DRAFT_CREATED', {
        session_id: 'ses-1',
        draft_id: 'draft_001',
        intent_id: 'order_create',
        summary: { product: 'shirt', size: 'M' },
      })

      await new Promise((r) => setTimeout(r, 20))

      const ctx = await agent.getEnrichedContext('ses-1')
      expect(ctx.pending_draft).not.toBeNull()
      expect(ctx.pending_draft!.draft_id).toBe('draft_001')
      expect(ctx.pending_draft!.intent_id).toBe('order_create')
      expect(ctx.pending_draft!.items.product).toBe('shirt')
    })

    it('clears pending_draft on DRAFT_CONFIRMED', async () => {
      const { agent, bus } = createAgent()
      await agent.start()

      await bus.publish('bus:DRAFT_CREATED', {
        session_id: 'ses-1',
        draft_id: 'draft_001',
        intent_id: 'order_create',
        summary: { product: 'shirt' },
      })
      await bus.publish('bus:DRAFT_CONFIRMED', {
        session_id: 'ses-1',
        draft_id: 'draft_001',
      })

      await new Promise((r) => setTimeout(r, 20))

      const ctx = await agent.getEnrichedContext('ses-1')
      expect(ctx.pending_draft).toBeNull()
    })

    it('clears pending_draft on DRAFT_CANCELLED', async () => {
      const { agent, bus } = createAgent()
      await agent.start()

      await bus.publish('bus:DRAFT_CREATED', {
        session_id: 'ses-1',
        draft_id: 'draft_001',
        intent_id: 'order_create',
        summary: { product: 'shirt' },
      })
      await bus.publish('bus:DRAFT_CANCELLED', {
        session_id: 'ses-1',
        draft_id: 'draft_001',
        reason: 'ttl_expired',
      })

      await new Promise((r) => setTimeout(r, 20))

      const ctx = await agent.getEnrichedContext('ses-1')
      expect(ctx.pending_draft).toBeNull()
    })
  })

  // ── Action history ────────────────────────────────────────────────

  describe('action history', () => {
    it('records ACTION_COMPLETED in history', async () => {
      const { agent, bus } = createAgent()
      await agent.start()

      await bus.publish('bus:ACTION_COMPLETED', {
        session_id: 'ses-1',
        intent_id: 'product_search',
        result: { products: ['Nike Air', 'Adidas'] },
      })

      await new Promise((r) => setTimeout(r, 20))

      const ctx = await agent.getEnrichedContext('ses-1')
      expect(ctx.action_history).toHaveLength(1)
      expect(ctx.action_history[0].intent_id).toBe('product_search')
      expect(ctx.action_history[0].result).toEqual({ products: ['Nike Air', 'Adidas'] })
    })

    it('respects maxActions limit', async () => {
      const { agent, bus } = createAgent({ maxActions: 2 })
      await agent.start()

      for (let i = 0; i < 4; i++) {
        await bus.publish('bus:ACTION_COMPLETED', {
          session_id: 'ses-1',
          intent_id: `action_${i}`,
          result: { index: i },
        })
      }

      await new Promise((r) => setTimeout(r, 30))

      const ctx = await agent.getEnrichedContext('ses-1')
      expect(ctx.action_history).toHaveLength(2)
      expect(ctx.action_history[0].intent_id).toBe('action_2')
    })
  })

  // ── Product mention detection ─────────────────────────────────────

  describe('product mentions', () => {
    it('detects product from "busco tenis Nike"', async () => {
      const { agent, bus } = createAgent()
      await agent.start()

      await bus.publish('bus:SPEECH_FINAL', {
        session_id: 'ses-1',
        text: 'busco tenis Nike',
      })

      await new Promise((r) => setTimeout(r, 20))

      const ctx = await agent.getEnrichedContext('ses-1')
      expect(ctx.last_product_mentioned).toBe('tenis Nike')
    })

    it('updates product mention with latest', async () => {
      const { agent, bus } = createAgent()
      await agent.start()

      await bus.publish('bus:SPEECH_FINAL', {
        session_id: 'ses-1',
        text: 'busco tenis Nike',
      })
      await bus.publish('bus:SPEECH_FINAL', {
        session_id: 'ses-1',
        text: 'muéstrame los zapatos Adidas',
      })

      await new Promise((r) => setTimeout(r, 20))

      const ctx = await agent.getEnrichedContext('ses-1')
      expect(ctx.last_product_mentioned).toBe('los zapatos Adidas')
    })
  })

  // ── Empty context ─────────────────────────────────────────────────

  describe('empty context', () => {
    it('returns empty context for unknown session', async () => {
      const { agent } = createAgent()
      await agent.start()

      const ctx = await agent.getEnrichedContext('unknown-session')

      expect(ctx.session_id).toBe('unknown-session')
      expect(ctx.conversation_history).toEqual([])
      expect(ctx.last_product_mentioned).toBeNull()
      expect(ctx.pending_draft).toBeNull()
      expect(ctx.action_history).toEqual([])
      expect(ctx.ambient_context).toEqual({})
    })
  })

  // ── Lifecycle ─────────────────────────────────────────────────────

  describe('lifecycle', () => {
    it('stops receiving events after stop()', async () => {
      const { agent, bus } = createAgent()
      await agent.start()

      await bus.publish('bus:SPEECH_FINAL', {
        session_id: 'ses-1',
        text: 'before stop',
      })
      await new Promise((r) => setTimeout(r, 20))

      await agent.stop()

      await bus.publish('bus:SPEECH_FINAL', {
        session_id: 'ses-1',
        text: 'after stop',
      })
      await new Promise((r) => setTimeout(r, 20))

      const ctx = await agent.getEnrichedContext('ses-1')
      expect(ctx.conversation_history).toHaveLength(1)
      expect(ctx.conversation_history[0].content).toBe('before stop')
    })
  })
})
