import { StreamAgent } from './stream-agent.js'
import type { IEventBus } from '../types/index.js'
import type { IStreamingLLM, InteractionToolDef, IToolExecutor } from './interaction-agent.js'
import type { SafetyGuard } from '../safety/safety-guard.js'
import { defaultLimits } from '../safety/safety-guard.js'
import type { HumanProfile, HumanRole } from '../safety/channels/types.js'
import type { HandoffBuilder } from '../session/handoff-builder.js'

// ── Constants ────────────────────────────────────────────────────────────────

const RESUME_PATTERNS = /\b(continúa|continua|resume|listo|termina|eso es todo)\b/i
const INLINE_COMMAND_PATTERNS =
  /^(aplica|apply|ajusta|actualiza|busca|search|cambia|confirma|confirm|crea|create|haz|muestra|muestrame|muéstrame|procesa|reembolsa|refund|revisa)\b/i

const DEFAULT_STAFF_ROLES: HumanRole[] = [
  'staff',
  'agent',
  'cashier',
  'operator',
  'manager',
  'supervisor',
  'owner',
]
const DEFAULT_ACTIVATION_KEYWORDS = ['fitaly', 'sistema']

// ── Types ────────────────────────────────────────────────────────────────────

export interface StaffAgentConfig {
  /** Keywords that activate the StaffAgent. Default: ['fitaly', 'sistema'] */
  activationKeywords?: string[]
  /** Roles considered as staff. Default: ['staff', 'cashier', 'manager', 'owner'] */
  staffRoles?: HumanRole[]
  /** Auto-resume after N ms of silence from staff. Default: 30_000 */
  autoResumeTimeoutMs?: number
  /** System prompt for the LLM. */
  systemPrompt?: string
}

export interface StaffAgentDeps {
  bus: IEventBus
  llm: IStreamingLLM
  safetyGuard: SafetyGuard
  toolRegistry: Map<string, InteractionToolDef>
  executor: IToolExecutor
  config?: StaffAgentConfig
  /** Optional pre-loaded staff profiles for permission lookups. */
  staffProfiles?: Map<string, HumanProfile>
  /** Optional handoff builder for pushing context to human devices on takeover. */
  handoffBuilder?: HandoffBuilder
}

/**
 * Payload shape for SPEECH_FINAL events consumed by StaffAgent.
 * Must include `role` for staff filtering.
 */
export interface StaffSpeechPayload {
  session_id: string
  text: string
  speaker_id?: string
  confidence?: number
  role?: HumanRole | null
}

/** Per-session activation state. */
interface SessionActivation {
  isActivated: boolean
  staffId: string | null
  role: HumanRole
  resumeTimer: ReturnType<typeof setTimeout> | null
}

// ── StaffAgent ───────────────────────────────────────────────────────────────

/**
 * StaffAgent — listens to speakers with elevated roles (staff/cashier/manager/owner),
 * can pause/resume the InteractionAgent, and executes commands with role-based permissions.
 *
 * Activation flow:
 * 1. Receives SPEECH_FINAL with a staff role
 * 2. If not activated → looks for activation keyword ("fitaly", "sistema")
 * 3. On activation → publishes INTERACTION_PAUSE, InteractionAgent stops processing
 * 4. Processes staff commands via LLM 8B with SafetyGuard permissions
 * 5. On "continúa" / "listo" or timeout → publishes INTERACTION_RESUME
 *
 * @example
 * ```typescript
 * const staff = new StaffAgent({
 *   bus,
 *   llm: groq8B,
 *   safetyGuard,
 *   toolRegistry,
 *   executor,
 *   config: { autoResumeTimeoutMs: 30_000 },
 * })
 *
 * await staff.start()
 * // Cashier says "Fitaly, aplica 10% descuento"
 * // → INTERACTION_PAUSE → execute discount tool → STAFF_COMMAND
 * ```
 */
export class StaffAgent extends StreamAgent {
  private readonly llm: IStreamingLLM
  private readonly safetyGuard: SafetyGuard
  private readonly toolRegistry: Map<string, InteractionToolDef>
  private readonly executor: IToolExecutor
  private readonly activationKeywords: string[]
  private readonly staffRoles: HumanRole[]
  private readonly autoResumeTimeoutMs: number
  private readonly systemPrompt: string
  private readonly staffProfiles: Map<string, HumanProfile>
  private readonly handoffBuilder: HandoffBuilder | undefined

  /** Per-session activation state. */
  private readonly sessions = new Map<string, SessionActivation>()

  protected get channels(): string[] {
    return ['bus:SPEECH_FINAL', 'bus:SESSION_RESUMED']
  }

  constructor(deps: StaffAgentDeps) {
    super(deps.bus)
    this.llm = deps.llm
    this.safetyGuard = deps.safetyGuard
    this.toolRegistry = deps.toolRegistry
    this.executor = deps.executor
    this.activationKeywords = deps.config?.activationKeywords ?? DEFAULT_ACTIVATION_KEYWORDS
    this.staffRoles = deps.config?.staffRoles ?? DEFAULT_STAFF_ROLES
    this.autoResumeTimeoutMs = deps.config?.autoResumeTimeoutMs ?? 30_000
    this.systemPrompt =
      deps.config?.systemPrompt ??
      'Eres un asistente técnico para empleados de tienda. ' +
        'Responde de forma directa y técnica. ' +
        'Puedes ejecutar comandos del sistema cuando te lo pidan.'
    this.staffProfiles = deps.staffProfiles ?? new Map()
    this.handoffBuilder = deps.handoffBuilder
  }

  // ── StreamAgent lifecycle ──────────────────────────────────────────────────

  async onEvent(channel: string, payload: unknown): Promise<void> {
    if (channel === 'bus:SESSION_RESUMED') {
      await this.handleSessionResumed(payload)
      return
    }

    if (channel !== 'bus:SPEECH_FINAL') return

    const data = payload as StaffSpeechPayload
    const { session_id, text, speaker_id, role } = data

    if (!session_id || !text) return

    // Filter: only process if speaker has a staff role
    if (!role || !this.staffRoles.includes(role)) return

    const staffId = speaker_id ?? 'unknown_staff'

    // Get or create per-session state
    let session = this.sessions.get(session_id)
    if (!session) {
      session = {
        isActivated: false,
        staffId: null,
        role,
        resumeTimer: null,
      }
      this.sessions.set(session_id, session)
    }

    if (!session.isActivated) {
      // ── Not activated: look for keyword ──────────────────────────────────
      if (this.hasActivationKeyword(text)) {
        session.isActivated = true
        session.staffId = staffId
        session.role = role

        await this.bus.publish('bus:INTERACTION_PAUSE', {
          event: 'INTERACTION_PAUSE',
          session_id,
          reason: 'staff_override',
          staff_id: staffId,
        })

        await this.publishSessionHandoff(session_id, staffId, role)

        this.startAutoResumeTimer(session_id)

        const inlineCommand = this.extractInlineCommand(text)
        if (
          inlineCommand &&
          !this.isResumeCommand(inlineCommand) &&
          this.isInlineCommand(inlineCommand)
        ) {
          await this.processStaffCommand(session_id, inlineCommand, staffId, role)
        }
      }
      return
    }

    // ── Already activated ───────────────────────────────────────────────────

    // Reset auto-resume timer on any staff speech
    this.resetAutoResumeTimer(session_id)

    // Check for resume command
    if (this.isResumeCommand(text)) {
      await this.deactivateAndResume(session_id, {
        resumedBy: staffId,
        resumedByRole: role,
      })
      return
    }

    // Process command with LLM
    await this.processStaffCommand(session_id, text, staffId, role)
  }

  async stop(): Promise<void> {
    for (const session of this.sessions.values()) {
      if (session.resumeTimer) {
        clearTimeout(session.resumeTimer)
      }
    }
    this.sessions.clear()
    await super.stop()
  }

  // ── Keyword detection ──────────────────────────────────────────────────────

  private hasActivationKeyword(text: string): boolean {
    const lower = text.toLowerCase()
    return this.activationKeywords.some((kw) => lower.includes(kw.toLowerCase()))
  }

  private isResumeCommand(text: string): boolean {
    return RESUME_PATTERNS.test(text)
  }

  private extractInlineCommand(text: string): string | null {
    const lower = text.toLowerCase()

    for (const keyword of this.activationKeywords) {
      const normalizedKeyword = keyword.toLowerCase()
      const index = lower.indexOf(normalizedKeyword)
      if (index === -1) continue

      const remainder = text
        .slice(index + keyword.length)
        .replace(/^[\s,.:;!?-]+/, '')
        .trim()

      return remainder.length > 0 ? remainder : null
    }

    return null
  }

  private isInlineCommand(text: string): boolean {
    return INLINE_COMMAND_PATTERNS.test(text)
  }

  // ── Activation lifecycle ───────────────────────────────────────────────────

  private async deactivateAndResume(
    sessionId: string,
    opts: {
      resumedBy?: string
      resumedByRole?: HumanRole
      notes?: string
    } = {},
  ): Promise<void> {
    const session = this.clearSessionActivation(sessionId)
    if (!session) return

    await this.bus.publish('bus:INTERACTION_RESUME', {
      event: 'INTERACTION_RESUME',
      session_id: sessionId,
    })

    await this.bus.publish('bus:SESSION_RESUMED', {
      event: 'SESSION_RESUMED',
      session_id: sessionId,
      resumed_by: opts.resumedBy ?? session.staffId ?? 'unknown_staff',
      resumed_by_role: opts.resumedByRole ?? session.role,
      notes: opts.notes,
      source_agent_id: 'StaffAgent',
      timestamp: Date.now(),
    })
  }

  // ── Auto-resume timer ─────────────────────────────────────────────────────

  private startAutoResumeTimer(sessionId: string): void {
    const session = this.sessions.get(sessionId)
    if (!session) return

    if (session.resumeTimer) {
      clearTimeout(session.resumeTimer)
    }

    session.resumeTimer = setTimeout(() => {
      void this.deactivateAndResume(sessionId, { resumedBy: 'timeout' })
    }, this.autoResumeTimeoutMs)

    // Don't keep the Node process alive for timers
    if (typeof session.resumeTimer === 'object' && 'unref' in session.resumeTimer) {
      session.resumeTimer.unref()
    }
  }

  private resetAutoResumeTimer(sessionId: string): void {
    const session = this.sessions.get(sessionId)
    if (!session?.isActivated) return
    this.startAutoResumeTimer(sessionId)
  }

  private async handleSessionResumed(payload: unknown): Promise<void> {
    const event = payload as {
      session_id?: string
      resumed_by?: string
      resumed_by_role?: HumanRole
      notes?: string
      source_agent_id?: string
    }
    if (!event.session_id || event.source_agent_id === 'StaffAgent') return

    const session = this.sessions.get(event.session_id)
    if (!session?.isActivated) return

    this.clearSessionActivation(event.session_id)

    await this.bus.publish('bus:INTERACTION_RESUME', {
      event: 'INTERACTION_RESUME',
      session_id: event.session_id,
    })
  }

  private clearSessionActivation(sessionId: string): SessionActivation | null {
    const session = this.sessions.get(sessionId)
    if (!session?.isActivated) return null

    if (session.resumeTimer) {
      clearTimeout(session.resumeTimer)
    }

    const previous = { ...session }
    session.isActivated = false
    session.staffId = null
    session.resumeTimer = null
    return previous
  }

  private async publishSessionHandoff(
    sessionId: string,
    staffId: string,
    role: HumanRole,
  ): Promise<void> {
    if (!this.handoffBuilder) return

    try {
      const handoff = await this.handoffBuilder.build(sessionId, staffId, role, 'InteractionAgent')
      await this.bus.publish('bus:SESSION_HANDOFF', handoff)
    } catch {
      // Handoff context is helpful, but the safety pause must remain reliable.
    }
  }

  // ── Staff profile resolution ──────────────────────────────────────────────

  private getStaffProfile(staffId: string, role: HumanRole): HumanProfile {
    const existing = this.staffProfiles.get(staffId)
    if (existing) return existing

    // Build a profile from default limits for this role
    return {
      id: staffId,
      name: staffId,
      role,
      org_id: 'default',
      store_id: 'default',
      approval_limits: defaultLimits[role] ?? {},
    }
  }

  // ── LLM command processing ────────────────────────────────────────────────

  private async processStaffCommand(
    sessionId: string,
    text: string,
    staffId: string,
    role: HumanRole,
  ): Promise<void> {
    try {
      const messages: Array<{ role: 'user' | 'assistant'; content: string }> = [
        { role: 'user', content: text },
      ]
      const tools = this.buildToolsList()

      for await (const chunk of this.llm.stream({
        system: this.systemPrompt,
        messages,
        tools: tools.length > 0 ? tools : undefined,
      })) {
        if (chunk.type === 'tool_call') {
          await this.handleToolCall(sessionId, chunk.name, chunk.input, staffId, role)
        }
        // Text chunks from staff LLM are informational — no TTS for now
      }
    } catch {
      // LLM error — don't crash, InteractionAgent stays paused until resume/timeout
    }
  }

  private async handleToolCall(
    sessionId: string,
    toolName: string,
    input: unknown,
    staffId: string,
    role: HumanRole,
  ): Promise<void> {
    const toolDef = this.toolRegistry.get(toolName)
    if (!toolDef) return

    const profile = this.getStaffProfile(staffId, role)
    const params =
      typeof input === 'object' && input !== null ? (input as Record<string, unknown>) : {}

    // Check permissions via SafetyGuard using the staff member's profile
    const decision = await this.safetyGuard.evaluateAsync(toolName, params, profile, {
      session_id: sessionId,
    })

    if (!decision.allowed && 'reason' in decision && decision.reason === 'needs_approval') {
      // Staff doesn't have sufficient permissions — reject silently
      return
    }

    // Execute the tool
    try {
      const result = await this.executor.execute(toolName, input)

      await this.bus.publish('bus:STAFF_COMMAND', {
        event: 'STAFF_COMMAND',
        session_id: sessionId,
        command: toolName,
        staff_id: staffId,
        params,
        result,
        timestamp: Date.now(),
      })
    } catch {
      // Tool execution error — don't crash
    }
  }

  private buildToolsList(): Array<{ name: string; description?: string; input_schema?: unknown }> {
    const tools: Array<{ name: string; description?: string; input_schema?: unknown }> = []
    for (const [, toolDef] of this.toolRegistry) {
      tools.push({
        name: toolDef.tool_id,
        description: toolDef.description,
        input_schema: toolDef.input_schema,
      })
    }
    return tools
  }

  // ── Public getters for testing ─────────────────────────────────────────────

  /**
   * Check if a session is currently in activated (staff override) mode.
   */
  isSessionActivated(sessionId: string): boolean {
    return this.sessions.get(sessionId)?.isActivated ?? false
  }
}
