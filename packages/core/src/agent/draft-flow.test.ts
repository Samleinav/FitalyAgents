import { describe, it, expect, beforeEach, vi } from 'vitest'
import { InteractionAgent } from './interaction-agent.js'
import type {
  IStreamingLLM,
  LLMStreamChunk,
  IToolExecutor,
  InteractionAgentDeps,
} from './interaction-agent.js'
import { InMemoryBus } from '../bus/in-memory-bus.js'
import { InMemoryContextStore } from '../context/in-memory-context-store.js'
import { SafetyGuard } from '../safety/safety-guard.js'
import { InMemoryDraftStore } from '../safety/draft-store.js'

// ── Helpers ──────────────────────────────────────────────────────────────────

function createMockLLM(chunks: LLMStreamChunk[] = []): IStreamingLLM {
  return {
    async *stream() {
      for (const chunk of chunks) yield chunk
    },
  }
}

/** LLM that returns JSON for extractDraftChanges */
function createChangesLLM(changes: Record<string, unknown>): IStreamingLLM {
  return {
    async *stream() {
      yield { type: 'text', text: JSON.stringify(changes) } as LLMStreamChunk
      yield { type: 'end', stop_reason: 'end_turn' } as LLMStreamChunk
    },
  }
}

function createMockExecutor(results: Record<string, unknown> = {}): IToolExecutor {
  return {
    execute: vi.fn(async (toolId: string, _input: unknown) => {
      if (toolId in results) return results[toolId]
      return { ok: true, tool: toolId }
    }),
  }
}

function createDraftAgent(overrides: Partial<InteractionAgentDeps> = {}): {
  agent: InteractionAgent
  bus: InMemoryBus
  draftStore: InMemoryDraftStore
  executor: IToolExecutor
  ttsLog: string[]
} {
  const bus = overrides.bus instanceof InMemoryBus ? overrides.bus : new InMemoryBus()
  const draftStore = overrides.draftStore ?? new InMemoryDraftStore({ bus })
  const executor = overrides.executor ?? createMockExecutor()
  const ttsLog: string[] = []

  const agent = new InteractionAgent({
    bus,
    llm: overrides.llm ?? createMockLLM(),
    contextStore: new InMemoryContextStore(),
    toolRegistry: overrides.toolRegistry ?? new Map(),
    executor,
    safetyGuard: new SafetyGuard({ toolConfigs: [] }),
    draftStore,
    ttsCallback: (text, _sid) => ttsLog.push(text),
    ...overrides,
  })

  return { agent, bus, draftStore, executor, ttsLog }
}

// ── Tests ────────────────────────────────────────────────────────────────────

describe('Draft Flow (Sprint 3.2)', () => {
  // ── parseDraftIntent ──────────────────────────────────────────────

  describe('parseDraftIntent', () => {
    let agent: InteractionAgent

    beforeEach(() => {
      const { agent: a } = createDraftAgent()
      agent = a
    })

    it('detects confirm intents', () => {
      expect(agent.parseDraftIntent('sí')).toBe('confirm')
      expect(agent.parseDraftIntent('dale')).toBe('confirm')
      expect(agent.parseDraftIntent('confirma')).toBe('confirm')
      expect(agent.parseDraftIntent('ok')).toBe('confirm')
      expect(agent.parseDraftIntent('listo')).toBe('confirm')
      expect(agent.parseDraftIntent('perfecto')).toBe('confirm')
      expect(agent.parseDraftIntent('yes')).toBe('confirm')
      expect(agent.parseDraftIntent('está bien')).toBe('confirm')
    })

    it('detects cancel intents', () => {
      expect(agent.parseDraftIntent('no')).toBe('cancel')
      expect(agent.parseDraftIntent('cancela')).toBe('cancel')
      expect(agent.parseDraftIntent('olvídalo')).toBe('cancel')
      expect(agent.parseDraftIntent('dejalo')).toBe('cancel')
      expect(agent.parseDraftIntent('nada')).toBe('cancel')
      expect(agent.parseDraftIntent('mejor no')).toBe('cancel')
    })

    it('detects modify intents', () => {
      expect(agent.parseDraftIntent('mejor en azul')).toBe('modify')
      expect(agent.parseDraftIntent('cambia el color')).toBe('modify')
      expect(agent.parseDraftIntent('quiero otra talla')).toBe('modify')
      expect(agent.parseDraftIntent('en vez de rojo')).toBe('modify')
      expect(agent.parseDraftIntent('diferente tamaño')).toBe('modify')
    })

    it('returns unknown for ambiguous text', () => {
      expect(agent.parseDraftIntent('¿cuánto cuesta?')).toBe('unknown')
      expect(agent.parseDraftIntent('hmm no sé')).toBe('unknown')
    })
  })

  // ── crear → confirmar ────────────────────────────────────────────

  describe('crear → confirmar', () => {
    it('confirms draft and executes the real action', async () => {
      const executor = createMockExecutor({ order_create: { order_id: 'ORD-001' } })
      const { agent, draftStore, ttsLog } = createDraftAgent({ executor })

      // Create a draft
      const draftId = await draftStore.create('session-1', {
        intent_id: 'order_create',
        items: { product: 'shirt', color: 'red', size: 'M' },
      })

      // Confirm
      const result = await agent.handleDraftFlow('session-1', 'dale')

      expect(result.type).toBe('confirmed')
      if (result.type === 'confirmed') {
        expect(result.draftId).toBe(draftId)
      }
      expect(executor.execute).toHaveBeenCalledWith('order_create', {
        product: 'shirt',
        color: 'red',
        size: 'M',
      })
      expect(ttsLog).toContain('Listo, orden confirmada.')
    })
  })

  // ── crear → modificar color → confirmar ──────────────────────────

  describe('crear → modificar → confirmar', () => {
    it('modifies draft then confirms', async () => {
      const llm = createChangesLLM({ color: 'azul' })
      const executor = createMockExecutor({ order_create: { order_id: 'ORD-002' } })
      const { agent, draftStore, ttsLog } = createDraftAgent({ llm, executor })

      // Create a draft
      await draftStore.create('session-1', {
        intent_id: 'order_create',
        items: { product: 'shirt', color: 'red', size: 'M' },
      })

      // Modify: "mejor en azul"
      const modResult = await agent.handleDraftFlow('session-1', 'mejor en azul')
      expect(modResult.type).toBe('modified')
      if (modResult.type === 'modified') {
        expect(modResult.changes).toEqual({ color: 'azul' })
      }

      // Verify TTS re-presents the draft
      expect(ttsLog.some((t) => t.includes('Actualizado'))).toBe(true)

      // Check draft was actually updated
      const draft = await draftStore.getBySession('session-1')
      expect(draft?.items.color).toBe('azul')

      // Now confirm
      const confirmResult = await agent.handleDraftFlow('session-1', 'sí')
      expect(confirmResult.type).toBe('confirmed')
      expect(executor.execute).toHaveBeenCalledWith('order_create', {
        product: 'shirt',
        color: 'azul',
        size: 'M',
      })
    })
  })

  // ── crear → modificar N veces → cancelar ─────────────────────────

  describe('crear → modificar N veces → cancelar', () => {
    it('modifies multiple times then cancels', async () => {
      const bus = new InMemoryBus()
      const draftStore = new InMemoryDraftStore({ bus })

      // Track LLM calls to return different changes each time
      let callCount = 0
      const changeResults: Record<string, unknown>[] = [
        { color: 'azul' },
        { size: 'L' },
        { product: 'pants' },
      ]

      const llm: IStreamingLLM = {
        async *stream() {
          const changes = changeResults[callCount++] ?? {}
          yield { type: 'text', text: JSON.stringify(changes) } as LLMStreamChunk
          yield { type: 'end', stop_reason: 'end_turn' } as LLMStreamChunk
        },
      }

      const { agent, ttsLog } = createDraftAgent({ bus, draftStore, llm })

      // Create
      await draftStore.create('session-1', {
        intent_id: 'order_create',
        items: { product: 'shirt', color: 'red', size: 'M' },
      })

      // Modify 3 times
      await agent.handleDraftFlow('session-1', 'mejor en azul')
      await agent.handleDraftFlow('session-1', 'cambia a talla L')
      await agent.handleDraftFlow('session-1', 'en vez de camisa, pantalón')

      // Check final state
      const draft = await draftStore.getBySession('session-1')
      expect(draft?.items.product).toBe('pants')
      expect(draft?.items.color).toBe('azul')
      expect(draft?.items.size).toBe('L')

      // Cancel
      const result = await agent.handleDraftFlow('session-1', 'cancelar')
      expect(result.type).toBe('cancelled')
      expect(ttsLog).toContain('Orden cancelada.')

      // Draft should be gone
      const afterCancel = await draftStore.getBySession('session-1')
      expect(afterCancel).toBeNull()
    })
  })

  // ── TTL expiry → notificación ────────────────────────────────────

  describe('TTL expiry notification', () => {
    it('notifies client via TTS when draft expires', async () => {
      const { agent, bus, ttsLog } = createDraftAgent()

      // Subscribe to draft expiry
      const unsub = agent.subscribeDraftExpiry()

      // Simulate TTL expiry event from DraftStore
      await bus.publish('bus:DRAFT_CANCELLED', {
        event: 'DRAFT_CANCELLED',
        draft_id: 'draft_123',
        session_id: 'session-1',
        reason: 'ttl_expired',
      })

      expect(ttsLog).toContain('Tu orden ha expirado por inactividad.')

      unsub()
    })

    it('does not notify on user-initiated cancel', async () => {
      const { agent, bus, ttsLog } = createDraftAgent()
      const unsub = agent.subscribeDraftExpiry()

      await bus.publish('bus:DRAFT_CANCELLED', {
        event: 'DRAFT_CANCELLED',
        draft_id: 'draft_456',
        session_id: 'session-1',
        reason: 'cancelled_by_user',
      })

      expect(ttsLog).not.toContain('Tu orden ha expirado por inactividad.')
      unsub()
    })
  })

  // ── no_draft handling ────────────────────────────────────────────

  describe('no draft edge cases', () => {
    it('returns no_draft when draftStore not available', async () => {
      const { agent: _agentNoDraft } = createDraftAgent({ draftStore: undefined as any })

      // Create agent without draft store
      const bus = new InMemoryBus()
      const agentWithout = new InteractionAgent({
        bus,
        llm: createMockLLM(),
        contextStore: new InMemoryContextStore(),
        toolRegistry: new Map(),
        executor: createMockExecutor(),
        safetyGuard: new SafetyGuard({ toolConfigs: [] }),
        // no draftStore
      })

      const result = await agentWithout.handleDraftFlow('session-1', 'sí')
      expect(result.type).toBe('no_draft')
    })

    it('returns no_draft when no draft for session', async () => {
      const { agent } = createDraftAgent()

      const result = await agent.handleDraftFlow('session-1', 'sí')
      expect(result.type).toBe('no_draft')
    })
  })

  // ── unknown intent ───────────────────────────────────────────────

  describe('unknown intent during draft', () => {
    it('returns unknown_intent for off-topic text', async () => {
      const { agent, draftStore } = createDraftAgent()

      await draftStore.create('session-1', {
        intent_id: 'order_create',
        items: { product: 'shirt' },
      })

      const result = await agent.handleDraftFlow('session-1', '¿cuánto es el envío?')
      expect(result.type).toBe('unknown_intent')
    })
  })

  // ── Executor error on confirm ────────────────────────────────────

  describe('executor error on confirm', () => {
    it('notifies via TTS when executor fails', async () => {
      const executor: IToolExecutor = {
        execute: vi.fn().mockRejectedValue(new Error('DB connection lost')),
      }

      const { agent, draftStore, ttsLog } = createDraftAgent({ executor })

      await draftStore.create('session-1', {
        intent_id: 'order_create',
        items: { product: 'shirt' },
      })

      const result = await agent.handleDraftFlow('session-1', 'sí')
      expect(result.type).toBe('confirmed')
      expect(ttsLog.some((t) => t.includes('error'))).toBe(true)
    })
  })
})
