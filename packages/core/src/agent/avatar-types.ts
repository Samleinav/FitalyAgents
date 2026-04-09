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

export interface AvatarCommand {
  type: 'state' | 'expression' | 'speak' | 'look_at'
  state?: AvatarState
  expression?: AvatarExpression
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
