export type AvatarState = 'idle' | 'listening' | 'thinking' | 'speaking' | 'waiting' | 'confirming'

export type AvatarExpression =
  | 'neutral'
  | 'attentive'
  | 'happy'
  | 'empathetic'
  | 'helpful'
  | 'cheerful'
  | 'warm'
  | 'serious'
  | 'thinking'
  | 'professional'
  | 'focused'
  | 'reassuring'
  | 'approving'
  | 'apologetic'

export type AvatarMotionStyle = 'subtle' | 'balanced' | 'expressive'

export type AvatarGesture =
  | 'none'
  | 'professional_greeting'
  | 'small_nod'
  | 'open_palm'
  | 'present_options'
  | 'acknowledge_queue'
  | 'confirm_action'
  | 'polite_apology'
  | 'handoff'
  | 'thank_you'

export type AvatarGestureEvent =
  | 'speakerDetected'
  | 'targetChanged'
  | 'queueWaiting'
  | 'taskAvailable'
  | 'responseStart'
  | 'responseEnd'
  | 'draftCreated'
  | 'approvalApproved'
  | 'approvalRejected'
  | 'actionCompleted'
  | 'actionFailed'

export interface AvatarPresentationProfile {
  name?: string
  motionStyle?: AvatarMotionStyle
  defaultExpression?: AvatarExpression
  stateExpressionMap?: Partial<Record<AvatarState, AvatarExpression>>
  intentExpressionMap?: Record<string, AvatarExpression>
  eventGestureMap?: Partial<Record<AvatarGestureEvent, AvatarGesture>>
}

export interface AvatarCommand {
  type: 'state' | 'expression' | 'speak' | 'look_at' | 'gesture'
  state?: AvatarState
  expression?: AvatarExpression
  gesture?: AvatarGesture
  motion_style?: AvatarMotionStyle
  text?: string
  is_final?: boolean
  session_id?: string
  speaker_id?: string
  turn_id?: string
  target_id?: string
  metadata?: Record<string, unknown>
}

export interface IAvatarRenderer {
  readonly connected: boolean

  connect(): Promise<void>
  disconnect(): void | Promise<void>
  send(command: AvatarCommand): Promise<void>
}
