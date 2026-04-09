import type { AvatarCommand, IAvatarRenderer } from './avatar-types.js'

export interface AIRIWebSocketLike {
  readonly readyState: number
  onopen: ((event: unknown) => void) | null
  onclose: ((event: unknown) => void) | null
  onerror: ((event: unknown) => void) | null
  send(data: string): void
  close(): void
}

export type AIRIWebSocketConstructor = new (url: string) => AIRIWebSocketLike

export interface AIRIRendererConfig {
  url?: string
  reconnectMs?: number
  maxReconnectMs?: number
  queueWhileDisconnected?: boolean
  WebSocketCtor?: AIRIWebSocketConstructor
}

const DEFAULT_AIRI_URL = 'ws://localhost:6006'
const DEFAULT_RECONNECT_MS = 3000
const DEFAULT_MAX_RECONNECT_MS = 30000
const OPEN_READY_STATE = 1

export class AIRIRenderer implements IAvatarRenderer {
  private readonly url: string
  private readonly reconnectMs: number
  private readonly maxReconnectMs: number
  private readonly queueWhileDisconnected: boolean
  private readonly WebSocketCtor: AIRIWebSocketConstructor | undefined
  private socket: AIRIWebSocketLike | null = null
  private reconnectTimer: ReturnType<typeof setTimeout> | null = null
  private reconnectDelay: number
  private manuallyClosed = false
  private readonly queuedCommands: AvatarCommand[] = []

  constructor(config: AIRIRendererConfig = {}) {
    this.url = config.url ?? DEFAULT_AIRI_URL
    this.reconnectMs = config.reconnectMs ?? DEFAULT_RECONNECT_MS
    this.maxReconnectMs = config.maxReconnectMs ?? DEFAULT_MAX_RECONNECT_MS
    this.queueWhileDisconnected = config.queueWhileDisconnected ?? true
    this.WebSocketCtor = config.WebSocketCtor
    this.reconnectDelay = this.reconnectMs
  }

  get connected(): boolean {
    return this.socket?.readyState === OPEN_READY_STATE
  }

  async connect(): Promise<void> {
    if (this.connected) return

    this.manuallyClosed = false
    await this.openSocket()
  }

  disconnect(): void {
    this.manuallyClosed = true
    this.clearReconnectTimer()
    this.queuedCommands.length = 0
    this.socket?.close()
    this.socket = null
  }

  async send(command: AvatarCommand): Promise<void> {
    if (!this.connected) {
      if (this.queueWhileDisconnected) {
        this.queuedCommands.push(command)
        return
      }

      throw new Error('AIRI renderer is not connected')
    }

    this.socket!.send(JSON.stringify(toAIRIMessage(command)))
  }

  private async openSocket(): Promise<void> {
    await new Promise<void>((resolve, reject) => {
      const WebSocketCtor = this.WebSocketCtor ?? getGlobalWebSocket()
      const socket = new WebSocketCtor(this.url)
      this.socket = socket

      socket.onopen = () => {
        this.reconnectDelay = this.reconnectMs
        this.flushQueue().catch(() => {})
        resolve()
      }

      socket.onerror = (event) => {
        reject(event instanceof Error ? event : new Error('AIRI WebSocket connection failed'))
      }

      socket.onclose = () => {
        if (this.socket === socket) {
          this.socket = null
        }

        if (!this.manuallyClosed) {
          this.scheduleReconnect()
        }
      }
    })
  }

  private scheduleReconnect(): void {
    if (this.reconnectTimer) return

    const delay = this.reconnectDelay
    this.reconnectDelay = Math.min(this.reconnectDelay * 2, this.maxReconnectMs)

    this.reconnectTimer = setTimeout(() => {
      this.reconnectTimer = null
      this.openSocket().catch(() => {
        this.scheduleReconnect()
      })
    }, delay)
  }

  private clearReconnectTimer(): void {
    if (!this.reconnectTimer) return
    clearTimeout(this.reconnectTimer)
    this.reconnectTimer = null
  }

  private async flushQueue(): Promise<void> {
    const commands = this.queuedCommands.splice(0)
    for (const command of commands) {
      await this.send(command)
    }
  }
}

function toAIRIMessage(command: AvatarCommand): Record<string, unknown> {
  switch (command.type) {
    case 'state':
      return { type: 'state', value: command.state, metadata: command.metadata }
    case 'expression':
      return { type: 'expression', value: command.expression, metadata: command.metadata }
    case 'speak':
      return {
        type: 'speak',
        text: command.text ?? '',
        final: command.is_final ?? false,
        session_id: command.session_id,
        speaker_id: command.speaker_id,
        turn_id: command.turn_id,
        metadata: command.metadata,
      }
    case 'look_at':
      return {
        type: 'look_at',
        target_id: command.target_id ?? command.speaker_id,
        session_id: command.session_id,
        metadata: command.metadata,
      }
  }
}

function getGlobalWebSocket(): AIRIWebSocketConstructor {
  const maybeGlobal = globalThis as { WebSocket?: AIRIWebSocketConstructor }
  if (!maybeGlobal.WebSocket) {
    throw new Error('AIRI WebSocket is not available. Provide WebSocketCtor in AIRIRendererConfig.')
  }

  return maybeGlobal.WebSocket
}
