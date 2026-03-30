import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest'
import { StaffAgent } from './staff-agent.js'
import type { StaffAgentDeps, StaffSpeechPayload } from './staff-agent.js'
import type {
  IStreamingLLM,
  LLMStreamChunk,
  InteractionToolDef,
  IToolExecutor,
} from './interaction-agent.js'
import { InMemoryBus } from '../bus/in-memory-bus.js'
import { SafetyGuard } from '../safety/safety-guard.js'
import type { ToolSafetyConfig } from '../safety/safety-guard.js'
import type { HumanProfile, HumanRole } from '../safety/channels/types.js'

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
  ...defs: Array<{ id: string; safety: InteractionToolDef['safety']; required_role?: HumanRole }>
): Map<string, InteractionToolDef> {
  const map = new Map<string, InteractionToolDef>()
  for (const d of defs) {
    map.set(d.id, {
      tool_id: d.id,
      description: `Tool ${d.id}`,
      safety: d.safety,
      required_role: d.required_role,
    })
  }
  return map
}

function buildSafetyGuard(configs: ToolSafetyConfig[] = []): SafetyGuard {
  return new SafetyGuard({ toolConfigs: configs })
}

function createStaffAgent(overrides: Partial<StaffAgentDeps> = {}): {
  agent: StaffAgent
  bus: InMemoryBus
  executor: IToolExecutor
} {
  const bus = overrides.bus ? (overrides.bus as InMemoryBus) : new InMemoryBus()
  const executor = overrides.executor ?? createMockExecutor()

  const agent = new StaffAgent({
    bus,
    llm: overrides.llm ?? createMockLLM(),
    safetyGuard: overrides.safetyGuard ?? buildSafetyGuard(),
    toolRegistry: overrides.toolRegistry ?? new Map(),
    executor,
    config: (overrides as any).config,
    staffProfiles: (overrides as any).staffProfiles,
    ...overrides,
  })

  return { agent, bus, executor }
}

/** Helper to publish a SPEECH_FINAL event and wait for async processing. */
async function fireSpeechFinal(agent: StaffAgent, payload: StaffSpeechPayload): Promise<void> {
  await agent.onEvent('bus:SPEECH_FINAL', payload)
}

// ── Tests ────────────────────────────────────────────────────────────────────

describe('StaffAgent', () => {
  beforeEach(() => {
    vi.useFakeTimers()
  })

  afterEach(() => {
    vi.useRealTimers()
  })

  // ── Filtering ─────────────────────────────────────────────────────

  describe('role filtering', () => {
    it('ignores SPEECH_FINAL without role', async () => {
      const bus = new InMemoryBus()
      const pauseEvents: unknown[] = []
      bus.subscribe('bus:INTERACTION_PAUSE', (d) => pauseEvents.push(d))

      const { agent } = createStaffAgent({ bus })

      await fireSpeechFinal(agent, {
        session_id: 'session-1',
        text: 'fitaly, pausa',
        speaker_id: 'spk_1',
        // no role
      })

      expect(pauseEvents).toHaveLength(0)
    })

    it('ignores SPEECH_FINAL with role=null', async () => {
      const bus = new InMemoryBus()
      const pauseEvents: unknown[] = []
      bus.subscribe('bus:INTERACTION_PAUSE', (d) => pauseEvents.push(d))

      const { agent } = createStaffAgent({ bus })

      await fireSpeechFinal(agent, {
        session_id: 'session-1',
        text: 'fitaly, pausa',
        speaker_id: 'spk_1',
        role: null,
      })

      expect(pauseEvents).toHaveLength(0)
    })

    it('ignores SPEECH_FINAL with non-staff role (customer)', async () => {
      const bus = new InMemoryBus()
      const pauseEvents: unknown[] = []
      bus.subscribe('bus:INTERACTION_PAUSE', (d) => pauseEvents.push(d))

      const { agent } = createStaffAgent({ bus })

      await fireSpeechFinal(agent, {
        session_id: 'session-1',
        text: 'fitaly, pausa',
        speaker_id: 'spk_1',
        role: 'customer',
      })

      expect(pauseEvents).toHaveLength(0)
    })
  })

  // ── Activation ────────────────────────────────────────────────────

  describe('activation', () => {
    it('ignores SPEECH_FINAL with staff role but NO keyword', async () => {
      const bus = new InMemoryBus()
      const pauseEvents: unknown[] = []
      bus.subscribe('bus:INTERACTION_PAUSE', (d) => pauseEvents.push(d))

      const { agent } = createStaffAgent({ bus })

      await fireSpeechFinal(agent, {
        session_id: 'session-1',
        text: 'hola, buenos días',
        speaker_id: 'spk_cashier',
        role: 'cashier',
      })

      expect(pauseEvents).toHaveLength(0)
      expect(agent.isSessionActivated('session-1')).toBe(false)
    })

    it('activates on keyword "fitaly" and publishes INTERACTION_PAUSE', async () => {
      const bus = new InMemoryBus()
      const pauseEvents: unknown[] = []
      bus.subscribe('bus:INTERACTION_PAUSE', (d) => pauseEvents.push(d))

      const { agent } = createStaffAgent({ bus })

      await fireSpeechFinal(agent, {
        session_id: 'session-1',
        text: 'Fitaly, pausa',
        speaker_id: 'spk_cashier',
        role: 'cashier',
      })

      expect(pauseEvents).toHaveLength(1)
      expect(pauseEvents[0]).toMatchObject({
        event: 'INTERACTION_PAUSE',
        session_id: 'session-1',
        reason: 'staff_override',
        staff_id: 'spk_cashier',
      })
      expect(agent.isSessionActivated('session-1')).toBe(true)
    })

    it('activates on keyword "sistema"', async () => {
      const bus = new InMemoryBus()
      const pauseEvents: unknown[] = []
      bus.subscribe('bus:INTERACTION_PAUSE', (d) => pauseEvents.push(d))

      const { agent } = createStaffAgent({ bus })

      await fireSpeechFinal(agent, {
        session_id: 'session-1',
        text: 'sistema, necesito ayuda',
        speaker_id: 'spk_manager',
        role: 'manager',
      })

      expect(pauseEvents).toHaveLength(1)
      expect(agent.isSessionActivated('session-1')).toBe(true)
    })

    it('INTERACTION_PAUSE carries correct session_id', async () => {
      const bus = new InMemoryBus()
      const pauseEvents: unknown[] = []
      bus.subscribe('bus:INTERACTION_PAUSE', (d) => pauseEvents.push(d))

      const { agent } = createStaffAgent({ bus })

      await fireSpeechFinal(agent, {
        session_id: 'session-42',
        text: 'Fitaly, pausa',
        speaker_id: 'spk_owner',
        role: 'owner',
      })

      expect(pauseEvents).toHaveLength(1)
      expect((pauseEvents[0] as any).session_id).toBe('session-42')
    })
  })

  // ── Resume ────────────────────────────────────────────────────────

  describe('resume', () => {
    it('publishes INTERACTION_RESUME on "continúa"', async () => {
      const bus = new InMemoryBus()
      const resumeEvents: unknown[] = []
      bus.subscribe('bus:INTERACTION_RESUME', (d) => resumeEvents.push(d))

      const { agent } = createStaffAgent({ bus })

      // Activate first
      await fireSpeechFinal(agent, {
        session_id: 'session-1',
        text: 'Fitaly, pausa',
        speaker_id: 'spk_cashier',
        role: 'cashier',
      })
      expect(agent.isSessionActivated('session-1')).toBe(true)

      // Resume
      await fireSpeechFinal(agent, {
        session_id: 'session-1',
        text: 'continúa',
        speaker_id: 'spk_cashier',
        role: 'cashier',
      })

      expect(resumeEvents).toHaveLength(1)
      expect(resumeEvents[0]).toMatchObject({
        event: 'INTERACTION_RESUME',
        session_id: 'session-1',
      })
      expect(agent.isSessionActivated('session-1')).toBe(false)
    })

    it('publishes INTERACTION_RESUME on "listo"', async () => {
      const bus = new InMemoryBus()
      const resumeEvents: unknown[] = []
      bus.subscribe('bus:INTERACTION_RESUME', (d) => resumeEvents.push(d))

      const { agent } = createStaffAgent({ bus })

      await fireSpeechFinal(agent, {
        session_id: 'session-1',
        text: 'Fitaly, pausa',
        speaker_id: 'spk_cashier',
        role: 'cashier',
      })

      await fireSpeechFinal(agent, {
        session_id: 'session-1',
        text: 'listo',
        speaker_id: 'spk_cashier',
        role: 'cashier',
      })

      expect(resumeEvents).toHaveLength(1)
      expect(agent.isSessionActivated('session-1')).toBe(false)
    })
  })

  // ── Auto-resume timeout ───────────────────────────────────────────

  describe('auto-resume timeout', () => {
    it('auto-resumes after N seconds of no staff speech', async () => {
      const bus = new InMemoryBus()
      const resumeEvents: unknown[] = []
      bus.subscribe('bus:INTERACTION_RESUME', (d) => resumeEvents.push(d))

      const { agent } = createStaffAgent({
        bus,
        config: { autoResumeTimeoutMs: 5_000 },
      } as any)

      await fireSpeechFinal(agent, {
        session_id: 'session-1',
        text: 'Fitaly, pausa',
        speaker_id: 'spk_cashier',
        role: 'cashier',
      })

      expect(agent.isSessionActivated('session-1')).toBe(true)
      expect(resumeEvents).toHaveLength(0)

      // Advance time past timeout
      await vi.advanceTimersByTimeAsync(5_001)

      expect(resumeEvents).toHaveLength(1)
      expect(resumeEvents[0]).toMatchObject({
        event: 'INTERACTION_RESUME',
        session_id: 'session-1',
      })
      expect(agent.isSessionActivated('session-1')).toBe(false)
    })

    it('resets auto-resume timer on staff speech', async () => {
      const bus = new InMemoryBus()
      const resumeEvents: unknown[] = []
      bus.subscribe('bus:INTERACTION_RESUME', (d) => resumeEvents.push(d))

      // LLM that returns no tool calls (just text)
      const llm = createMockLLM([
        { type: 'text', text: 'Procesando...' },
        { type: 'end', stop_reason: 'end_turn' },
      ])

      const { agent } = createStaffAgent({
        bus,
        llm,
        config: { autoResumeTimeoutMs: 5_000 },
      } as any)

      // Activate
      await fireSpeechFinal(agent, {
        session_id: 'session-1',
        text: 'Fitaly, pausa',
        speaker_id: 'spk_cashier',
        role: 'cashier',
      })

      // Advance 3s (not yet expired)
      await vi.advanceTimersByTimeAsync(3_000)
      expect(resumeEvents).toHaveLength(0)

      // Staff speaks again → resets timer
      await fireSpeechFinal(agent, {
        session_id: 'session-1',
        text: 'muéstrame el inventario',
        speaker_id: 'spk_cashier',
        role: 'cashier',
      })

      // Advance another 3s (total 6s from start, but only 3s from last speech)
      await vi.advanceTimersByTimeAsync(3_000)
      expect(resumeEvents).toHaveLength(0)

      // Advance 2 more seconds (5s from last speech) → should auto-resume
      await vi.advanceTimersByTimeAsync(2_001)
      expect(resumeEvents).toHaveLength(1)
    })
  })

  // ── LLM command processing ────────────────────────────────────────

  describe('command processing', () => {
    it('processes staff command via LLM and executes tool', async () => {
      const bus = new InMemoryBus()
      const staffCmdEvents: unknown[] = []
      bus.subscribe('bus:STAFF_COMMAND', (d) => staffCmdEvents.push(d))

      const executor = createMockExecutor({
        apply_discount: { discount_applied: true, new_total: 16_650 },
      })

      const llm = createMockLLM([
        {
          type: 'tool_call',
          id: 'tc_1',
          name: 'apply_discount',
          input: { percentage: 10 },
        },
        { type: 'end', stop_reason: 'tool_use' },
      ])

      const safetyGuard = buildSafetyGuard([
        { name: 'apply_discount', safety: 'restricted', required_role: 'cashier' },
      ])

      const cashierProfile: HumanProfile = {
        id: 'spk_cashier',
        name: 'Cashier',
        role: 'cashier',
        store_id: 'store_001',
        approval_limits: { discount_max_pct: 10, payment_max: 50_000 },
      }

      const { agent } = createStaffAgent({
        bus,
        llm,
        executor,
        safetyGuard,
        toolRegistry: buildTools({
          id: 'apply_discount',
          safety: 'restricted',
          required_role: 'cashier',
        }),
        staffProfiles: new Map([['spk_cashier', cashierProfile]]),
      } as any)

      // Activate
      await fireSpeechFinal(agent, {
        session_id: 'session-1',
        text: 'Fitaly, pausa',
        speaker_id: 'spk_cashier',
        role: 'cashier',
      })

      // Send command
      await fireSpeechFinal(agent, {
        session_id: 'session-1',
        text: 'aplica 10% descuento',
        speaker_id: 'spk_cashier',
        role: 'cashier',
      })

      expect(executor.execute).toHaveBeenCalledWith('apply_discount', { percentage: 10 })
      expect(staffCmdEvents).toHaveLength(1)
      expect(staffCmdEvents[0]).toMatchObject({
        event: 'STAFF_COMMAND',
        session_id: 'session-1',
        command: 'apply_discount',
        staff_id: 'spk_cashier',
      })
    })

    it('processes an inline command in the activation utterance', async () => {
      const bus = new InMemoryBus()
      const staffCmdEvents: unknown[] = []
      bus.subscribe('bus:STAFF_COMMAND', (d) => staffCmdEvents.push(d))

      const executor = createMockExecutor({
        apply_discount: { discount_applied: true, new_total: 16_650 },
      })

      const llm = createMockLLM([
        {
          type: 'tool_call',
          id: 'tc_1',
          name: 'apply_discount',
          input: { percentage: 10 },
        },
        { type: 'end', stop_reason: 'tool_use' },
      ])

      const safetyGuard = buildSafetyGuard([
        { name: 'apply_discount', safety: 'restricted', required_role: 'cashier' },
      ])

      const cashierProfile: HumanProfile = {
        id: 'spk_cashier',
        name: 'Cashier',
        role: 'cashier',
        store_id: 'store_001',
        approval_limits: { discount_max_pct: 10, payment_max: 50_000 },
      }

      const { agent } = createStaffAgent({
        bus,
        llm,
        executor,
        safetyGuard,
        toolRegistry: buildTools({
          id: 'apply_discount',
          safety: 'restricted',
          required_role: 'cashier',
        }),
        staffProfiles: new Map([['spk_cashier', cashierProfile]]),
      } as any)

      await fireSpeechFinal(agent, {
        session_id: 'session-1',
        text: 'Fitaly, aplica 10% descuento',
        speaker_id: 'spk_cashier',
        role: 'cashier',
      })

      expect(agent.isSessionActivated('session-1')).toBe(true)
      expect(executor.execute).toHaveBeenCalledWith('apply_discount', { percentage: 10 })
      expect(staffCmdEvents).toHaveLength(1)
    })

    it('rejects tool call when staff has insufficient permissions', async () => {
      const bus = new InMemoryBus()
      const staffCmdEvents: unknown[] = []
      bus.subscribe('bus:STAFF_COMMAND', (d) => staffCmdEvents.push(d))

      const executor = createMockExecutor()

      // LLM tries to call refund_create, which requires manager
      const llm = createMockLLM([
        {
          type: 'tool_call',
          id: 'tc_1',
          name: 'refund_create',
          input: { amount: 80_000 },
        },
        { type: 'end', stop_reason: 'tool_use' },
      ])

      const safetyGuard = buildSafetyGuard([
        { name: 'refund_create', safety: 'restricted', required_role: 'manager' },
      ])

      const { agent } = createStaffAgent({
        bus,
        llm,
        executor,
        safetyGuard,
        toolRegistry: buildTools({
          id: 'refund_create',
          safety: 'restricted',
          required_role: 'manager',
        }),
      })

      // Activate as cashier (insufficient for refund)
      await fireSpeechFinal(agent, {
        session_id: 'session-1',
        text: 'Fitaly, pausa',
        speaker_id: 'spk_cashier',
        role: 'cashier',
      })

      // Cashier tries to do a refund
      await fireSpeechFinal(agent, {
        session_id: 'session-1',
        text: 'haz un reembolso de 80000',
        speaker_id: 'spk_cashier',
        role: 'cashier',
      })

      // Executor should NOT have been called — cashier can't refund
      expect(executor.execute).not.toHaveBeenCalled()
      expect(staffCmdEvents).toHaveLength(0)
    })
  })

  // ── Permission levels ─────────────────────────────────────────────

  describe('role-based permissions', () => {
    it('cashier can apply discount ≤10%', async () => {
      const bus = new InMemoryBus()
      const staffCmdEvents: unknown[] = []
      bus.subscribe('bus:STAFF_COMMAND', (d) => staffCmdEvents.push(d))

      const executor = createMockExecutor({
        apply_discount: { ok: true },
      })

      const llm = createMockLLM([
        {
          type: 'tool_call',
          id: 'tc_1',
          name: 'apply_discount',
          input: { percentage: 10 },
        },
        { type: 'end', stop_reason: 'tool_use' },
      ])

      // SafetyGuard with cashier having discount_max_pct via defaults
      const safetyGuard = buildSafetyGuard([
        { name: 'apply_discount', safety: 'restricted', required_role: 'cashier' },
      ])

      const cashierProfile: HumanProfile = {
        id: 'spk_cashier',
        name: 'Maria',
        role: 'cashier',
        store_id: 'store_001',
        approval_limits: { discount_max_pct: 10, payment_max: 50_000 },
      }

      const { agent } = createStaffAgent({
        bus,
        llm,
        executor,
        safetyGuard,
        toolRegistry: buildTools({
          id: 'apply_discount',
          safety: 'restricted',
          required_role: 'cashier',
        }),
        staffProfiles: new Map([['spk_cashier', cashierProfile]]),
      } as any)

      // Activate
      await fireSpeechFinal(agent, {
        session_id: 'session-1',
        text: 'Fitaly, pausa',
        speaker_id: 'spk_cashier',
        role: 'cashier',
      })

      // Apply 10% discount — should succeed for cashier
      await fireSpeechFinal(agent, {
        session_id: 'session-1',
        text: 'aplica 10% descuento',
        speaker_id: 'spk_cashier',
        role: 'cashier',
      })

      expect(executor.execute).toHaveBeenCalled()
      expect(staffCmdEvents).toHaveLength(1)
    })

    it('manager can apply discount ≤30%', async () => {
      const bus = new InMemoryBus()
      const staffCmdEvents: unknown[] = []
      bus.subscribe('bus:STAFF_COMMAND', (d) => staffCmdEvents.push(d))

      const executor = createMockExecutor({
        apply_discount: { ok: true },
      })

      const llm = createMockLLM([
        {
          type: 'tool_call',
          id: 'tc_1',
          name: 'apply_discount',
          input: { percentage: 25 },
        },
        { type: 'end', stop_reason: 'tool_use' },
      ])

      const safetyGuard = buildSafetyGuard([
        { name: 'apply_discount', safety: 'restricted', required_role: 'cashier' },
      ])

      const managerProfile: HumanProfile = {
        id: 'spk_manager',
        name: 'Carlos',
        role: 'manager',
        store_id: 'store_001',
        approval_limits: { discount_max_pct: 30, payment_max: Infinity, refund_max: 100_000 },
      }

      const { agent } = createStaffAgent({
        bus,
        llm,
        executor,
        safetyGuard,
        toolRegistry: buildTools({
          id: 'apply_discount',
          safety: 'restricted',
          required_role: 'cashier',
        }),
        staffProfiles: new Map([['spk_manager', managerProfile]]),
      } as any)

      // Activate as manager
      await fireSpeechFinal(agent, {
        session_id: 'session-1',
        text: 'Fitaly, necesito ajustar esto',
        speaker_id: 'spk_manager',
        role: 'manager',
      })

      // Apply 25% discount — should succeed for manager
      await fireSpeechFinal(agent, {
        session_id: 'session-1',
        text: 'aplica 25% descuento',
        speaker_id: 'spk_manager',
        role: 'manager',
      })

      expect(executor.execute).toHaveBeenCalled()
      expect(staffCmdEvents).toHaveLength(1)
    })
  })

  // ── Multi-session isolation ───────────────────────────────────────

  describe('multi-session isolation', () => {
    it('each session has independent activation state', async () => {
      const bus = new InMemoryBus()
      const pauseEvents: unknown[] = []
      bus.subscribe('bus:INTERACTION_PAUSE', (d) => pauseEvents.push(d))

      const { agent } = createStaffAgent({ bus })

      // Activate session-1
      await fireSpeechFinal(agent, {
        session_id: 'session-1',
        text: 'Fitaly, pausa',
        speaker_id: 'spk_cashier_1',
        role: 'cashier',
      })

      expect(agent.isSessionActivated('session-1')).toBe(true)
      expect(agent.isSessionActivated('session-2')).toBe(false)

      // Session-2 speech without keyword — should not activate
      await fireSpeechFinal(agent, {
        session_id: 'session-2',
        text: 'hola, necesito algo',
        speaker_id: 'spk_cashier_2',
        role: 'cashier',
      })

      expect(agent.isSessionActivated('session-2')).toBe(false)
      expect(pauseEvents).toHaveLength(1) // only session-1

      // Activate session-2
      await fireSpeechFinal(agent, {
        session_id: 'session-2',
        text: 'sistema, atención',
        speaker_id: 'spk_manager',
        role: 'manager',
      })

      expect(agent.isSessionActivated('session-1')).toBe(true)
      expect(agent.isSessionActivated('session-2')).toBe(true)
      expect(pauseEvents).toHaveLength(2)
    })

    it('resuming session-1 does not affect session-2', async () => {
      const bus = new InMemoryBus()
      const resumeEvents: unknown[] = []
      bus.subscribe('bus:INTERACTION_RESUME', (d) => resumeEvents.push(d))

      const { agent } = createStaffAgent({ bus })

      // Activate both sessions
      await fireSpeechFinal(agent, {
        session_id: 'session-1',
        text: 'Fitaly, pausa',
        speaker_id: 'spk_1',
        role: 'cashier',
      })
      await fireSpeechFinal(agent, {
        session_id: 'session-2',
        text: 'Fitaly, pausa',
        speaker_id: 'spk_2',
        role: 'manager',
      })

      // Resume only session-1
      await fireSpeechFinal(agent, {
        session_id: 'session-1',
        text: 'listo',
        speaker_id: 'spk_1',
        role: 'cashier',
      })

      expect(agent.isSessionActivated('session-1')).toBe(false)
      expect(agent.isSessionActivated('session-2')).toBe(true)
      expect(resumeEvents).toHaveLength(1)
      expect((resumeEvents[0] as any).session_id).toBe('session-1')
    })
  })

  // ── Edge cases ────────────────────────────────────────────────────

  describe('edge cases', () => {
    it('stops cleanly and clears all timers', async () => {
      const bus = new InMemoryBus()
      const { agent } = createStaffAgent({
        bus,
        config: { autoResumeTimeoutMs: 10_000 },
      } as any)

      await agent.start()

      await fireSpeechFinal(agent, {
        session_id: 'session-1',
        text: 'Fitaly, pausa',
        speaker_id: 'spk_1',
        role: 'cashier',
      })

      // Stop should not throw
      await agent.stop()

      // After stop, no resume events should fire even if time passes
      const resumeEvents: unknown[] = []
      bus.subscribe('bus:INTERACTION_RESUME', (d) => resumeEvents.push(d))
      await vi.advanceTimersByTimeAsync(15_000)
      expect(resumeEvents).toHaveLength(0)
    })

    it('ignores events on non-SPEECH_FINAL channels', async () => {
      const bus = new InMemoryBus()
      const pauseEvents: unknown[] = []
      bus.subscribe('bus:INTERACTION_PAUSE', (d) => pauseEvents.push(d))

      const { agent } = createStaffAgent({ bus })

      // Fire on wrong channel
      await agent.onEvent('bus:AMBIENT_CONTEXT', {
        session_id: 'session-1',
        text: 'Fitaly, pausa',
        speaker_id: 'spk_1',
        role: 'cashier',
      })

      expect(pauseEvents).toHaveLength(0)
    })

    it('handles keyword case-insensitively', async () => {
      const bus = new InMemoryBus()
      const pauseEvents: unknown[] = []
      bus.subscribe('bus:INTERACTION_PAUSE', (d) => pauseEvents.push(d))

      const { agent } = createStaffAgent({ bus })

      await fireSpeechFinal(agent, {
        session_id: 'session-1',
        text: 'FITALY, NECESITO AYUDA',
        speaker_id: 'spk_1',
        role: 'manager',
      })

      expect(pauseEvents).toHaveLength(1)
    })
  })
})
