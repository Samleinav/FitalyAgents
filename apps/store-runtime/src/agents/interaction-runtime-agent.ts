import {
  StreamAgent,
  type IEventBus,
  type HumanRole,
  type IContextStore,
  type InteractionAgent,
  type InMemorySessionManager,
} from 'fitalyagents'
import type { IMemoryStore, MemoryScopeResolver } from '@fitalyagents/dispatcher'
import type { SessionBoundLLM } from '../providers/llm/types.js'
import type { DraftRepository, SessionRepository } from '../storage/repositories/index.js'
import type { PersistentDraftStore } from '../bootstrap/persistent-draft-store.js'
import { resolveIngressSessionId } from '../bootstrap/speaker-session.js'
import type { TtsStreamService } from '../bootstrap/tts-stream.js'
import type { ToolRegistry } from '../tools/registry.js'

const STAFF_ROLES = new Set<HumanRole>([
  'staff',
  'agent',
  'cashier',
  'operator',
  'manager',
  'supervisor',
  'owner',
])

export class InteractionRuntimeAgent extends StreamAgent {
  private currentPrimarySpeakerId: string | null = null

  constructor(
    private readonly deps: {
      bus: IEventBus
      interaction: InteractionAgent
      llm: SessionBoundLLM
      toolRegistry: ToolRegistry
      contextStore: IContextStore
      sessionManager: InMemorySessionManager
      sessionRepository: SessionRepository
      draftStore: PersistentDraftStore
      draftRepository: DraftRepository
      ttsStream: TtsStreamService
      storeId: string
      captureDriver: 'local-stt' | 'voice-events' | 'external-bus'
      memoryStore?: IMemoryStore
      memoryScopeResolver?: MemoryScopeResolver
    },
  ) {
    super(deps.bus)
  }

  protected get channels(): string[] {
    return ['bus:SPEECH_FINAL', 'bus:BARGE_IN', 'bus:TARGET_GROUP_CHANGED']
  }

  async onEvent(channel: string, payload: unknown): Promise<void> {
    if (channel === 'bus:BARGE_IN') {
      const event = payload as { session_id?: string }
      if (event.session_id) {
        this.deps.llm.abortSession(event.session_id)
      }
      return
    }

    if (channel === 'bus:TARGET_GROUP_CHANGED') {
      const event = payload as { primary?: string | null }
      this.currentPrimarySpeakerId = event.primary ?? null
      return
    }

    if (channel !== 'bus:SPEECH_FINAL') {
      return
    }

    const event = payload as {
      session_id?: string
      text?: string
      speaker_id?: string
      role?: HumanRole | null
      store_id?: string
      timestamp?: number
    }

    if (!event.text) {
      return
    }

    if (event.role && STAFF_ROLES.has(event.role)) {
      return
    }

    if (
      event.speaker_id &&
      this.currentPrimarySpeakerId &&
      event.speaker_id !== this.currentPrimarySpeakerId
    ) {
      return
    }

    const runtimeSessionId = resolveIngressSessionId({
      storeId: this.deps.storeId,
      captureDriver: this.deps.captureDriver,
      incomingSessionId: event.session_id,
      speakerId: event.speaker_id,
    })

    if (!runtimeSessionId) {
      return
    }

    const speechEvent = {
      session_id: runtimeSessionId,
      text: event.text,
      speaker_id: event.speaker_id,
      role: event.role ?? 'customer',
      store_id: event.store_id ?? this.deps.storeId,
      timestamp: event.timestamp ?? Date.now(),
    }

    await this.ensureSession(speechEvent.session_id, speechEvent.speaker_id)
    await this.deps.contextStore.patch(speechEvent.session_id, {
      store_id: speechEvent.store_id,
      speaker_id: speechEvent.speaker_id ?? 'unknown',
      speaker_role: speechEvent.role,
      last_user_timestamp: speechEvent.timestamp,
    })
    this.deps.sessionRepository.touch(speechEvent.session_id, {
      speaker_id: speechEvent.speaker_id ?? 'unknown',
      last_user_text: speechEvent.text,
    })

    await this.writeMemory(speechEvent)

    const executionContext = {
      session_id: speechEvent.session_id,
      store_id: speechEvent.store_id,
      speaker_id: speechEvent.speaker_id,
      role: speechEvent.role,
    }

    if (this.deps.interaction.hasPendingConfirmation(speechEvent.session_id)) {
      await this.deps.toolRegistry.runWithContext(executionContext, async () => {
        await this.deps.interaction.handleProtectedConfirm(speechEvent.session_id, speechEvent.text)
      })
      return
    }

    if (await this.deps.draftStore.getBySession(speechEvent.session_id)) {
      await this.deps.toolRegistry.runWithContext(executionContext, async () => {
        await this.deps.interaction.handleDraftFlow(speechEvent.session_id, speechEvent.text)
      })
      return
    }

    try {
      const result = await this.deps.llm.runWithSession(speechEvent.session_id, () =>
        this.deps.toolRegistry.runWithContext(executionContext, () =>
          this.deps.interaction.handleSpeechFinal({
            session_id: speechEvent.session_id,
            text: speechEvent.text,
            speaker_id: speechEvent.speaker_id,
            role: speechEvent.role,
          }),
        ),
      )

      await this.handleToolResults(speechEvent.session_id, result.toolResults)
    } catch (error) {
      if (isAbortLikeError(error)) {
        return
      }

      throw error
    }
  }

  private async ensureSession(sessionId: string, speakerId?: string): Promise<void> {
    const existing = await this.deps.sessionManager.getSession(sessionId)
    if (existing) {
      return
    }

    await this.deps.sessionManager.createSession(sessionId, {
      speaker_id: speakerId ?? 'unknown',
      store_id: this.deps.storeId,
    })

    this.deps.sessionRepository.upsertStarted(sessionId, this.deps.storeId, {
      speaker_id: speakerId ?? 'unknown',
    })
  }

  private async writeMemory(event: {
    session_id: string
    text: string
    speaker_id?: string
    role?: HumanRole | null
    store_id?: string
    timestamp?: number
  }): Promise<void> {
    if (!this.deps.memoryStore || !this.deps.memoryScopeResolver) {
      return
    }

    const scope = await this.deps.memoryScopeResolver({
      session_id: event.session_id,
      text: event.text,
      speaker_id: event.speaker_id,
      role: event.role ?? 'customer',
      actor_type: event.role ?? 'customer',
      store_id: event.store_id ?? this.deps.storeId,
      timestamp: event.timestamp ?? Date.now(),
    })

    if (!scope) {
      return
    }

    await this.deps.memoryStore.write({
      text: event.text,
      wing: scope.wing,
      room: scope.room,
    })
  }

  private async handleToolResults(
    sessionId: string,
    results: Array<
      | { type: 'executed'; toolId: string; result: unknown }
      | { type: 'cached'; toolId: string; result: unknown }
      | { type: 'draft_ready'; toolId: string; draftId: string }
      | { type: 'needs_confirmation'; toolId: string; prompt: string }
      | { type: 'pending_approval'; toolId: string; approved: boolean | null; response: unknown }
      | { type: 'error'; toolId: string; error: string }
    >,
  ): Promise<void> {
    for (const result of results) {
      switch (result.type) {
        case 'executed':
        case 'cached': {
          const text = extractResultText(result.result)
          if (text) {
            await this.deps.ttsStream.speakText(sessionId, text, 6)
          }
          break
        }
        case 'draft_ready': {
          const draft = this.deps.draftRepository.findById(result.draftId)
          const prompt = draft
            ? `Preparé un borrador para ${draft.tool_id}. ¿Quieres confirmarlo?`
            : 'Preparé un borrador. ¿Quieres confirmarlo?'
          await this.deps.ttsStream.speakText(sessionId, prompt, 7)
          break
        }
        case 'needs_confirmation':
          break
        case 'pending_approval': {
          if (result.approved === true) {
            await this.deps.ttsStream.speakText(
              sessionId,
              'La solicitud fue aprobada correctamente.',
              7,
            )
          } else if (result.approved === false) {
            await this.deps.ttsStream.speakText(sessionId, 'La solicitud fue rechazada.', 7)
          }
          break
        }
        case 'error':
          await this.deps.ttsStream.speakText(
            sessionId,
            `Hubo un error al ejecutar ${result.toolId}.`,
            8,
          )
          break
      }
    }
  }
}

function extractResultText(result: unknown): string | null {
  if (result && typeof result === 'object' && 'text' in result && typeof result.text === 'string') {
    return result.text
  }

  return null
}

function isAbortLikeError(error: unknown): boolean {
  if (!error || typeof error !== 'object') {
    return false
  }

  const candidate = error as { name?: unknown; message?: unknown }
  return (
    candidate.name === 'AbortError' ||
    (typeof candidate.message === 'string' && candidate.message.toLowerCase().includes('abort'))
  )
}
