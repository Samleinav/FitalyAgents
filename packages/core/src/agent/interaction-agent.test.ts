import { describe, it, expect, vi } from 'vitest'
import { InteractionAgent } from './interaction-agent.js'
import type {
  IStreamingLLM,
  LLMStreamChunk,
  InteractionToolDef,
  IToolExecutor,
  ISpeculativeCache,
  InteractionAgentDeps,
} from './interaction-agent.js'
import { InMemoryBus } from '../bus/in-memory-bus.js'
import { InMemoryContextStore } from '../context/in-memory-context-store.js'
import { SafetyGuard } from '../safety/safety-guard.js'
import { InMemoryDraftStore } from '../safety/draft-store.js'
import type { ApprovalOrchestrator } from '../safety/approval-orchestrator.js'

// ── Helpers ──────────────────────────────────────────────────────────────────

function createMockLLM(chunks: LLMStreamChunk[]): IStreamingLLM {
  return {
    async *stream() {
      for (const chunk of chunks) {
        yield chunk
      }
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

function createMockCache(
  entries: Record<string, { type: string; result?: unknown; draftId?: string }> = {},
): ISpeculativeCache {
  return {
    get: vi.fn((_sessionId: string, intentId: string) => entries[intentId] ?? null),
    invalidate: vi.fn(),
  }
}

function buildTools(
  ...defs: Array<{ id: string; safety: InteractionToolDef['safety']; prompt?: string }>
): Map<string, InteractionToolDef> {
  const map = new Map<string, InteractionToolDef>()
  for (const d of defs) {
    map.set(d.id, {
      tool_id: d.id,
      description: `Tool ${d.id}`,
      safety: d.safety,
      confirm_prompt: d.prompt,
    })
  }
  return map
}

function createAgent(overrides: Partial<InteractionAgentDeps> = {}): {
  agent: InteractionAgent
  bus: InMemoryBus
  contextStore: InMemoryContextStore
  executor: IToolExecutor
  ttsLog: string[]
} {
  const bus = new InMemoryBus()
  const contextStore = new InMemoryContextStore()
  const executor = overrides.executor ?? createMockExecutor()
  const ttsLog: string[] = []
  const safetyGuard = new SafetyGuard({ toolConfigs: [] })

  const agent = new InteractionAgent({
    bus,
    llm: overrides.llm ?? createMockLLM([]),
    contextStore,
    toolRegistry: overrides.toolRegistry ?? new Map(),
    executor,
    safetyGuard,
    ttsCallback: (text, _sid) => ttsLog.push(text),
    ...overrides,
  })

  return { agent, bus, contextStore, executor, ttsLog }
}

// ── Tests ────────────────────────────────────────────────────────────────────

describe('InteractionAgent', () => {
  // ── Text streaming ─────────────────────────────────────────────────

  describe('text streaming', () => {
    it('streams text chunks to ttsCallback', async () => {
      const llm = createMockLLM([
        { type: 'text', text: 'Hola, ' },
        { type: 'text', text: '¿en qué puedo ayudarte?' },
        { type: 'end', stop_reason: 'end_turn' },
      ])

      const { agent, ttsLog } = createAgent({ llm })

      const result = await agent.handleSpeechFinal({
        session_id: 'session-1',
        text: 'hola',
      })

      expect(result.textChunks).toEqual(['Hola, ', '¿en qué puedo ayudarte?'])
      expect(ttsLog).toEqual(['Hola, ', '¿en qué puedo ayudarte?'])
    })

    it('publishes response lifecycle and avatar speech events', async () => {
      const llm = createMockLLM([
        { type: 'text', text: 'Hello, ' },
        { type: 'text', text: 'how can I help?' },
        { type: 'end', stop_reason: 'end_turn' },
      ])
      const { agent, bus, ttsLog } = createAgent({ llm })
      const events: Array<{ channel: string; payload: unknown }> = []

      for (const channel of ['bus:RESPONSE_START', 'bus:AVATAR_SPEAK', 'bus:RESPONSE_END']) {
        bus.subscribe(channel, (payload) => events.push({ channel, payload }))
      }

      await agent.handleSpeechFinal({
        session_id: 'session-1',
        speaker_id: 'cust_ana',
        text: 'hello',
      })

      expect(ttsLog).toEqual(['Hello, ', 'how can I help?'])
      expect(events.map((event) => event.channel)).toEqual([
        'bus:RESPONSE_START',
        'bus:AVATAR_SPEAK',
        'bus:AVATAR_SPEAK',
        'bus:AVATAR_SPEAK',
        'bus:RESPONSE_END',
      ])

      const responseStart = events[0]?.payload as { turn_id: string; speaker_id?: string }
      const firstSpeech = events[1]?.payload as { turn_id: string; text: string; is_final: boolean }
      const finalSpeech = events[3]?.payload as { turn_id: string; text: string; is_final: boolean }
      const responseEnd = events[4]?.payload as { turn_id: string; reason: string }

      expect(responseStart.speaker_id).toBe('cust_ana')
      expect(firstSpeech).toMatchObject({
        turn_id: responseStart.turn_id,
        text: 'Hello, ',
        is_final: false,
      })
      expect(finalSpeech).toMatchObject({
        turn_id: responseStart.turn_id,
        text: '',
        is_final: true,
      })
      expect(responseEnd).toMatchObject({
        turn_id: responseStart.turn_id,
        reason: 'end_turn',
      })
    })

    it('publishes RESPONSE_END with error reason when streaming fails', async () => {
      const llm: IStreamingLLM = {
        async *stream() {
          yield { type: 'text', text: 'partial' } satisfies LLMStreamChunk
          throw new Error('stream failed')
        },
      }
      const { agent, bus } = createAgent({ llm })
      const responseEndEvents: unknown[] = []
      bus.subscribe('bus:RESPONSE_END', (payload) => responseEndEvents.push(payload))

      await expect(
        agent.handleSpeechFinal({
          session_id: 'session-1',
          text: 'hello',
        }),
      ).rejects.toThrow('stream failed')

      expect(responseEndEvents).toHaveLength(1)
      expect(responseEndEvents[0]).toMatchObject({
        event: 'RESPONSE_END',
        session_id: 'session-1',
        reason: 'error',
      })
    })

    it('stores response in context store', async () => {
      const llm = createMockLLM([
        { type: 'text', text: 'Response text' },
        { type: 'end', stop_reason: 'end_turn' },
      ])

      const { agent, contextStore } = createAgent({ llm })

      await agent.handleSpeechFinal({
        session_id: 'session-1',
        text: 'query',
      })

      const lastResponse = await contextStore.get<string>('session-1', 'last_response')
      expect(lastResponse).toBe('Response text')

      const lastUserText = await contextStore.get<string>('session-1', 'last_user_text')
      expect(lastUserText).toBe('query')
    })
  })

  // ── SAFE tool ──────────────────────────────────────────────────────

  describe('SAFE tool', () => {
    it('executes SAFE tool directly via executor', async () => {
      const executor = createMockExecutor({ product_search: { products: ['Nike Air'] } })
      const llm = createMockLLM([
        { type: 'tool_call', id: 'tc_1', name: 'product_search', input: { query: 'Nike' } },
        { type: 'end', stop_reason: 'tool_use' },
      ])

      const { agent } = createAgent({
        llm,
        executor,
        toolRegistry: buildTools({ id: 'product_search', safety: 'safe' }),
      })

      const result = await agent.handleSpeechFinal({
        session_id: 'session-1',
        text: 'busco tenis nike',
      })

      expect(result.toolResults).toHaveLength(1)
      expect(result.toolResults[0].type).toBe('executed')
      if (result.toolResults[0].type === 'executed') {
        expect(result.toolResults[0].result).toEqual({ products: ['Nike Air'] })
      }
      expect(executor.execute).toHaveBeenCalledWith('product_search', { query: 'Nike' })
    })

    it('uses cached result from speculative cache', async () => {
      const executor = createMockExecutor()
      const cache = createMockCache({
        product_search: { type: 'tool_result', result: { products: ['Cached Nike'] } },
      })

      const llm = createMockLLM([
        { type: 'tool_call', id: 'tc_1', name: 'product_search', input: { query: 'Nike' } },
        { type: 'end', stop_reason: 'tool_use' },
      ])

      const { agent } = createAgent({
        llm,
        executor,
        speculativeCache: cache,
        toolRegistry: buildTools({ id: 'product_search', safety: 'safe' }),
      })

      const result = await agent.handleSpeechFinal({
        session_id: 'session-1',
        text: 'busco tenis nike',
      })

      expect(result.toolResults[0].type).toBe('cached')
      if (result.toolResults[0].type === 'cached') {
        expect(result.toolResults[0].result).toEqual({ products: ['Cached Nike'] })
      }
      // Executor should NOT have been called
      expect(executor.execute).not.toHaveBeenCalled()
    })

    it('invalidates speculative cache at end of turn', async () => {
      const cache = createMockCache()
      const llm = createMockLLM([
        { type: 'text', text: 'Hello' },
        { type: 'end', stop_reason: 'end_turn' },
      ])

      const { agent } = createAgent({ llm, speculativeCache: cache })

      await agent.handleSpeechFinal({
        session_id: 'session-1',
        text: 'hello',
      })

      expect(cache.invalidate).toHaveBeenCalledWith('session-1')
    })
  })

  // ── STAGED tool ────────────────────────────────────────────────────

  describe('STAGED tool', () => {
    it('creates a draft and returns draft_ready', async () => {
      const bus = new InMemoryBus()
      const draftStore = new InMemoryDraftStore({ bus })

      const llm = createMockLLM([
        { type: 'tool_call', id: 'tc_1', name: 'order_create', input: { items: ['shirt'] } },
        { type: 'end', stop_reason: 'tool_use' },
      ])

      const { agent } = createAgent({
        llm,
        bus,
        draftStore,
        toolRegistry: buildTools({ id: 'order_create', safety: 'staged' }),
      })

      const result = await agent.handleSpeechFinal({
        session_id: 'session-1',
        text: 'quiero comprar una camisa',
      })

      expect(result.toolResults).toHaveLength(1)
      expect(result.toolResults[0].type).toBe('draft_ready')
      if (result.toolResults[0].type === 'draft_ready') {
        expect(result.toolResults[0].needs_confirmation).toBe(true)
        expect(result.toolResults[0].draftId).toBeTruthy()
      }
    })

    it('uses pre-created draft from speculative cache', async () => {
      const bus = new InMemoryBus()
      const draftStore = new InMemoryDraftStore({ bus })
      const cache = createMockCache({
        order_create: { type: 'draft_ref', draftId: 'pre_draft_001' },
      })

      const llm = createMockLLM([
        { type: 'tool_call', id: 'tc_1', name: 'order_create', input: { items: ['shirt'] } },
        { type: 'end', stop_reason: 'tool_use' },
      ])

      const { agent } = createAgent({
        llm,
        bus,
        draftStore,
        speculativeCache: cache,
        toolRegistry: buildTools({ id: 'order_create', safety: 'staged' }),
      })

      const result = await agent.handleSpeechFinal({
        session_id: 'session-1',
        text: 'quiero comprar una camisa',
      })

      expect(result.toolResults[0].type).toBe('draft_ready')
      if (result.toolResults[0].type === 'draft_ready') {
        expect(result.toolResults[0].draftId).toBe('pre_draft_001')
      }
    })

    it('returns error if draftStore not available', async () => {
      const llm = createMockLLM([
        { type: 'tool_call', id: 'tc_1', name: 'order_create', input: {} },
        { type: 'end', stop_reason: 'tool_use' },
      ])

      const { agent } = createAgent({
        llm,
        draftStore: undefined,
        toolRegistry: buildTools({ id: 'order_create', safety: 'staged' }),
      })

      const result = await agent.handleSpeechFinal({
        session_id: 'session-1',
        text: 'quiero comprar',
      })

      expect(result.toolResults[0].type).toBe('error')
    })
  })

  // ── PROTECTED tool ─────────────────────────────────────────────────

  describe('PROTECTED tool', () => {
    it('returns needs_confirmation with prompt', async () => {
      const llm = createMockLLM([
        { type: 'tool_call', id: 'tc_1', name: 'price_override', input: { amount: 50 } },
        { type: 'end', stop_reason: 'tool_use' },
      ])

      const { agent } = createAgent({
        llm,
        toolRegistry: buildTools({
          id: 'price_override',
          safety: 'protected',
          prompt: '¿Confirma el cambio de precio?',
        }),
      })

      const result = await agent.handleSpeechFinal({
        session_id: 'session-1',
        text: 'cambia el precio',
      })

      expect(result.toolResults).toHaveLength(1)
      expect(result.toolResults[0].type).toBe('needs_confirmation')
      if (result.toolResults[0].type === 'needs_confirmation') {
        expect(result.toolResults[0].prompt).toBe('¿Confirma el cambio de precio?')
      }
    })

    it('uses default prompt when confirm_prompt not set', async () => {
      const llm = createMockLLM([
        { type: 'tool_call', id: 'tc_1', name: 'price_override', input: {} },
        { type: 'end', stop_reason: 'tool_use' },
      ])

      const { agent } = createAgent({
        llm,
        toolRegistry: buildTools({ id: 'price_override', safety: 'protected' }),
      })

      const result = await agent.handleSpeechFinal({
        session_id: 'session-1',
        text: 'cambia el precio',
      })

      if (result.toolResults[0].type === 'needs_confirmation') {
        expect(result.toolResults[0].prompt).toContain('price_override')
      }
    })
  })

  // ── Dynamic SafetyGuard ───────────────────────────────────────────

  describe('Dynamic SafetyGuard', () => {
    it('can lower a protected tool to safe for a contextual evaluation', async () => {
      const executor = createMockExecutor({
        payment_process: { charged: true },
      })
      const safetyGuard = new SafetyGuard({
        toolConfigs: [{ name: 'payment_process', safety: 'protected' }],
        contextualResolver: ({ context }) => {
          if (context?.customer_tier === 'vip') return 'safe'
          return null
        },
      })
      const llm = createMockLLM([
        { type: 'tool_call', id: 'tc_1', name: 'payment_process', input: { amount: 100 } },
        { type: 'end', stop_reason: 'tool_use' },
      ])

      const { agent, contextStore } = createAgent({
        llm,
        executor,
        safetyGuard,
        toolRegistry: buildTools({ id: 'payment_process', safety: 'protected' }),
      })
      await contextStore.set('session-1', 'customer_tier', 'vip')

      const result = await agent.handleSpeechFinal({
        session_id: 'session-1',
        text: 'charge it',
        speaker_id: 'customer_1',
        role: 'customer',
      })

      expect(result.toolResults[0]).toEqual({
        type: 'executed',
        toolId: 'payment_process',
        result: { charged: true },
      })
      expect(executor.execute).toHaveBeenCalledWith('payment_process', { amount: 100 })
    })

    it('can raise a safe tool to protected from session context', async () => {
      const executor = createMockExecutor()
      const safetyGuard = new SafetyGuard({
        toolConfigs: [{ name: 'product_search', safety: 'safe' }],
        contextualResolver: ({ context }) => {
          if (context?.sentiment_alert_level === 'frustrated') return 'protected'
          return null
        },
      })
      const llm = createMockLLM([
        { type: 'tool_call', id: 'tc_1', name: 'product_search', input: { q: 'shoes' } },
        { type: 'end', stop_reason: 'tool_use' },
      ])

      const { agent, contextStore } = createAgent({
        llm,
        executor,
        safetyGuard,
        toolRegistry: buildTools({ id: 'product_search', safety: 'safe' }),
      })
      await contextStore.set('session-1', 'sentiment_alert_level', 'frustrated')

      const result = await agent.handleSpeechFinal({
        session_id: 'session-1',
        text: 'find shoes',
        speaker_id: 'customer_1',
      })

      expect(result.toolResults[0].type).toBe('needs_confirmation')
      expect(executor.execute).not.toHaveBeenCalled()
    })

    it('uses the configured approval strategy from SafetyGuard decisions', async () => {
      const mockOrchestrator = {
        orchestrate: vi.fn().mockResolvedValue({
          approved: true,
          approver_id: 'manager_1',
          channel_used: 'webhook',
          timestamp: Date.now(),
        }),
      }
      const safetyGuard = new SafetyGuard({
        toolConfigs: [
          {
            name: 'refund_create',
            safety: 'restricted',
            required_role: 'manager',
            approval_channels: [{ type: 'webhook', timeout_ms: 30_000 }],
            approval_strategy: 'parallel',
          },
        ],
      })
      const llm = createMockLLM([
        { type: 'tool_call', id: 'tc_1', name: 'refund_create', input: { amount: 100 } },
        { type: 'end', stop_reason: 'tool_use' },
      ])

      const { agent } = createAgent({
        llm,
        safetyGuard,
        approvalOrchestrator: mockOrchestrator as unknown as ApprovalOrchestrator,
        toolRegistry: buildTools({ id: 'refund_create', safety: 'restricted' }),
      })

      await agent.handleSpeechFinal({
        session_id: 'session-1',
        text: 'refund this',
        speaker_id: 'customer_1',
        role: 'customer',
      })

      expect(mockOrchestrator.orchestrate).toHaveBeenCalledWith(
        expect.any(Object),
        [{ type: 'webhook', timeout_ms: 30_000 }],
        'parallel',
        expect.any(Object),
      )
    })
  })

  // ── RESTRICTED tool ────────────────────────────────────────────────

  describe('RESTRICTED tool', () => {
    it('returns error if approvalOrchestrator not available', async () => {
      const llm = createMockLLM([
        { type: 'tool_call', id: 'tc_1', name: 'refund_create', input: { amount: 100 } },
        { type: 'end', stop_reason: 'tool_use' },
      ])

      const { agent } = createAgent({
        llm,
        approvalOrchestrator: undefined,
        toolRegistry: buildTools({ id: 'refund_create', safety: 'restricted' }),
      })

      const result = await agent.handleSpeechFinal({
        session_id: 'session-1',
        text: 'quiero un reembolso',
      })

      expect(result.toolResults[0].type).toBe('error')
    })

    it('sends TTS notification while waiting for approval', async () => {
      // Create a mock orchestrator that resolves immediately
      const mockOrchestrator = {
        orchestrate: vi.fn().mockResolvedValue({ approved: true, reason: 'ok', channel: 'voice' }),
      }

      const llm = createMockLLM([
        { type: 'tool_call', id: 'tc_1', name: 'refund_create', input: { amount: 100 } },
        { type: 'end', stop_reason: 'tool_use' },
      ])

      const { agent, ttsLog } = createAgent({
        llm,
        approvalOrchestrator: mockOrchestrator as unknown as ApprovalOrchestrator,
        toolRegistry: buildTools({ id: 'refund_create', safety: 'restricted' }),
      })

      const result = await agent.handleSpeechFinal({
        session_id: 'session-1',
        text: 'quiero un reembolso',
        speaker_id: 'customer_1',
      })

      expect(ttsLog).toContain('Un momento, necesito autorización para esta acción.')
      expect(result.toolResults[0].type).toBe('pending_approval')
      if (result.toolResults[0].type === 'pending_approval') {
        expect(result.toolResults[0].approved).toBe(true)
      }
    })
  })

  // ── Unknown tool ───────────────────────────────────────────────────

  describe('unknown tool', () => {
    it('returns error for unregistered tool', async () => {
      const llm = createMockLLM([
        { type: 'tool_call', id: 'tc_1', name: 'unknown_tool', input: {} },
        { type: 'end', stop_reason: 'tool_use' },
      ])

      const { agent } = createAgent({ llm })

      const result = await agent.handleSpeechFinal({
        session_id: 'session-1',
        text: 'do something',
      })

      expect(result.toolResults[0].type).toBe('error')
      if (result.toolResults[0].type === 'error') {
        expect(result.toolResults[0].error).toContain('Unknown tool')
      }
    })
  })

  // ── Context building ──────────────────────────────────────────────

  describe('context building', () => {
    it('includes conversation history from previous turn', async () => {
      const contextStore = new InMemoryContextStore()
      await contextStore.set('session-1', 'last_user_text', '¿tienes tenis?')
      await contextStore.set('session-1', 'last_response', 'Sí, tenemos varias opciones.')

      let capturedMessages: unknown[] = []
      const llm: IStreamingLLM = {
        async *stream(params) {
          capturedMessages = params.messages
          yield { type: 'text', text: 'response' } as LLMStreamChunk
          yield { type: 'end', stop_reason: 'end_turn' } as LLMStreamChunk
        },
      }

      const { agent } = createAgent({ llm, contextStore })

      await agent.handleSpeechFinal({
        session_id: 'session-1',
        text: 'muéstrame los Nike',
      })

      // Should have: prev user, prev assistant, current user
      expect(capturedMessages).toHaveLength(3)
      expect((capturedMessages[0] as any).role).toBe('user')
      expect((capturedMessages[0] as any).content).toBe('¿tienes tenis?')
      expect((capturedMessages[1] as any).role).toBe('assistant')
      expect((capturedMessages[2] as any).role).toBe('user')
      expect((capturedMessages[2] as any).content).toBe('muéstrame los Nike')
    })

    it('sends only current message when no history', async () => {
      let capturedMessages: unknown[] = []
      const llm: IStreamingLLM = {
        async *stream(params) {
          capturedMessages = params.messages
          yield { type: 'end', stop_reason: 'end_turn' } as LLMStreamChunk
        },
      }

      const { agent } = createAgent({ llm })

      await agent.handleSpeechFinal({
        session_id: 'session-1',
        text: 'hola',
      })

      expect(capturedMessages).toHaveLength(1)
    })
  })

  // ── Bus events ─────────────────────────────────────────────────────

  describe('bus events', () => {
    it('publishes ACTION_COMPLETED after handling', async () => {
      const bus = new InMemoryBus()
      const events: unknown[] = []
      bus.subscribe('bus:ACTION_COMPLETED', (data) => events.push(data))

      const llm = createMockLLM([
        { type: 'text', text: 'Hello' },
        { type: 'end', stop_reason: 'end_turn' },
      ])

      const { agent } = createAgent({ llm, bus })

      await agent.handleSpeechFinal({
        session_id: 'session-1',
        text: 'hi',
      })

      expect(events).toHaveLength(1)
      expect(events[0]).toHaveProperty('event', 'ACTION_COMPLETED')
      expect(events[0]).toHaveProperty('agent_id', 'InteractionAgent')
    })
  })

  // ── Mixed chunks (text + tool_call) ────────────────────────────────

  describe('mixed text and tool calls', () => {
    it('handles interleaved text and tool calls', async () => {
      const executor = createMockExecutor({ product_search: { products: ['Nike'] } })
      const llm = createMockLLM([
        { type: 'text', text: 'Déjame buscar eso.' },
        { type: 'tool_call', id: 'tc_1', name: 'product_search', input: { q: 'Nike' } },
        { type: 'text', text: ' Encontré resultados.' },
        { type: 'end', stop_reason: 'end_turn' },
      ])

      const { agent, ttsLog } = createAgent({
        llm,
        executor,
        toolRegistry: buildTools({ id: 'product_search', safety: 'safe' }),
      })

      const result = await agent.handleSpeechFinal({
        session_id: 'session-1',
        text: 'busco Nike',
      })

      expect(result.textChunks).toEqual(['Déjame buscar eso.', ' Encontré resultados.'])
      expect(result.toolResults).toHaveLength(1)
      expect(result.toolResults[0].type).toBe('executed')
      expect(ttsLog).toHaveLength(2)
    })
  })

  // ── Executor error ─────────────────────────────────────────────────

  describe('executor error', () => {
    it('returns error when executor throws', async () => {
      const executor: IToolExecutor = {
        execute: vi.fn().mockRejectedValue(new Error('Connection refused')),
      }

      const llm = createMockLLM([
        { type: 'tool_call', id: 'tc_1', name: 'product_search', input: {} },
        { type: 'end', stop_reason: 'tool_use' },
      ])

      const { agent } = createAgent({
        llm,
        executor,
        toolRegistry: buildTools({ id: 'product_search', safety: 'safe' }),
      })

      const result = await agent.handleSpeechFinal({
        session_id: 'session-1',
        text: 'busco zapatos',
      })

      expect(result.toolResults[0].type).toBe('error')
      if (result.toolResults[0].type === 'error') {
        expect(result.toolResults[0].error).toContain('Connection refused')
      }
    })
  })

  // ── PAUSE/RESUME (Sprint E1.2) ──────────────────────────────────

  describe('PAUSE/RESUME', () => {
    it('handleSpeechFinal works normally when not paused', async () => {
      const llm = createMockLLM([
        { type: 'text', text: 'Hola' },
        { type: 'end', stop_reason: 'end_turn' },
      ])

      const { agent, bus: _bus } = createAgent({ llm })
      agent.subscribePauseResume()

      const result = await agent.handleSpeechFinal({
        session_id: 'session-1',
        text: 'hola',
      })

      expect(result.textChunks).toEqual(['Hola'])
      expect(result.traceId).not.toBe('paused')
    })

    it('INTERACTION_PAUSE → handleSpeechFinal returns early', async () => {
      const llm = createMockLLM([
        { type: 'text', text: 'This should NOT appear' },
        { type: 'end', stop_reason: 'end_turn' },
      ])

      const { agent, bus, ttsLog } = createAgent({ llm })
      agent.subscribePauseResume()

      // Pause the session
      await bus.publish('bus:INTERACTION_PAUSE', {
        event: 'INTERACTION_PAUSE',
        session_id: 'session-1',
        reason: 'staff_override',
        staff_id: 'spk_cashier',
      })

      const result = await agent.handleSpeechFinal({
        session_id: 'session-1',
        text: 'quiero comprar tenis',
      })

      expect(result.textChunks).toEqual([])
      expect(result.toolResults).toEqual([])
      expect(result.traceId).toBe('paused')
      expect(ttsLog).toHaveLength(0)
      expect(agent.isSessionPaused('session-1')).toBe(true)
    })

    it('INTERACTION_RESUME → handleSpeechFinal works again', async () => {
      const llm = createMockLLM([
        { type: 'text', text: 'Bienvenido de vuelta' },
        { type: 'end', stop_reason: 'end_turn' },
      ])

      const { agent, bus, ttsLog } = createAgent({ llm })
      agent.subscribePauseResume()

      // Pause
      await bus.publish('bus:INTERACTION_PAUSE', {
        event: 'INTERACTION_PAUSE',
        session_id: 'session-1',
        reason: 'staff_override',
        staff_id: 'spk_cashier',
      })

      expect(agent.isSessionPaused('session-1')).toBe(true)

      // Resume
      await bus.publish('bus:INTERACTION_RESUME', {
        event: 'INTERACTION_RESUME',
        session_id: 'session-1',
      })

      expect(agent.isSessionPaused('session-1')).toBe(false)

      const result = await agent.handleSpeechFinal({
        session_id: 'session-1',
        text: '¿qué me decías?',
      })

      expect(result.textChunks).toEqual(['Bienvenido de vuelta'])
      expect(result.traceId).not.toBe('paused')
      expect(ttsLog).toHaveLength(1)
    })

    it('SESSION_RESUMED also unpauses the session', async () => {
      const llm = createMockLLM([
        { type: 'text', text: 'Back online' },
        { type: 'end', stop_reason: 'end_turn' },
      ])

      const { agent, bus } = createAgent({ llm })
      agent.subscribePauseResume()

      await bus.publish('bus:INTERACTION_PAUSE', {
        event: 'INTERACTION_PAUSE',
        session_id: 'session-1',
        reason: 'staff_override',
        staff_id: 'spk_cashier',
      })
      expect(agent.isSessionPaused('session-1')).toBe(true)

      await bus.publish('bus:SESSION_RESUMED', {
        event: 'SESSION_RESUMED',
        session_id: 'session-1',
        resumed_by: 'manager_ana',
        resumed_by_role: 'manager',
        timestamp: Date.now(),
      })
      expect(agent.isSessionPaused('session-1')).toBe(false)

      const result = await agent.handleSpeechFinal({
        session_id: 'session-1',
        text: 'hello again',
      })

      expect(result.textChunks).toEqual(['Back online'])
    })

    it('pause of session A does NOT affect session B', async () => {
      const llm = createMockLLM([
        { type: 'text', text: 'Session B response' },
        { type: 'end', stop_reason: 'end_turn' },
      ])

      const { agent, bus } = createAgent({ llm })
      agent.subscribePauseResume()

      // Pause session A
      await bus.publish('bus:INTERACTION_PAUSE', {
        event: 'INTERACTION_PAUSE',
        session_id: 'session-A',
        reason: 'staff_override',
        staff_id: 'spk_cashier',
      })

      // Session A should be paused
      const resultA = await agent.handleSpeechFinal({
        session_id: 'session-A',
        text: 'hola',
      })
      expect(resultA.traceId).toBe('paused')

      // Session B should NOT be paused
      const resultB = await agent.handleSpeechFinal({
        session_id: 'session-B',
        text: 'hola',
      })
      expect(resultB.textChunks).toEqual(['Session B response'])
      expect(resultB.traceId).not.toBe('paused')
    })

    it('unsubscribe stops listening to pause/resume events', async () => {
      const llm = createMockLLM([
        { type: 'text', text: 'Working' },
        { type: 'end', stop_reason: 'end_turn' },
      ])

      const { agent, bus } = createAgent({ llm })
      const unsub = agent.subscribePauseResume()

      // Unsubscribe
      unsub()

      // Pause event should be ignored after unsubscribe
      await bus.publish('bus:INTERACTION_PAUSE', {
        event: 'INTERACTION_PAUSE',
        session_id: 'session-1',
        reason: 'staff_override',
        staff_id: 'spk_cashier',
      })

      expect(agent.isSessionPaused('session-1')).toBe(false)

      const result = await agent.handleSpeechFinal({
        session_id: 'session-1',
        text: 'hola',
      })
      expect(result.textChunks).toEqual(['Working'])
    })
  })
})
