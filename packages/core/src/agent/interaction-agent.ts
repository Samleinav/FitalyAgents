import type { IEventBus } from '../types/index.js'
import type { IContextStore } from '../context/types.js'
import type { SafetyGuard } from '../safety/safety-guard.js'
import type { InMemoryDraftStore } from '../safety/draft-store.js'
import type { ApprovalOrchestrator } from '../safety/approval-orchestrator.js'
import type { HumanProfile, HumanRole, ApprovalResponse } from '../safety/channels/types.js'
import type { ITracer, ITrace } from '../tracing/types.js'
import { NoopTracer } from '../tracing/noop-tracer.js'

// ── LLM Streaming Interface ──────────────────────────────────────────────────

/**
 * A single chunk from the LLM stream.
 */
export type LLMStreamChunk =
  | { type: 'text'; text: string }
  | { type: 'tool_call'; id: string; name: string; input: unknown }
  | { type: 'end'; stop_reason: 'end_turn' | 'tool_use' | 'max_tokens' }

/**
 * Minimal streaming LLM interface. Any provider (Claude, OpenAI, etc.)
 * can be adapted to this.
 */
export interface IStreamingLLM {
  stream(params: {
    system: string
    messages: Array<{ role: 'user' | 'assistant' | 'tool'; content: string; tool_call_id?: string }>
    tools?: Array<{ name: string; description?: string; input_schema?: unknown }>
  }): AsyncIterable<LLMStreamChunk>
}

// ── Tool Definition (minimal for interaction agent) ──────────────────────────

export interface InteractionToolDef {
  tool_id: string
  description?: string
  safety: 'safe' | 'staged' | 'protected' | 'restricted'
  required_role?: HumanRole
  confirm_prompt?: string
  input_schema?: unknown
}

// ── Tool Executor Interface ──────────────────────────────────────────────────

export interface IToolExecutor {
  execute(toolId: string, input: unknown): Promise<unknown>
}

// ── Speculative Cache Interface (decoupled from dispatcher) ──────────────────

export interface ISpeculativeCache {
  get(
    sessionId: string,
    intentId: string,
  ): { type: string; result?: unknown; draftId?: string } | null
  invalidate(sessionId: string): void
}

// ── Tool Call Result types ───────────────────────────────────────────────────

export type ToolCallResult =
  | { type: 'executed'; toolId: string; result: unknown }
  | { type: 'cached'; toolId: string; result: unknown }
  | { type: 'draft_ready'; toolId: string; draftId: string; needs_confirmation: true }
  | { type: 'needs_confirmation'; toolId: string; prompt: string }
  | {
      type: 'pending_approval'
      toolId: string
      approved: boolean | null
      response: ApprovalResponse | null
    }
  | { type: 'error'; toolId: string; error: string }

// ── Draft Flow types ─────────────────────────────────────────────────────────

export type DraftUserIntent = 'confirm' | 'modify' | 'cancel' | 'unknown'

export type DraftFlowResult =
  | { type: 'confirmed'; draftId: string }
  | { type: 'modified'; draftId: string; changes: Record<string, unknown> }
  | { type: 'cancelled'; draftId: string }
  | { type: 'no_draft'; sessionId: string }
  | { type: 'unknown_intent'; text: string }

export type ProtectedConfirmResult =
  | { type: 'executed'; toolId: string; result: unknown }
  | { type: 'denied'; toolId: string }
  | { type: 'no_pending'; sessionId: string }
  | { type: 'error'; toolId: string; error: string }

// ── Intent detection patterns (Spanish / English voice) ──────────────────────

const CONFIRM_PATTERNS =
  /^(sí|si|dale|confirma|confirmar|ok|okey|de acuerdo|yes|confirm|listo|perfecto|está bien|correcto)$/i
const CANCEL_PATTERNS =
  /^(no|cancela|cancelar|cancel|olvídalo|olvidalo|dejalo|déjalo|nada|nah|mejor no)$/i
const MODIFY_KEYWORDS =
  /^(mejor|cambia|cambiar|quiero|pero|en vez|en lugar|modify|change|update|actualiza|diferente)/i

// ── InteractionAgent ─────────────────────────────────────────────────────────

export interface InteractionAgentDeps {
  bus: IEventBus
  llm: IStreamingLLM
  contextStore: IContextStore
  toolRegistry: Map<string, InteractionToolDef>
  executor: IToolExecutor
  safetyGuard: SafetyGuard
  draftStore?: InMemoryDraftStore
  approvalOrchestrator?: ApprovalOrchestrator
  speculativeCache?: ISpeculativeCache
  ttsCallback?: (text: string, sessionId: string) => void
  systemPrompt?: string
  /** Optional observability tracer. Defaults to NoopTracer. */
  tracer?: ITracer
}

/**
 * InteractionAgent — the LLM-powered brain of the system.
 *
 * Receives SPEECH_FINAL events, builds context, streams LLM response,
 * handles tool calls through the safety pipeline, and streams TTS output.
 *
 * @example
 * ```typescript
 * const agent = new InteractionAgent({
 *   bus,
 *   llm: myStreamingLLM,
 *   contextStore,
 *   toolRegistry,
 *   executor,
 *   safetyGuard,
 *   ttsCallback: (text, sessionId) => console.log(`[${sessionId}] ${text}`),
 * })
 *
 * const result = await agent.handleSpeechFinal({
 *   session_id: 'session-1',
 *   text: 'busco tenis nike',
 *   speaker_id: 'customer_1',
 * })
 * ```
 */
export class InteractionAgent {
  private readonly bus: IEventBus
  private readonly llm: IStreamingLLM
  private readonly contextStore: IContextStore
  private readonly toolRegistry: Map<string, InteractionToolDef>
  private readonly executor: IToolExecutor
  private readonly safetyGuard: SafetyGuard
  private readonly draftStore?: InMemoryDraftStore
  private readonly approvalOrchestrator?: ApprovalOrchestrator
  private readonly speculativeCache?: ISpeculativeCache
  private readonly ttsCallback: (text: string, sessionId: string) => void
  private readonly systemPrompt: string
  private readonly tracer: ITracer

  /**
   * Tracks PROTECTED tools waiting for client confirmation.
   * Key: sessionId, Value: { toolDef, input }
   */
  private readonly pendingConfirmations = new Map<
    string,
    {
      toolDef: InteractionToolDef
      input: unknown
    }
  >()

  constructor(deps: InteractionAgentDeps) {
    this.bus = deps.bus
    this.llm = deps.llm
    this.contextStore = deps.contextStore
    this.toolRegistry = deps.toolRegistry
    this.executor = deps.executor
    this.safetyGuard = deps.safetyGuard
    this.draftStore = deps.draftStore
    this.approvalOrchestrator = deps.approvalOrchestrator
    this.speculativeCache = deps.speculativeCache
    this.ttsCallback = deps.ttsCallback ?? (() => {})
    this.systemPrompt = deps.systemPrompt ?? 'You are a helpful voice assistant.'
    this.tracer = deps.tracer ?? new NoopTracer()
  }

  /**
   * Handle a SPEECH_FINAL event — the main entry point.
   *
   * Flow:
   * 1. Build context from the context store
   * 2. Stream LLM response
   * 3. For text chunks → TTS callback (streaming)
   * 4. For tool_call chunks → route through safety pipeline
   * 5. Publish results
   */
  async handleSpeechFinal(event: {
    session_id: string
    text: string
    speaker_id?: string
  }): Promise<{
    textChunks: string[]
    toolResults: ToolCallResult[]
    traceId: string
  }> {
    const { session_id, text, speaker_id } = event
    const textChunks: string[] = []
    const toolResults: ToolCallResult[] = []
    const t0 = Date.now()

    // ── Observability: start turn trace ──────────────────────────────────────
    const trace: ITrace = this.tracer.startTrace('speech_turn', {
      sessionId: session_id,
      input: { text, speaker_id },
    })

    // 1. Build context
    const messages = await this.buildMessages(session_id, text)

    // 2. Build tools list for the LLM
    const tools = this.buildToolsList()

    // 3. Stream LLM response
    const llmStart = Date.now()
    const llmSpan = trace.span('llm_stream', { system: this.systemPrompt, toolCount: tools.length })

    for await (const chunk of this.llm.stream({
      system: this.systemPrompt,
      messages,
      tools: tools.length > 0 ? tools : undefined,
    })) {
      switch (chunk.type) {
        case 'text': {
          textChunks.push(chunk.text)
          this.ttsCallback(chunk.text, session_id)
          break
        }

        case 'tool_call': {
          const toolSpan = trace.span(`tool_${chunk.name}`, {
            input: chunk.input as Record<string, unknown>,
          })
          const result = await this.handleToolCall(chunk.name, chunk.input, session_id, speaker_id)
          toolResults.push(result)
          toolSpan.end({ type: result.type })
          break
        }

        case 'end': {
          // Stream finished
          break
        }
      }
    }

    const fullText = textChunks.join('')
    llmSpan.end({ textChunks: textChunks.length, toolResults: toolResults.length })

    // Record LLM generation with latency
    trace.generation({
      name: 'interaction_llm',
      input: messages,
      output: fullText || null,
      latencyMs: Date.now() - llmStart,
    })

    // 4. Store conversation in context
    if (fullText) {
      await this.contextStore.set(session_id, 'last_response', fullText)
    }
    await this.contextStore.set(session_id, 'last_user_text', text)

    // 5. Publish completion event
    await this.bus.publish('bus:ACTION_COMPLETED', {
      event: 'ACTION_COMPLETED',
      task_id: `interaction_${Date.now()}`,
      session_id,
      intent_id: 'interaction',
      agent_id: 'InteractionAgent',
      result: { textChunks: textChunks.length, toolResults: toolResults.length },
      timestamp: Date.now(),
    })

    // 6. Invalidate speculative cache at end of turn
    this.speculativeCache?.invalidate(session_id)

    // ── Observability: end trace ─────────────────────────────────────────────
    trace.end({
      latencyMs: Date.now() - t0,
      textChunks: textChunks.length,
      toolResults: toolResults.length,
    })

    return { textChunks, toolResults, traceId: trace.traceId }
  }

  /**
   * Handle a single tool call through the safety pipeline.
   */
  async handleToolCall(
    toolName: string,
    input: unknown,
    sessionId: string,
    speakerId?: string,
  ): Promise<ToolCallResult> {
    const toolDef = this.toolRegistry.get(toolName)
    if (!toolDef) {
      return { type: 'error', toolId: toolName, error: `Unknown tool: ${toolName}` }
    }

    const safety = toolDef.safety ?? 'safe'

    switch (safety) {
      case 'safe':
        return this.handleSafeTool(toolDef, input, sessionId)

      case 'staged':
        return this.handleStagedTool(toolDef, input, sessionId)

      case 'protected':
        return this.handleProtectedTool(toolDef, input, sessionId)

      case 'restricted':
        return this.handleRestrictedTool(toolDef, input, sessionId, speakerId)
    }
  }

  // ── Safety-level handlers ────────────────────────────────────────────

  private async handleSafeTool(
    toolDef: InteractionToolDef,
    input: unknown,
    sessionId: string,
  ): Promise<ToolCallResult> {
    // Check speculative cache first
    if (this.speculativeCache) {
      const cached = this.speculativeCache.get(sessionId, toolDef.tool_id)
      if (cached && cached.type === 'tool_result' && cached.result !== undefined) {
        return { type: 'cached', toolId: toolDef.tool_id, result: cached.result }
      }
    }

    // Execute directly
    try {
      const result = await this.executor.execute(toolDef.tool_id, input)
      return { type: 'executed', toolId: toolDef.tool_id, result }
    } catch (err) {
      return { type: 'error', toolId: toolDef.tool_id, error: String(err) }
    }
  }

  private async handleStagedTool(
    toolDef: InteractionToolDef,
    input: unknown,
    sessionId: string,
  ): Promise<ToolCallResult> {
    if (!this.draftStore) {
      return { type: 'error', toolId: toolDef.tool_id, error: 'DraftStore not available' }
    }

    // Check speculative cache for pre-created draft
    if (this.speculativeCache) {
      const cached = this.speculativeCache.get(sessionId, toolDef.tool_id)
      if (cached && cached.type === 'draft_ref' && cached.draftId) {
        return {
          type: 'draft_ready',
          toolId: toolDef.tool_id,
          draftId: cached.draftId,
          needs_confirmation: true,
        }
      }
    }

    // Create a new draft
    const inputItems =
      typeof input === 'object' && input !== null ? (input as Record<string, unknown>) : {}
    const draftId = await this.draftStore.create(sessionId, {
      intent_id: toolDef.tool_id,
      items: inputItems,
    })

    return {
      type: 'draft_ready',
      toolId: toolDef.tool_id,
      draftId,
      needs_confirmation: true,
    }
  }

  private handleProtectedTool(
    toolDef: InteractionToolDef,
    input: unknown,
    sessionId: string,
  ): ToolCallResult {
    // Store the pending confirmation so we can resolve it on the next turn
    this.pendingConfirmations.set(sessionId, { toolDef, input })

    const prompt = toolDef.confirm_prompt ?? `¿Desea confirmar la acción "${toolDef.tool_id}"?`
    this.ttsCallback(prompt, sessionId)

    return {
      type: 'needs_confirmation',
      toolId: toolDef.tool_id,
      prompt,
    }
  }

  private async handleRestrictedTool(
    toolDef: InteractionToolDef,
    input: unknown,
    sessionId: string,
    speakerId?: string,
  ): Promise<ToolCallResult> {
    if (!this.approvalOrchestrator) {
      return { type: 'error', toolId: toolDef.tool_id, error: 'ApprovalOrchestrator not available' }
    }

    // Notify via TTS that we're waiting for approval
    this.ttsCallback('Un momento, necesito autorización para esta acción.', sessionId)

    const resolvedRole: HumanRole = toolDef.required_role ?? 'manager'

    const approver: HumanProfile = {
      id: speakerId ?? 'unknown',
      name: speakerId ?? 'Unknown',
      role: resolvedRole,
      store_id: 'default',
      approval_limits: {},
    }

    const response = await this.approvalOrchestrator.orchestrate(
      {
        id: `approval_${Date.now()}`,
        draft_id: `draft_${toolDef.tool_id}_${Date.now()}`,
        action: toolDef.tool_id,
        amount:
          typeof input === 'object' && input !== null && 'amount' in input
            ? (input as { amount: number }).amount
            : undefined,
        session_id: sessionId,
        required_role: resolvedRole,
        context: { tool_input: input },
        timeout_ms: 120_000,
      },
      [{ type: 'voice', timeout_ms: 60_000 }],
      'sequential',
      approver,
    )

    return {
      type: 'pending_approval',
      toolId: toolDef.tool_id,
      approved: response?.approved ?? null,
      response,
    }
  }

  // ── Context building ──────────────────────────────────────────────────

  private async buildMessages(
    sessionId: string,
    currentText: string,
  ): Promise<Array<{ role: 'user' | 'assistant'; content: string }>> {
    const messages: Array<{ role: 'user' | 'assistant'; content: string }> = []

    // Load conversation history from context
    const lastUserText = await this.contextStore.get<string>(sessionId, 'last_user_text')
    const lastResponse = await this.contextStore.get<string>(sessionId, 'last_response')

    if (lastUserText && lastResponse) {
      messages.push({ role: 'user', content: lastUserText })
      messages.push({ role: 'assistant', content: lastResponse })
    }

    // Current user message
    messages.push({ role: 'user', content: currentText })

    return messages
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

  // ── Draft Flow (Sprint 3.2) ──────────────────────────────────────────

  /**
   * Handle the next user turn when a draft is pending.
   *
   * Patterns:
   *   "sí/dale/confirma"  → confirm draft → execute the real action
   *   "cambia/mejor/en"   → modify draft with detected changes
   *   "no/cancela"        → cancel draft
   *
   * @returns A DraftFlowResult indicating what happened.
   */
  async handleDraftFlow(sessionId: string, userText: string): Promise<DraftFlowResult> {
    if (!this.draftStore) {
      return { type: 'no_draft', sessionId }
    }

    const draft = await this.draftStore.getBySession(sessionId)
    if (!draft) {
      return { type: 'no_draft', sessionId }
    }

    const intent = this.parseDraftIntent(userText)

    switch (intent) {
      case 'confirm': {
        await this.draftStore.confirm(draft.id)

        // Execute the real action now
        try {
          const result = await this.executor.execute(draft.intent_id, draft.items)
          this.ttsCallback('Listo, orden confirmada.', sessionId)

          await this.bus.publish('bus:ACTION_COMPLETED', {
            event: 'ACTION_COMPLETED',
            task_id: `draft_confirm_${Date.now()}`,
            session_id: sessionId,
            intent_id: draft.intent_id,
            agent_id: 'InteractionAgent',
            result,
            timestamp: Date.now(),
          })
        } catch (err) {
          this.ttsCallback(`Hubo un error al procesar: ${String(err)}`, sessionId)
        }

        return { type: 'confirmed', draftId: draft.id }
      }

      case 'modify': {
        // Extract changes from user text using LLM
        const changes = await this.extractDraftChanges(userText, draft.items)
        await this.draftStore.update(draft.id, changes)

        // Re-present the modified draft
        const updatedDraft = await this.draftStore.get(draft.id)
        if (updatedDraft) {
          const summary = Object.entries(updatedDraft.items)
            .map(([k, v]) => `${k}: ${v}`)
            .join(', ')
          this.ttsCallback(`Actualizado. Ahora tienes: ${summary}. ¿Confirmas?`, sessionId)
        }

        return { type: 'modified', draftId: draft.id, changes }
      }

      case 'cancel': {
        await this.draftStore.cancel(draft.id)
        this.ttsCallback('Orden cancelada.', sessionId)
        return { type: 'cancelled', draftId: draft.id }
      }

      default:
        return { type: 'unknown_intent', text: userText }
    }
  }

  /**
   * Subscribe to draft TTL expiry events. Call once on startup.
   * Notifies clients via TTS when their draft expires.
   */
  subscribeDraftExpiry(): () => void {
    return this.bus.subscribe('bus:DRAFT_CANCELLED', (data) => {
      const event = data as { session_id: string; reason: string }
      if (event.reason === 'ttl_expired') {
        this.ttsCallback('Tu orden ha expirado por inactividad.', event.session_id)
      }
    })
  }

  /**
   * Detect the user's intent from their text input.
   * Simple regex-based classification for voice-friendly patterns.
   */
  parseDraftIntent(text: string): DraftUserIntent {
    const trimmed = text.trim()
    if (CONFIRM_PATTERNS.test(trimmed)) return 'confirm'
    if (CANCEL_PATTERNS.test(trimmed)) return 'cancel'
    if (MODIFY_KEYWORDS.test(trimmed)) return 'modify'
    return 'unknown'
  }

  /**
   * Use the LLM to extract field changes from ambiguous user text.
   * Falls back to a simple key-value parse if LLM is unavailable.
   */
  private async extractDraftChanges(
    userText: string,
    currentItems: Record<string, unknown>,
  ): Promise<Record<string, unknown>> {
    try {
      const fields = Object.keys(currentItems).join(', ')
      const prompt = [
        `Current draft fields: ${fields}`,
        `Current values: ${JSON.stringify(currentItems)}`,
        `User said: "${userText}"`,
        `Extract ONLY the fields being changed. Return a JSON object with just the changed fields.`,
        `Example: if user says "mejor en azul" and fields include "color", return {"color": "azul"}.`,
        `Return ONLY JSON, no markdown.`,
      ].join('\n')

      let rawResponse = ''
      for await (const chunk of this.llm.stream({
        system: 'You extract field changes from user text. Return only JSON.',
        messages: [{ role: 'user', content: prompt }],
      })) {
        if (chunk.type === 'text') rawResponse += chunk.text
      }

      const jsonMatch = rawResponse.trim().match(/\{[\s\S]*\}/)
      if (jsonMatch) {
        return JSON.parse(jsonMatch[0])
      }
    } catch {
      // Fall through to simple extraction
    }

    // Simple fallback: treat the entire text as a general "change" note
    return { _user_modification: userText }
  }

  // ── PROTECTED confirm flow (Sprint 3.3) ─────────────────────────────

  /**
   * Check if a session has a pending PROTECTED tool confirmation.
   */
  hasPendingConfirmation(sessionId: string): boolean {
    return this.pendingConfirmations.has(sessionId)
  }

  /**
   * Handle the client's follow-up turn after a PROTECTED tool prompt.
   *
   * Flow:
   *   Client says "sí/dale/confirma" → execute the tool
   *   Client says "no/cancela"       → cancel, friendly response
   */
  async handleProtectedConfirm(
    sessionId: string,
    userText: string,
  ): Promise<ProtectedConfirmResult> {
    const pending = this.pendingConfirmations.get(sessionId)
    if (!pending) {
      return { type: 'no_pending', sessionId }
    }

    const intent = this.parseDraftIntent(userText)

    if (intent === 'confirm') {
      this.pendingConfirmations.delete(sessionId)

      try {
        const result = await this.executor.execute(pending.toolDef.tool_id, pending.input)
        this.ttsCallback('Acción ejecutada correctamente.', sessionId)

        await this.bus.publish('bus:ACTION_COMPLETED', {
          event: 'ACTION_COMPLETED',
          task_id: `protected_${Date.now()}`,
          session_id: sessionId,
          intent_id: pending.toolDef.tool_id,
          agent_id: 'InteractionAgent',
          result,
          timestamp: Date.now(),
        })

        return { type: 'executed', toolId: pending.toolDef.tool_id, result }
      } catch (err) {
        this.ttsCallback(`Error al ejecutar: ${String(err)}`, sessionId)
        return { type: 'error', toolId: pending.toolDef.tool_id, error: String(err) }
      }
    }

    if (intent === 'cancel') {
      this.pendingConfirmations.delete(sessionId)
      this.ttsCallback('Entendido, acción cancelada.', sessionId)
      return { type: 'denied', toolId: pending.toolDef.tool_id }
    }

    // Unknown — re-prompt
    const prompt =
      pending.toolDef.confirm_prompt ?? `¿Desea confirmar "${pending.toolDef.tool_id}"?`
    this.ttsCallback(`No entendí. ${prompt}`, sessionId)
    return { type: 'no_pending', sessionId }
  }

  // ── RESTRICTED approval events (Sprint 3.3) ─────────────────────────

  /**
   * Subscribe to approval resolution bus events.
   * Returns an unsubscribe function. Call once on startup.
   *
   * - APPROVAL_RESOLVED → notify client of result via TTS
   * - ORDER_APPROVAL_TIMEOUT → inform client the request timed out
   */
  subscribeApprovalEvents(): () => void {
    const unsubs: Array<() => void> = []

    unsubs.push(
      this.bus.subscribe('bus:APPROVAL_RESOLVED', (data) => {
        const event = data as {
          session_id: string
          approved: boolean
          tool_id?: string
          reason?: string
        }
        if (event.approved) {
          this.ttsCallback('Aprobación recibida. Procesando tu solicitud.', event.session_id)
        } else {
          this.ttsCallback(
            `Solicitud denegada${event.reason ? ': ' + event.reason : ''}.`,
            event.session_id,
          )
        }
      }),
    )

    unsubs.push(
      this.bus.subscribe('bus:ORDER_APPROVAL_TIMEOUT', (data) => {
        const event = data as { session_id: string }
        this.ttsCallback(
          'Lo siento, no se recibió autorización a tiempo. La solicitud ha expirado.',
          event.session_id,
        )
      }),
    )

    return () => {
      for (const unsub of unsubs) unsub()
    }
  }
}
