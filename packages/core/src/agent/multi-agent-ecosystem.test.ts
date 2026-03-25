import { describe, it, expect, vi } from 'vitest'
import { InMemoryBus } from '../bus/in-memory-bus.js'
import { InMemoryContextStore } from '../context/in-memory-context-store.js'
import { InteractionAgent } from './interaction-agent.js'
import type { IStreamingLLM, InteractionToolDef, IToolExecutor } from './interaction-agent.js'
import { StaffAgent } from './staff-agent.js'
import { UIAgent } from './ui-agent.js'
import type { UIUpdatePayload } from './ui-agent.js'
import { AmbientAgent } from './ambient-agent.js'
import { SafetyGuard } from '../safety/safety-guard.js'
import { InMemoryDraftStore } from '../safety/draft-store.js'

// ── Mock Factories ───────────────────────────────────────────────────────────

function createMockLLM(
  response: string | (() => string) = 'Claro, te ayudo con eso.',
): IStreamingLLM {
  return {
    stream: async function* (_params) {
      const text = typeof response === 'function' ? response() : response
      yield { type: 'text' as const, text }
      yield { type: 'end' as const, stop_reason: 'end_turn' as const }
    },
  }
}

function createToolCallLLM(toolName: string, input: unknown): IStreamingLLM {
  return {
    stream: async function* (_params) {
      yield {
        type: 'tool_call' as const,
        id: 'tc_1',
        name: toolName,
        input,
      }
      yield { type: 'end' as const, stop_reason: 'tool_use' as const }
    },
  }
}

function createErrorLLM(): IStreamingLLM {
  return {
    stream: async function* (_params) {
      throw new Error('LLM service unavailable')
    },
  }
}

function createAmbientLLM(product: string | null): IStreamingLLM {
  return {
    stream: async function* (_params) {
      yield {
        type: 'text' as const,
        text: JSON.stringify({
          product,
          sentiment: product ? 'interested' : null,
          purchase_intent: product !== null,
          language: 'es',
        }),
      }
      yield { type: 'end' as const, stop_reason: 'end_turn' as const }
    },
  }
}

function createMockExecutor(): IToolExecutor {
  return {
    execute: vi.fn().mockResolvedValue({ success: true }),
  }
}

function defaultToolRegistry(): Map<string, InteractionToolDef> {
  const registry = new Map<string, InteractionToolDef>()
  registry.set('product_search', {
    tool_id: 'product_search',
    description: 'Search for products',
    safety: 'safe',
  })
  registry.set('apply_discount', {
    tool_id: 'apply_discount',
    description: 'Apply discount to order',
    safety: 'safe',
    input_schema: { type: 'object', properties: { percentage: { type: 'number' } } },
  })
  return registry
}

function createSafetyGuard(): SafetyGuard {
  return new SafetyGuard({
    toolConfigs: [
      { name: 'product_search', safety: 'safe' },
      {
        name: 'apply_discount',
        safety: 'safe',
      },
    ],
  })
}

// ── Full ecosystem setup ─────────────────────────────────────────────────────

interface EcosystemSetup {
  bus: InMemoryBus
  contextStore: InMemoryContextStore
  interactionAgent: InteractionAgent
  staffAgent: StaffAgent
  uiAgent: UIAgent
  ambientAgent: AmbientAgent
  uiUpdates: UIUpdatePayload[]
  ttsOutput: Array<{ text: string; sessionId: string }>
  executor: IToolExecutor
  draftStore: InMemoryDraftStore
}

function createEcosystem(opts?: {
  interactionLLM?: IStreamingLLM
  staffLLM?: IStreamingLLM
  ambientLLM?: IStreamingLLM
}): EcosystemSetup {
  const bus = new InMemoryBus()
  const contextStore = new InMemoryContextStore()
  const toolRegistry = defaultToolRegistry()
  const executor = createMockExecutor()
  const safetyGuard = createSafetyGuard()
  const draftStore = new InMemoryDraftStore({ bus })

  const ttsOutput: Array<{ text: string; sessionId: string }> = []
  const uiUpdates: UIUpdatePayload[] = []

  // ── InteractionAgent ──────────────────────────────────────────────
  const interactionAgent = new InteractionAgent({
    bus,
    llm: opts?.interactionLLM ?? createMockLLM(),
    contextStore,
    toolRegistry,
    executor,
    safetyGuard,
    draftStore,
    ttsCallback: (text, sessionId) => ttsOutput.push({ text, sessionId }),
  })

  // Subscribe to pause/resume
  interactionAgent.subscribePauseResume()

  // ── StaffAgent ────────────────────────────────────────────────────
  const staffAgent = new StaffAgent({
    bus,
    llm: opts?.staffLLM ?? createMockLLM(),
    safetyGuard,
    toolRegistry,
    executor,
    config: {
      autoResumeTimeoutMs: 60_000, // Long timeout to avoid interference
    },
  })

  // ── UIAgent ───────────────────────────────────────────────────────
  const uiAgent = new UIAgent({
    bus,
    onUpdate: (u) => uiUpdates.push(u),
  })

  // ── AmbientAgent ──────────────────────────────────────────────────
  const ambientAgent = new AmbientAgent({
    bus,
    llm: opts?.ambientLLM ?? createAmbientLLM(null),
    contextStore,
  })

  return {
    bus,
    contextStore,
    interactionAgent,
    staffAgent,
    uiAgent,
    ambientAgent,
    uiUpdates,
    ttsOutput,
    executor,
    draftStore,
  }
}

// ── Tests ────────────────────────────────────────────────────────────────────

describe('Multi-Agent Ecosystem Integration', () => {
  // ── Full scenario (Section 10 of PLAN-ECOSYSTEM) ──────────────────

  describe('complete scenario', () => {
    it('full customer → ambient → draft → staff → resume lifecycle', async () => {
      const staffToolLLM = createToolCallLLM('apply_discount', { percentage: 10 })

      const eco = createEcosystem({
        interactionLLM: createMockLLM('¡Hola! Bienvenido a la tienda.'),
        staffLLM: staffToolLLM,
        ambientLLM: createAmbientLLM('Nike Air 42'),
      })

      // Start stream agents
      await eco.staffAgent.start()
      await eco.uiAgent.start()
      await eco.ambientAgent.start()

      // 1. SPEECH_FINAL (TARGET) → InteractionAgent responds
      const result1 = await eco.interactionAgent.handleSpeechFinal({
        session_id: 'session-1',
        text: 'Hola, busco unos tenis',
        speaker_id: 'customer_1',
      })
      expect(result1.textChunks.join('')).toContain('Bienvenido')

      // 2. AMBIENT_CONTEXT → AmbientAgent enriches context
      await eco.ambientAgent.onEvent('bus:AMBIENT_CONTEXT', {
        event: 'AMBIENT_CONTEXT',
        session_id: 'session-1',
        speaker_id: 'customer_1',
        text: 'Esos Nike Air 42 se ven muy bien',
        timestamp: Date.now(),
      })

      const ambient = await eco.contextStore.getAmbient('session-1')
      expect(ambient).not.toBeNull()
      expect(ambient!.last_product_mentioned).toBe('Nike Air 42')

      // 3. DRAFT_CREATED → UIAgent publishes UI_UPDATE show
      await eco.bus.publish('bus:DRAFT_CREATED', {
        event: 'DRAFT_CREATED',
        draft_id: 'draft_001',
        session_id: 'session-1',
        intent_id: 'order_create',
        summary: { product: 'Nike Air 42', total: 18500 },
        ttl: 120,
      })

      // wait for async bus delivery
      await new Promise((r) => setTimeout(r, 10))

      expect(eco.uiUpdates.some((u) => u.component === 'order_panel' && u.action === 'show')).toBe(
        true,
      )

      // 4. SPEECH_FINAL (role: cashier) + keyword → StaffAgent activates
      await eco.staffAgent.onEvent('bus:SPEECH_FINAL', {
        event: 'SPEECH_FINAL',
        session_id: 'session-1',
        text: 'Fitaly, aplica descuento del 10%',
        speaker_id: 'spk_cashier',
        role: 'cashier',
      })

      // wait for async bus delivery of INTERACTION_PAUSE
      await new Promise((r) => setTimeout(r, 10))

      // 5. INTERACTION_PAUSE → InteractionAgent no procesa
      expect(eco.interactionAgent.isSessionPaused('session-1')).toBe(true)

      const pausedResult = await eco.interactionAgent.handleSpeechFinal({
        session_id: 'session-1',
        text: 'Quiero esos tenis',
        speaker_id: 'customer_1',
      })
      expect(pausedResult.textChunks).toHaveLength(0) // Paused → no LLM

      // 6. StaffAgent ejecuta comando → STAFF_COMMAND published
      // (already triggered by initial staff speech + LLM tool call)
      await new Promise((r) => setTimeout(r, 10))

      // 7. DRAFT_MODIFIED - simulate (normally would come from tool execution)
      // UIAgent should have picked up the STAFF_COMMAND
      expect(eco.uiUpdates.some((u) => u.component === 'staff_bar' && u.action === 'show')).toBe(
        true,
      )

      // 8. INTERACTION_RESUME → InteractionAgent reanuda
      await eco.staffAgent.onEvent('bus:SPEECH_FINAL', {
        event: 'SPEECH_FINAL',
        session_id: 'session-1',
        text: 'Listo, continúa',
        speaker_id: 'spk_cashier',
        role: 'cashier',
      })

      await new Promise((r) => setTimeout(r, 10))

      expect(eco.interactionAgent.isSessionPaused('session-1')).toBe(false)

      // 9. DRAFT_CONFIRMED → UIAgent publishes confirmed
      await eco.bus.publish('bus:DRAFT_CONFIRMED', {
        event: 'DRAFT_CONFIRMED',
        draft_id: 'draft_001',
        session_id: 'session-1',
        intent_id: 'order_create',
        items: { product: 'Nike Air 42', qty: 1 },
        total: 16650,
      })

      await new Promise((r) => setTimeout(r, 10))

      expect(
        eco.uiUpdates.some((u) => u.component === 'order_panel' && u.action === 'confirmed'),
      ).toBe(true)

      // Cleanup
      await eco.staffAgent.stop()
      await eco.uiAgent.stop()
      await eco.ambientAgent.stop()
      eco.contextStore.dispose()
    })
  })

  // ── 2 simultaneous sessions ────────────────────────────────────────

  describe('session isolation', () => {
    it('2 simultaneous sessions → agents isolated by session_id', async () => {
      const eco = createEcosystem({
        interactionLLM: createMockLLM('Respuesta genérica'),
        ambientLLM: createAmbientLLM('Adidas Superstar'),
      })

      await eco.staffAgent.start()
      await eco.uiAgent.start()
      await eco.ambientAgent.start()

      // Session A: InteractionAgent processes normally
      const resultA = await eco.interactionAgent.handleSpeechFinal({
        session_id: 'session-A',
        text: 'Hola, sesión A',
        speaker_id: 'customer_A',
      })
      expect(resultA.textChunks).toHaveLength(1)

      // Session B: InteractionAgent processes normally
      const resultB = await eco.interactionAgent.handleSpeechFinal({
        session_id: 'session-B',
        text: 'Hola, sesión B',
        speaker_id: 'customer_B',
      })
      expect(resultB.textChunks).toHaveLength(1)

      // Pause session A only
      await eco.staffAgent.onEvent('bus:SPEECH_FINAL', {
        event: 'SPEECH_FINAL',
        session_id: 'session-A',
        text: 'Fitaly, necesito ayuda',
        speaker_id: 'staff_1',
        role: 'cashier',
      })

      await new Promise((r) => setTimeout(r, 10))

      // Session A should be paused
      expect(eco.interactionAgent.isSessionPaused('session-A')).toBe(true)

      // Session B should NOT be paused
      expect(eco.interactionAgent.isSessionPaused('session-B')).toBe(false)

      const resultB2 = await eco.interactionAgent.handleSpeechFinal({
        session_id: 'session-B',
        text: 'Sesión B sigue funcionando',
        speaker_id: 'customer_B',
      })
      expect(resultB2.textChunks).toHaveLength(1)

      // Ambient for session A
      await eco.ambientAgent.onEvent('bus:AMBIENT_CONTEXT', {
        event: 'AMBIENT_CONTEXT',
        session_id: 'session-A',
        speaker_id: 'spk_ambient',
        text: 'Mira esos Adidas Superstar',
        timestamp: Date.now(),
      })

      const ambientA = await eco.contextStore.getAmbient('session-A')
      expect(ambientA!.last_product_mentioned).toBe('Adidas Superstar')

      // Session B ambient should be independent
      const ambientB = await eco.contextStore.getAmbient('session-B')
      expect(ambientB).toBeNull()

      // Cleanup
      await eco.staffAgent.stop()
      await eco.uiAgent.stop()
      await eco.ambientAgent.stop()
      eco.contextStore.dispose()
    })
  })

  // ── Fault tolerance: StaffAgent failure ────────────────────────────

  describe('fault tolerance', () => {
    it('StaffAgent LLM error → InteractionAgent keeps working', async () => {
      const eco = createEcosystem({
        interactionLLM: createMockLLM('Todo funciona normalmente'),
        staffLLM: createErrorLLM(),
      })

      await eco.staffAgent.start()

      // StaffAgent activates
      await eco.staffAgent.onEvent('bus:SPEECH_FINAL', {
        event: 'SPEECH_FINAL',
        session_id: 'session-1',
        text: 'Fitaly, aplica descuento',
        speaker_id: 'spk_cashier',
        role: 'cashier',
      })

      await new Promise((r) => setTimeout(r, 10))

      // InteractionAgent is paused (StaffAgent activated successfully)
      expect(eco.interactionAgent.isSessionPaused('session-1')).toBe(true)

      // StaffAgent tries to process command with broken LLM → fails silently
      await eco.staffAgent.onEvent('bus:SPEECH_FINAL', {
        event: 'SPEECH_FINAL',
        session_id: 'session-1',
        text: 'aplica 10%',
        speaker_id: 'spk_cashier',
        role: 'cashier',
      })

      // No crash, system still running

      // Staff resumes
      await eco.staffAgent.onEvent('bus:SPEECH_FINAL', {
        event: 'SPEECH_FINAL',
        session_id: 'session-1',
        text: 'continúa',
        speaker_id: 'spk_cashier',
        role: 'cashier',
      })

      await new Promise((r) => setTimeout(r, 10))

      // InteractionAgent resumes and works
      expect(eco.interactionAgent.isSessionPaused('session-1')).toBe(false)

      const result = await eco.interactionAgent.handleSpeechFinal({
        session_id: 'session-1',
        text: 'Quiero esos tenis',
        speaker_id: 'customer_1',
      })
      expect(result.textChunks.join('')).toContain('funciona')

      // Cleanup
      await eco.staffAgent.stop()
      eco.contextStore.dispose()
    })

    it('AmbientAgent failure → does not affect InteractionAgent or UIAgent', async () => {
      const eco = createEcosystem({
        interactionLLM: createMockLLM('Respuesta del InteractionAgent'),
        ambientLLM: createErrorLLM(),
      })

      await eco.uiAgent.start()
      await eco.ambientAgent.start()

      // AmbientAgent fails silently
      await eco.ambientAgent.onEvent('bus:AMBIENT_CONTEXT', {
        event: 'AMBIENT_CONTEXT',
        session_id: 'session-1',
        speaker_id: 'spk_A',
        text: 'Some ambient speech',
        timestamp: Date.now(),
      })

      // InteractionAgent still works
      const result = await eco.interactionAgent.handleSpeechFinal({
        session_id: 'session-1',
        text: 'Hola',
        speaker_id: 'customer_1',
      })
      expect(result.textChunks.join('')).toContain('InteractionAgent')

      // UIAgent still works
      await eco.bus.publish('bus:DRAFT_CREATED', {
        event: 'DRAFT_CREATED',
        draft_id: 'draft_fail',
        session_id: 'session-1',
        intent_id: 'order_create',
        summary: { product: 'Test' },
        ttl: 60,
      })

      await new Promise((r) => setTimeout(r, 10))

      expect(eco.uiUpdates.some((u) => u.component === 'order_panel')).toBe(true)

      // Cleanup
      await eco.uiAgent.stop()
      await eco.ambientAgent.stop()
      eco.contextStore.dispose()
    })
  })
})
