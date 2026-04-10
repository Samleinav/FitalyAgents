import { StreamAgent } from './stream-agent.js'
import type { IEventBus } from '../types/index.js'
import type {
  AvatarCommand,
  AvatarGestureEvent,
  AvatarExpression,
  AvatarPresentationProfile,
  AvatarState,
  IAvatarRenderer,
} from './avatar-types.js'

export interface AvatarAgentDeps {
  bus: IEventBus
  renderer: IAvatarRenderer
  presentationProfile?: AvatarPresentationProfile
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
  private readonly presentationProfile: AvatarPresentationProfile | undefined
  private readonly intentExpressionMap: Record<string, AvatarExpression>
  private readonly stateExpressionMap: Partial<Record<AvatarState, AvatarExpression>>
  private readonly handleSpeech: boolean
  private readonly defaultExpression: AvatarExpression
  private currentPrimary: string | null = null

  constructor(deps: AvatarAgentDeps) {
    super(deps.bus)
    this.renderer = deps.renderer
    this.presentationProfile = deps.presentationProfile
    this.intentExpressionMap = {
      ...(deps.presentationProfile?.intentExpressionMap ?? {}),
      ...(deps.intentExpressionMap ?? {}),
    }
    this.stateExpressionMap = deps.presentationProfile?.stateExpressionMap ?? {}
    this.handleSpeech = deps.handleSpeech ?? true
    this.defaultExpression =
      deps.defaultExpression ?? deps.presentationProfile?.defaultExpression ?? 'neutral'
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
        await this.setDefaultVisualState('listening', 'neutral')
        break
      case 'bus:TASK_AVAILABLE':
        await this.handleTaskAvailable(payload as AvatarIntentPayload)
        break
      case 'bus:DISPATCH_FALLBACK':
        await this.setDefaultVisualState('thinking', 'thinking')
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
        await this.handleDraftCreated()
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
      await this.sendGesture('speakerDetected')
    }

    await this.setDefaultVisualState('listening', 'attentive')
  }

  private async handleSpeakerLost(payload: SpeakerPayload): Promise<void> {
    if (payload.speaker_id && payload.speaker_id === this.currentPrimary) {
      this.currentPrimary = null
    }

    if (!this.currentPrimary) {
      await this.setDefaultVisualState('idle', 'neutral')
    }
  }

  private async handleTargetGroupChanged(payload: TargetGroupPayload): Promise<void> {
    this.currentPrimary = payload.primary ?? null

    if (!this.currentPrimary) {
      await this.setDefaultVisualState('idle', 'neutral')
      return
    }

    await this.send({ type: 'look_at', target_id: this.currentPrimary })
    await this.sendGesture('targetChanged')

    if ((payload.queued ?? []).length > 0) {
      await this.sendGesture('queueWaiting')
      await this.setDefaultVisualState('waiting', 'warm')
      return
    }

    await this.setDefaultVisualState('listening', 'attentive')
  }

  private async handleTaskAvailable(payload: AvatarIntentPayload): Promise<void> {
    await this.setVisualState('thinking', this.resolveExpression(payload.intent_id))
    await this.sendGesture('taskAvailable')
  }

  private async handleResponseStart(payload: AvatarSpeakPayload): Promise<void> {
    await this.setVisualState('speaking', this.resolveExpression(payload.intent_id))
    await this.sendGesture('responseStart')
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
    const state = this.currentPrimary ? 'listening' : 'idle'
    await this.setDefaultVisualState(state, 'neutral')
    await this.sendGesture('responseEnd')
  }

  private async handleDraftCreated(): Promise<void> {
    await this.setDefaultVisualState('confirming', 'serious')
    await this.sendGesture('draftCreated')
  }

  private async handleApprovalResolved(payload: unknown): Promise<void> {
    const approved = isRecord(payload) && payload.approved === true
    await this.setVisualState(
      'idle',
      this.resolveProfileFallback(
        'idle',
        approved ? 'happy' : 'empathetic',
        approved ? 'approving' : 'apologetic',
      ),
    )
    await this.sendGesture(approved ? 'approvalApproved' : 'approvalRejected')
  }

  private async handleActionCompleted(payload: unknown): Promise<void> {
    const result = isRecord(payload) ? payload.result : undefined
    const status = isRecord(result) ? result.status : undefined
    await this.setVisualState(
      'idle',
      this.resolveProfileFallback(
        'idle',
        status === 'error' ? 'empathetic' : 'happy',
        status === 'error' ? 'apologetic' : 'approving',
      ),
    )
    await this.sendGesture(status === 'error' ? 'actionFailed' : 'actionCompleted')
  }

  private async setVisualState(state: AvatarState, expression: AvatarExpression): Promise<void> {
    await this.send({ type: 'state', state })
    await this.send({ type: 'expression', expression })
  }

  private async setDefaultVisualState(
    state: AvatarState,
    fallback: AvatarExpression,
  ): Promise<void> {
    await this.setVisualState(state, this.resolveStateExpression(state, fallback))
  }

  private resolveExpression(intentId: string | undefined): AvatarExpression {
    if (!intentId) return this.defaultExpression
    return this.intentExpressionMap[intentId] ?? this.defaultExpression
  }

  private resolveStateExpression(state: AvatarState, fallback: AvatarExpression): AvatarExpression {
    return this.stateExpressionMap[state] ?? fallback
  }

  private resolveProfileFallback(
    state: AvatarState,
    fallback: AvatarExpression,
    profileFallback: AvatarExpression,
  ): AvatarExpression {
    if (!this.presentationProfile) return fallback
    return this.resolveStateExpression(state, profileFallback)
  }

  private async sendGesture(event: AvatarGestureEvent): Promise<void> {
    const gesture = this.presentationProfile?.eventGestureMap?.[event]
    if (!gesture || gesture === 'none') return

    await this.send({ type: 'gesture', gesture, target_id: this.currentPrimary ?? undefined })
  }

  private async send(command: AvatarCommand): Promise<void> {
    try {
      await this.renderer.send(this.withPresentationProfile(command))
    } catch {
      // Avatar rendering must never break the agent pipeline.
    }
  }

  private withPresentationProfile(command: AvatarCommand): AvatarCommand {
    const profileName = this.presentationProfile?.name
    const motionStyle = command.motion_style ?? this.presentationProfile?.motionStyle

    if (!profileName && !motionStyle) return command

    return {
      ...command,
      motion_style: motionStyle,
      metadata: {
        ...(command.metadata ?? {}),
        ...(profileName ? { avatar_profile: profileName } : {}),
        ...(motionStyle ? { motion_style: motionStyle } : {}),
      },
    }
  }
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value)
}
