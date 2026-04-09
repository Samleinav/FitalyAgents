import { StreamAgent } from './stream-agent.js'
import type { IEventBus } from '../types/index.js'
import type {
  AvatarCommand,
  AvatarExpression,
  AvatarState,
  IAvatarRenderer,
} from './avatar-types.js'

export interface AvatarAgentDeps {
  bus: IEventBus
  renderer: IAvatarRenderer
  intentExpressionMap?: Record<string, AvatarExpression>
  handleSpeech?: boolean
  defaultExpression?: AvatarExpression
}

type TargetGroupPayload = {
  primary?: string | null
  queued?: string[]
}

type AvatarIntentPayload = {
  intent_id?: string
}

type SpeakerPayload = {
  speaker_id?: string
  session_id?: string
}

type AvatarSpeakPayload = SpeakerPayload &
  AvatarIntentPayload & {
    text?: string
    turn_id?: string
    is_final?: boolean
  }

export class AvatarAgent extends StreamAgent {
  private readonly renderer: IAvatarRenderer
  private readonly intentExpressionMap: Record<string, AvatarExpression>
  private readonly handleSpeech: boolean
  private readonly defaultExpression: AvatarExpression
  private currentPrimary: string | null = null

  constructor(deps: AvatarAgentDeps) {
    super(deps.bus)
    this.renderer = deps.renderer
    this.intentExpressionMap = deps.intentExpressionMap ?? {}
    this.handleSpeech = deps.handleSpeech ?? true
    this.defaultExpression = deps.defaultExpression ?? 'neutral'
  }

  protected get channels(): string[] {
    return [
      'bus:SPEAKER_DETECTED',
      'bus:SPEAKER_LOST',
      'bus:TARGET_GROUP_CHANGED',
      'bus:SPEECH_FINAL',
      'bus:TASK_AVAILABLE',
      'bus:DISPATCH_FALLBACK',
      'bus:RESPONSE_START',
      'bus:AVATAR_SPEAK',
      'bus:RESPONSE_END',
      'bus:DRAFT_CREATED',
      'bus:APPROVAL_RESOLVED',
      'bus:ACTION_COMPLETED',
    ]
  }

  override async start(): Promise<void> {
    if (!this.renderer.connected) {
      await this.renderer.connect()
    }

    await super.start()
  }

  override async stop(): Promise<void> {
    await super.stop()
    await this.renderer.disconnect()
  }

  async onEvent(channel: string, payload: unknown): Promise<void> {
    switch (channel) {
      case 'bus:SPEAKER_DETECTED':
        await this.handleSpeakerDetected(payload as SpeakerPayload)
        break
      case 'bus:SPEAKER_LOST':
        await this.handleSpeakerLost(payload as SpeakerPayload)
        break
      case 'bus:TARGET_GROUP_CHANGED':
        await this.handleTargetGroupChanged(payload as TargetGroupPayload)
        break
      case 'bus:SPEECH_FINAL':
        await this.setVisualState('listening', 'neutral')
        break
      case 'bus:TASK_AVAILABLE':
        await this.handleTaskAvailable(payload as AvatarIntentPayload)
        break
      case 'bus:DISPATCH_FALLBACK':
        await this.setVisualState('thinking', 'thinking')
        break
      case 'bus:RESPONSE_START':
        await this.handleResponseStart(payload as AvatarSpeakPayload)
        break
      case 'bus:AVATAR_SPEAK':
        await this.handleAvatarSpeak(payload as AvatarSpeakPayload)
        break
      case 'bus:RESPONSE_END':
        await this.handleResponseEnd()
        break
      case 'bus:DRAFT_CREATED':
        await this.setVisualState('confirming', 'serious')
        break
      case 'bus:APPROVAL_RESOLVED':
        await this.handleApprovalResolved(payload)
        break
      case 'bus:ACTION_COMPLETED':
        await this.handleActionCompleted(payload)
        break
    }
  }

  private async handleSpeakerDetected(payload: SpeakerPayload): Promise<void> {
    if (payload.speaker_id) {
      this.currentPrimary = payload.speaker_id
      await this.send({
        type: 'look_at',
        target_id: payload.speaker_id,
        speaker_id: payload.speaker_id,
        session_id: payload.session_id,
      })
    }

    await this.setVisualState('listening', 'attentive')
  }

  private async handleSpeakerLost(payload: SpeakerPayload): Promise<void> {
    if (payload.speaker_id && payload.speaker_id === this.currentPrimary) {
      this.currentPrimary = null
    }

    if (!this.currentPrimary) {
      await this.setVisualState('idle', 'neutral')
    }
  }

  private async handleTargetGroupChanged(payload: TargetGroupPayload): Promise<void> {
    this.currentPrimary = payload.primary ?? null

    if (!this.currentPrimary) {
      await this.setVisualState('idle', 'neutral')
      return
    }

    await this.send({ type: 'look_at', target_id: this.currentPrimary })

    if ((payload.queued ?? []).length > 0) {
      await this.setVisualState('waiting', 'warm')
      return
    }

    await this.setVisualState('listening', 'attentive')
  }

  private async handleTaskAvailable(payload: AvatarIntentPayload): Promise<void> {
    await this.setVisualState('thinking', this.resolveExpression(payload.intent_id))
  }

  private async handleResponseStart(payload: AvatarSpeakPayload): Promise<void> {
    await this.setVisualState('speaking', this.resolveExpression(payload.intent_id))
  }

  private async handleAvatarSpeak(payload: AvatarSpeakPayload): Promise<void> {
    await this.setVisualState('speaking', this.resolveExpression(payload.intent_id))

    if (!this.handleSpeech || !payload.text) return

    await this.send({
      type: 'speak',
      text: payload.text,
      is_final: payload.is_final ?? false,
      session_id: payload.session_id,
      speaker_id: payload.speaker_id,
      turn_id: payload.turn_id,
    })
  }

  private async handleResponseEnd(): Promise<void> {
    await this.setVisualState(this.currentPrimary ? 'listening' : 'idle', 'neutral')
  }

  private async handleApprovalResolved(payload: unknown): Promise<void> {
    const approved = isRecord(payload) && payload.approved === true
    await this.setVisualState('idle', approved ? 'happy' : 'empathetic')
  }

  private async handleActionCompleted(payload: unknown): Promise<void> {
    const result = isRecord(payload) ? payload.result : undefined
    const status = isRecord(result) ? result.status : undefined
    await this.setVisualState('idle', status === 'error' ? 'empathetic' : 'happy')
  }

  private async setVisualState(state: AvatarState, expression: AvatarExpression): Promise<void> {
    await this.send({ type: 'state', state })
    await this.send({ type: 'expression', expression })
  }

  private resolveExpression(intentId: string | undefined): AvatarExpression {
    if (!intentId) return this.defaultExpression
    return this.intentExpressionMap[intentId] ?? this.defaultExpression
  }

  private async send(command: AvatarCommand): Promise<void> {
    try {
      await this.renderer.send(command)
    } catch {
      // Avatar rendering must never break the agent pipeline.
    }
  }
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value)
}
