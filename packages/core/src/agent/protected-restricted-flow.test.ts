import { describe, it, expect, vi } from 'vitest'
import { InteractionAgent } from './interaction-agent.js'
import type {
  IStreamingLLM,
  LLMStreamChunk,
  InteractionToolDef,
  IToolExecutor,
  InteractionAgentDeps,
} from './interaction-agent.js'
import { InMemoryBus } from '../bus/in-memory-bus.js'
import { InMemoryContextStore } from '../context/in-memory-context-store.js'
import { SafetyGuard } from '../safety/safety-guard.js'

// ── Helpers ──────────────────────────────────────────────────────────────────

function createMockLLM(chunks: LLMStreamChunk[] = []): IStreamingLLM {
  return {
    async *stream() {
      for (const chunk of chunks) yield chunk
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
  executor: IToolExecutor
  ttsLog: string[]
} {
  const bus = overrides.bus instanceof InMemoryBus ? overrides.bus : new InMemoryBus()
  const executor = overrides.executor ?? createMockExecutor()
  const ttsLog: string[] = []

  const agent = new InteractionAgent({
    bus,
    llm: overrides.llm ?? createMockLLM(),
    contextStore: new InMemoryContextStore(),
    toolRegistry: overrides.toolRegistry ?? new Map(),
    executor,
    safetyGuard: new SafetyGuard({ toolConfigs: [] }),
    ttsCallback: (text, _sid) => ttsLog.push(text),
    ...overrides,
  })

  return { agent, bus, executor, ttsLog }
}

// ── Tests ────────────────────────────────────────────────────────────────────

describe('PROTECTED + RESTRICTED flows (Sprint 3.3)', () => {
  // ── PROTECTED: client confirms → tool executes ─────────────────

  describe('PROTECTED: client confirms', () => {
    it('executes tool after client confirms', async () => {
      const executor = createMockExecutor({ price_override: { success: true, new_price: 50 } })
      const llm = createMockLLM([
        { type: 'tool_call', id: 'tc_1', name: 'price_override', input: { amount: 50 } },
        { type: 'end', stop_reason: 'tool_use' },
      ])

      const { agent, ttsLog } = createAgent({
        llm,
        executor,
        toolRegistry: buildTools({
          id: 'price_override',
          safety: 'protected',
          prompt: '¿Confirma el cambio de precio a $50?',
        }),
      })

      // Step 1: LLM calls protected tool → gets needs_confirmation
      const result = await agent.handleSpeechFinal({
        session_id: 'session-1',
        text: 'cambia precio a 50',
      })

      expect(result.toolResults[0].type).toBe('needs_confirmation')
      expect(ttsLog).toContain('¿Confirma el cambio de precio a $50?')
      expect(agent.hasPendingConfirmation('session-1')).toBe(true)

      // Step 2: Client confirms
      ttsLog.length = 0
      const confirmResult = await agent.handleProtectedConfirm('session-1', 'sí')

      expect(confirmResult.type).toBe('executed')
      if (confirmResult.type === 'executed') {
        expect(confirmResult.result).toEqual({ success: true, new_price: 50 })
      }
      expect(executor.execute).toHaveBeenCalledWith('price_override', { amount: 50 })
      expect(ttsLog).toContain('Acción ejecutada correctamente.')
      expect(agent.hasPendingConfirmation('session-1')).toBe(false)
    })
  })

  // ── PROTECTED: client denies → tool not executed ──────────────

  describe('PROTECTED: client denies', () => {
    it('cancels tool when client says no', async () => {
      const executor = createMockExecutor()
      const llm = createMockLLM([
        { type: 'tool_call', id: 'tc_1', name: 'price_override', input: { amount: 50 } },
        { type: 'end', stop_reason: 'tool_use' },
      ])

      const { agent, ttsLog } = createAgent({
        llm,
        executor,
        toolRegistry: buildTools({ id: 'price_override', safety: 'protected' }),
      })

      // Step 1: Protected tool
      await agent.handleSpeechFinal({
        session_id: 'session-1',
        text: 'cambia precio',
      })

      // Step 2: Client denies
      ttsLog.length = 0
      const denyResult = await agent.handleProtectedConfirm('session-1', 'no')

      expect(denyResult.type).toBe('denied')
      expect(executor.execute).not.toHaveBeenCalled()
      expect(ttsLog).toContain('Entendido, acción cancelada.')
      expect(agent.hasPendingConfirmation('session-1')).toBe(false)
    })
  })

  // ── PROTECTED: no pending confirmation ────────────────────────

  describe('PROTECTED: no pending', () => {
    it('returns no_pending when no confirmation is active', async () => {
      const { agent } = createAgent()

      const result = await agent.handleProtectedConfirm('session-1', 'sí')
      expect(result.type).toBe('no_pending')
    })
  })

  // ── PROTECTED: ambiguous response → re-prompt ────────────────

  describe('PROTECTED: ambiguous response', () => {
    it('re-prompts when client response is unclear', async () => {
      const llm = createMockLLM([
        { type: 'tool_call', id: 'tc_1', name: 'price_override', input: { amount: 50 } },
        { type: 'end', stop_reason: 'tool_use' },
      ])

      const { agent, ttsLog } = createAgent({
        llm,
        toolRegistry: buildTools({
          id: 'price_override',
          safety: 'protected',
          prompt: '¿Confirmar?',
        }),
      })

      await agent.handleSpeechFinal({
        session_id: 'session-1',
        text: 'cambia precio',
      })

      // Ambiguous response
      ttsLog.length = 0
      const result = await agent.handleProtectedConfirm('session-1', '¿cuánto cuesta?')

      expect(result.type).toBe('no_pending')
      expect(ttsLog.some((t) => t.includes('No entendí'))).toBe(true)
      // Confirmation is still pending after an ambiguous response
    })
  })

  // ── PROTECTED: executor error on confirm ─────────────────────

  describe('PROTECTED: executor error', () => {
    it('returns error and notifies via TTS when executor fails', async () => {
      const executor: IToolExecutor = {
        execute: vi.fn().mockRejectedValue(new Error('Service unavailable')),
      }

      const llm = createMockLLM([
        { type: 'tool_call', id: 'tc_1', name: 'price_override', input: { amount: 50 } },
        { type: 'end', stop_reason: 'tool_use' },
      ])

      const { agent, ttsLog } = createAgent({
        llm,
        executor,
        toolRegistry: buildTools({ id: 'price_override', safety: 'protected' }),
      })

      await agent.handleSpeechFinal({
        session_id: 'session-1',
        text: 'cambia precio',
      })

      ttsLog.length = 0
      const result = await agent.handleProtectedConfirm('session-1', 'dale')

      expect(result.type).toBe('error')
      if (result.type === 'error') {
        expect(result.error).toContain('Service unavailable')
      }
    })
  })

  // ── RESTRICTED: approval resolved via bus ─────────────────────

  describe('RESTRICTED: approval events', () => {
    it('notifies approved via TTS on APPROVAL_RESOLVED', async () => {
      const { agent, bus, ttsLog } = createAgent()
      const unsub = agent.subscribeApprovalEvents()

      await bus.publish('bus:APPROVAL_RESOLVED', {
        session_id: 'session-1',
        approved: true,
        tool_id: 'refund_create',
      })

      expect(ttsLog).toContain('Aprobación recibida. Procesando tu solicitud.')
      unsub()
    })

    it('notifies denied with reason via TTS', async () => {
      const { agent, bus, ttsLog } = createAgent()
      const unsub = agent.subscribeApprovalEvents()

      await bus.publish('bus:APPROVAL_RESOLVED', {
        session_id: 'session-1',
        approved: false,
        reason: 'Monto excede el límite',
      })

      expect(ttsLog.some((t) => t.includes('denegada') && t.includes('Monto excede'))).toBe(true)
      unsub()
    })

    it('notifies denied without reason', async () => {
      const { agent, bus, ttsLog } = createAgent()
      const unsub = agent.subscribeApprovalEvents()

      await bus.publish('bus:APPROVAL_RESOLVED', {
        session_id: 'session-1',
        approved: false,
      })

      expect(ttsLog.some((t) => t.includes('denegada'))).toBe(true)
      unsub()
    })
  })

  // ── RESTRICTED: timeout ───────────────────────────────────────

  describe('RESTRICTED: timeout', () => {
    it('notifies client when approval times out', async () => {
      const { agent, bus, ttsLog } = createAgent()
      const unsub = agent.subscribeApprovalEvents()

      await bus.publish('bus:ORDER_APPROVAL_TIMEOUT', {
        session_id: 'session-1',
      })

      expect(ttsLog.some((t) => t.includes('autorización a tiempo'))).toBe(true)
      unsub()
    })
  })

  // ── Unsubscribe cleanup ──────────────────────────────────────

  describe('cleanup', () => {
    it('unsubscribe stops receiving events', async () => {
      const { agent, bus, ttsLog } = createAgent()
      const unsub = agent.subscribeApprovalEvents()

      // Unsubscribe
      unsub()

      // Publish after unsubscribe
      await bus.publish('bus:APPROVAL_RESOLVED', {
        session_id: 'session-1',
        approved: true,
      })

      expect(ttsLog).toHaveLength(0)
    })
  })
})
