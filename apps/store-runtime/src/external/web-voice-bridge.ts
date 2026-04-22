import { randomUUID } from 'node:crypto'
import type { IncomingMessage } from 'node:http'
import type { Duplex } from 'node:stream'
import { URL } from 'node:url'
import dotenv from 'dotenv'
import Fastify, { type FastifyInstance } from 'fastify'
import { createBus, type IEventBus, type HumanRole } from 'fitalyagents'
import WebSocket, { WebSocketServer, type RawData } from 'ws'
import { z } from 'zod'
import { buildSpeakerSessionId } from '../bootstrap/speaker-session.js'
import { isEntrypoint } from '../cli/is-entrypoint.js'
import { resolveConfigPath } from '../cli/resolve-config-path.js'
import { HUMAN_ROLE_VALUES } from '../config/human-roles.js'
import { loadStoreConfig } from '../config/load-store-config.js'
import type { StoreConfig } from '../config/schema.js'
import {
  createSTTProvider,
  type STTSession,
  type STTTranscriptChunk,
} from '../providers/stt/types.js'
import { renderWebVoiceBridgeHtml } from './web-voice-bridge-page.js'

const DEFAULT_WEB_VOICE_BRIDGE_HOST = '0.0.0.0'
const DEFAULT_WEB_VOICE_BRIDGE_PORT = 3040
const DEFAULT_WEB_VOICE_BRIDGE_PATH = '/ws/voice'

const WebVoiceSurfaceSchema = z.enum(['avatar', 'customer-display', 'staff-ui', 'voice-only'])
type WebVoiceSurface = z.infer<typeof WebVoiceSurfaceSchema>

const HelloMessageSchema = z.object({
  type: z.literal('hello'),
  store_id: z.string().optional(),
  session_id: z.string().optional(),
  speaker_id: z.string().optional(),
  role: z.enum(HUMAN_ROLE_VALUES).optional(),
  surface: WebVoiceSurfaceSchema.optional(),
})

const AudioChunkMessageSchema = z.object({
  type: z.literal('audio_chunk'),
  data: z.string().min(1),
})

const VADStartMessageSchema = z.object({
  type: z.literal('vad_start'),
})

const VADStopMessageSchema = z.object({
  type: z.literal('vad_stop'),
})

const InterruptMessageSchema = z.object({
  type: z.literal('interrupt'),
})

const PingMessageSchema = z.object({
  type: z.literal('ping'),
  timestamp: z.number().optional(),
})

const TextInputMessageSchema = z.object({
  type: z.literal('text_input'),
  text: z.string().min(1),
})

const ClientMessageSchema = z.discriminatedUnion('type', [
  HelloMessageSchema,
  AudioChunkMessageSchema,
  VADStartMessageSchema,
  VADStopMessageSchema,
  InterruptMessageSchema,
  PingMessageSchema,
  TextInputMessageSchema,
])

const BRIDGE_CHANNELS = [
  'bus:SPEECH_PARTIAL',
  'bus:SPEECH_FINAL',
  'bus:RESPONSE_START',
  'bus:AVATAR_SPEAK',
  'bus:TTS_SEGMENT_START',
  'bus:TTS_AUDIO_CHUNK',
  'bus:TTS_SEGMENT_END',
  'bus:RESPONSE_END',
  'bus:BARGE_IN',
] as const

type TurnState =
  | 'idle'
  | 'listening'
  | 'speech_detected'
  | 'transcribing'
  | 'thinking'
  | 'speaking'
  | 'interrupted'

interface BridgeClientSnapshot {
  client_id: string
  session_id: string | null
  speaker_id: string | null
  surface: WebVoiceSurface | null
  role: HumanRole
  speech_active: boolean
  turn_state: TurnState
}

interface BridgeServiceState {
  store_id: string
  websocket_path: string
  client_count: number
  active_sessions: number
  stt_driver: StoreConfig['providers']['stt']['driver']
  browser_vad: boolean
  clients: BridgeClientSnapshot[]
}

interface WebVoiceClientState {
  id: string
  socket: WebSocket
  role: HumanRole
  surface: WebVoiceSurface | null
  sessionId: string | null
  speakerId: string | null
  speechActive: boolean
  turnState: TurnState
  sttSession: STTSession | null
  speechPublishChain: Promise<void>
  messageChain: Promise<void>
  bargeInSent: boolean
}

function createInitialClientState(id: string, socket: WebSocket): WebVoiceClientState {
  return {
    id,
    socket,
    role: 'customer',
    surface: null,
    sessionId: null,
    speakerId: null,
    speechActive: false,
    turnState: 'idle',
    sttSession: null,
    speechPublishChain: Promise.resolve(),
    messageChain: Promise.resolve(),
    bargeInSent: false,
  }
}

export function buildWebVoiceBridgeServer(deps: {
  config: StoreConfig
  manager: WebVoiceBridgeManager
}): FastifyInstance {
  const server = Fastify({ logger: false })

  server.get('/', async (_request, reply) => {
    return reply.type('text/html; charset=utf-8').send(
      renderWebVoiceBridgeHtml({
        storeId: deps.config.store.store_id,
        mountPath: deps.config.web_voice_bridge.mount_path,
        browserVad: deps.config.web_voice_bridge.browser_vad,
        sampleRate: deps.config.voice.sample_rate,
        sttDriver: deps.config.providers.stt.driver,
        defaultSurface: deps.config.web_voice_bridge.surface_defaults[0] ?? 'avatar',
      }),
    )
  })

  server.get('/health', async () => {
    const state = deps.manager.getState()
    return {
      status: 'ok',
      store_id: state.store_id,
      websocket_path: state.websocket_path,
      client_count: state.client_count,
      active_sessions: state.active_sessions,
      stt_driver: state.stt_driver,
      browser_vad: state.browser_vad,
      enabled: deps.config.web_voice_bridge.enabled,
    }
  })

  server.get('/state', async () => deps.manager.getState())

  return server
}

export class WebVoiceBridgeManager {
  private readonly clients = new Map<string, WebVoiceClientState>()
  private readonly sessionClients = new Map<string, Set<string>>()
  private readonly detectedSpeakers = new Set<string>()
  private readonly speakerPresenceRefs = new Map<string, number>()
  private readonly responseActive = new Set<string>()
  private readonly activeAudioSegments = new Map<string, Set<string>>()
  private readonly pendingResponseEnd = new Map<string, Record<string, unknown>>()

  constructor(
    private readonly deps: {
      bus: IEventBus
      config: StoreConfig
      stt: ReturnType<typeof createSTTProvider>
    },
  ) {}

  attachClient(socket: WebSocket): WebVoiceClientState {
    const clientId = randomUUID()
    const client = createInitialClientState(clientId, socket)
    this.clients.set(clientId, client)
    this.send(client, {
      type: 'turn_state',
      state: 'idle',
      session_id: null,
      timestamp: Date.now(),
    })
    return client
  }

  getState(): BridgeServiceState {
    const clients = [...this.clients.values()].map((client) => ({
      client_id: client.id,
      session_id: client.sessionId,
      speaker_id: client.speakerId,
      surface: client.surface,
      role: client.role,
      speech_active: client.speechActive,
      turn_state: client.turnState,
    }))

    return {
      store_id: this.deps.config.store.store_id,
      websocket_path: this.deps.config.web_voice_bridge.mount_path,
      client_count: clients.length,
      active_sessions: this.sessionClients.size,
      stt_driver: this.deps.config.providers.stt.driver,
      browser_vad: this.deps.config.web_voice_bridge.browser_vad,
      clients,
    }
  }

  async handleSocketMessage(clientId: string, raw: RawData): Promise<void> {
    const client = this.clients.get(clientId)
    if (!client) {
      return
    }

    const text = raw instanceof Buffer ? raw.toString('utf8') : String(raw)
    let payload: z.infer<typeof ClientMessageSchema>

    try {
      payload = ClientMessageSchema.parse(JSON.parse(text))
    } catch (error) {
      this.sendError(
        client,
        `Invalid message: ${error instanceof Error ? error.message : String(error)}`,
      )
      return
    }

    switch (payload.type) {
      case 'hello':
        await this.handleHello(client, payload)
        return
      case 'ping':
        this.send(client, {
          type: 'pong',
          timestamp: payload.timestamp ?? Date.now(),
        })
        return
      case 'interrupt':
        await this.handleInterrupt(client)
        return
      case 'vad_start':
        await this.handleVadStart(client)
        return
      case 'vad_stop':
        await this.handleVadStop(client)
        return
      case 'audio_chunk':
        await this.handleAudioChunk(client, payload.data)
        return
      case 'text_input':
        await this.handleTextInput(client, payload.text)
        return
    }
  }

  async disconnectClient(clientId: string): Promise<void> {
    const client = this.clients.get(clientId)
    if (!client) {
      return
    }

    this.removeClientFromSession(client)
    this.decrementSpeakerPresence(client.sessionId, client.speakerId)
    await this.releaseSpeakerPresence(client.sessionId, client.speakerId)
    this.disposeRecognitionSession(client)
    this.clients.delete(clientId)
  }

  async closeAllClients(): Promise<void> {
    for (const client of [...this.clients.values()]) {
      if (
        client.socket.readyState === WebSocket.OPEN ||
        client.socket.readyState === WebSocket.CONNECTING
      ) {
        client.socket.terminate()
      }
      await this.disconnectClient(client.id)
    }
  }

  async handleBusEvent(channel: (typeof BRIDGE_CHANNELS)[number], payload: unknown): Promise<void> {
    const event = payload as Record<string, unknown>
    const sessionId = typeof event.session_id === 'string' ? event.session_id : null
    if (!sessionId) {
      return
    }

    switch (channel) {
      case 'bus:SPEECH_PARTIAL':
        this.broadcast(sessionId, {
          type: 'partial_transcript',
          session_id: sessionId,
          speaker_id: readString(event.speaker_id),
          text: readString(event.text) ?? '',
          timestamp: readNumber(event.timestamp) ?? Date.now(),
        })
        return
      case 'bus:SPEECH_FINAL':
        this.broadcast(sessionId, {
          type: 'final_transcript',
          session_id: sessionId,
          speaker_id: readString(event.speaker_id),
          text: readString(event.text) ?? '',
          timestamp: readNumber(event.timestamp) ?? Date.now(),
        })
        return
      case 'bus:RESPONSE_START':
        this.responseActive.add(sessionId)
        this.pendingResponseEnd.delete(sessionId)
        this.broadcastTurnState(sessionId, 'thinking', {
          turn_id: readString(event.turn_id),
          timestamp: readNumber(event.timestamp),
        })
        return
      case 'bus:AVATAR_SPEAK':
        this.responseActive.add(sessionId)
        this.broadcast(sessionId, {
          type: 'assistant_text',
          session_id: sessionId,
          turn_id: readString(event.turn_id),
          text: readString(event.text) ?? '',
          timestamp: readNumber(event.timestamp) ?? Date.now(),
          is_final: readBoolean(event.is_final) ?? true,
        })
        this.broadcastTurnState(sessionId, 'speaking', {
          turn_id: readString(event.turn_id),
          timestamp: readNumber(event.timestamp),
        })
        return
      case 'bus:TTS_SEGMENT_START':
        this.markAudioSegmentStarted(sessionId, readString(event.segment_id))
        this.broadcast(sessionId, {
          type: 'assistant_audio_start',
          session_id: sessionId,
          segment_id: readString(event.segment_id),
          encoding: readString(event.encoding),
          mime_type: readString(event.mime_type),
          sample_rate: readNumber(event.sample_rate),
          channels: readNumber(event.channels),
          browser_playable: readBoolean(event.browser_playable) ?? false,
          timestamp: readNumber(event.timestamp) ?? Date.now(),
        })
        this.broadcastTurnState(sessionId, 'speaking', {
          segment_id: readString(event.segment_id),
          timestamp: readNumber(event.timestamp),
        })
        return
      case 'bus:TTS_AUDIO_CHUNK':
        this.broadcast(sessionId, {
          type: 'assistant_audio_chunk',
          session_id: sessionId,
          segment_id: readString(event.segment_id),
          chunk_index: readNumber(event.chunk_index),
          chunk_base64: readString(event.chunk_base64),
          encoding: readString(event.encoding),
          mime_type: readString(event.mime_type),
          sample_rate: readNumber(event.sample_rate),
          channels: readNumber(event.channels),
          browser_playable: readBoolean(event.browser_playable) ?? false,
          timestamp: readNumber(event.timestamp) ?? Date.now(),
        })
        return
      case 'bus:TTS_SEGMENT_END':
        this.markAudioSegmentEnded(sessionId, readString(event.segment_id))
        this.broadcast(sessionId, {
          type: 'assistant_audio_end',
          session_id: sessionId,
          segment_id: readString(event.segment_id),
          reason: readString(event.reason),
          chunk_count: readNumber(event.chunk_count),
          total_bytes: readNumber(event.total_bytes),
          error_message: readString(event.error_message),
          encoding: readString(event.encoding),
          mime_type: readString(event.mime_type),
          sample_rate: readNumber(event.sample_rate),
          channels: readNumber(event.channels),
          browser_playable: readBoolean(event.browser_playable) ?? false,
          timestamp: readNumber(event.timestamp) ?? Date.now(),
        })
        this.maybeBroadcastIdleAfterAudioEnd(sessionId)
        return
      case 'bus:RESPONSE_END':
        this.responseActive.delete(sessionId)
        const endPayload = {
          turn_id: readString(event.turn_id),
          timestamp: readNumber(event.timestamp),
          reason: readString(event.reason),
        }
        if (this.hasActiveAudioSegments(sessionId)) {
          this.pendingResponseEnd.set(sessionId, endPayload)
        } else {
          this.broadcastTurnState(sessionId, 'idle', endPayload)
        }
        for (const clientId of this.sessionClients.get(sessionId) ?? []) {
          const client = this.clients.get(clientId)
          if (client) {
            client.bargeInSent = false
          }
        }
        return
      case 'bus:BARGE_IN':
        this.pendingResponseEnd.delete(sessionId)
        this.broadcastTurnState(sessionId, 'interrupted', {
          timestamp: readNumber(event.timestamp),
        })
        return
    }
  }

  private async handleHello(
    client: WebVoiceClientState,
    payload: z.infer<typeof HelloMessageSchema>,
  ): Promise<void> {
    if (payload.store_id && payload.store_id !== this.deps.config.store.store_id) {
      this.sendError(client, `Store mismatch: expected ${this.deps.config.store.store_id}`)
      return
    }

    const previousSessionId = client.sessionId
    const previousSpeakerId = client.speakerId
    const previousPresenceKey = this.getSpeakerPresenceKey(previousSessionId, previousSpeakerId)
    const speakerId =
      normalizeSpeakerId(payload.speaker_id) ?? `web_customer_${client.id.slice(0, 8)}`
    const sessionId =
      payload.session_id?.trim() ||
      buildSpeakerSessionId(this.deps.config.store.store_id, speakerId)
    const nextPresenceKey = this.getSpeakerPresenceKey(sessionId, speakerId)
    const role = payload.role ?? 'customer'
    const surface =
      payload.surface ?? this.deps.config.web_voice_bridge.surface_defaults[0] ?? 'avatar'

    if (previousPresenceKey && previousPresenceKey !== nextPresenceKey) {
      if (previousSessionId) {
        this.removeClientFromSession({
          id: client.id,
          sessionId: previousSessionId,
        })
      }
      this.decrementSpeakerPresence(previousSessionId, previousSpeakerId)
      await this.releaseSpeakerPresence(previousSessionId, previousSpeakerId)
      this.disposeRecognitionSession(client)
      client.bargeInSent = false
    }

    client.sessionId = sessionId
    client.speakerId = speakerId
    client.role = role
    client.surface = surface
    client.turnState = 'listening'

    if (previousPresenceKey !== nextPresenceKey) {
      this.incrementSpeakerPresence(sessionId, speakerId)
    }
    this.addClientToSession(client, sessionId)

    this.send(client, {
      type: 'ready',
      session_id: sessionId,
      speaker_id: speakerId,
      role,
      surface,
      store_id: this.deps.config.store.store_id,
      stt_driver: this.deps.config.providers.stt.driver,
      browser_vad: this.deps.config.web_voice_bridge.browser_vad,
      timestamp: Date.now(),
    })

    this.send(client, {
      type: 'turn_state',
      state: 'listening',
      session_id: sessionId,
      timestamp: Date.now(),
    })
  }

  private async handleInterrupt(client: WebVoiceClientState): Promise<void> {
    if (!client.sessionId) {
      this.sendError(client, 'Send hello before requesting interruption')
      return
    }

    client.bargeInSent = true
    await this.deps.bus.publish('bus:BARGE_IN', {
      event: 'BARGE_IN',
      session_id: client.sessionId,
      timestamp: Date.now(),
    })
  }

  private async handleVadStart(client: WebVoiceClientState): Promise<void> {
    await this.ensureRecognitionSession(client)
    client.speechActive = true
    client.turnState = 'speech_detected'
    await this.maybePublishBargeIn(client)
    this.send(client, {
      type: 'turn_state',
      state: 'speech_detected',
      session_id: client.sessionId,
      timestamp: Date.now(),
    })
  }

  private async handleVadStop(client: WebVoiceClientState): Promise<void> {
    if (!client.sessionId) {
      this.sendError(client, 'Send hello before VAD events')
      return
    }

    client.speechActive = false
    client.turnState = 'transcribing'
    this.send(client, {
      type: 'turn_state',
      state: 'transcribing',
      session_id: client.sessionId,
      timestamp: Date.now(),
    })
    if (client.sttSession) {
      client.sttSession.end()
      client.sttSession.close()
      client.sttSession = null
    }
    client.bargeInSent = false
  }

  private async handleAudioChunk(client: WebVoiceClientState, base64: string): Promise<void> {
    await this.ensureRecognitionSession(client)
    await this.maybePublishBargeIn(client)
    client.speechActive = true

    if (!client.sttSession) {
      this.sendError(client, 'Recognition session is not available')
      return
    }

    let buffer: Buffer
    try {
      buffer = Buffer.from(base64, 'base64')
    } catch {
      this.sendError(client, 'audio_chunk.data must be base64')
      return
    }

    client.sttSession.push(buffer)
  }

  private async handleTextInput(client: WebVoiceClientState, text: string): Promise<void> {
    if (!client.sessionId || !client.speakerId) {
      this.sendError(client, 'Send hello before text_input')
      return
    }

    await this.ensureSpeakerDetected(client)
    await this.maybePublishBargeIn(client)
    const timestamp = Date.now()

    await this.deps.bus.publish('bus:SPEECH_PARTIAL', {
      event: 'SPEECH_PARTIAL',
      session_id: client.sessionId,
      speaker_id: client.speakerId,
      role: client.role,
      actor_type: client.role,
      store_id: this.deps.config.store.store_id,
      locale: this.deps.config.store.locale,
      text,
      timestamp,
    })

    await this.deps.bus.publish('bus:SPEECH_FINAL', {
      event: 'SPEECH_FINAL',
      session_id: client.sessionId,
      speaker_id: client.speakerId,
      role: client.role,
      actor_type: client.role,
      store_id: this.deps.config.store.store_id,
      locale: this.deps.config.store.locale,
      text,
      timestamp: timestamp + 1,
    })
  }

  private async ensureRecognitionSession(client: WebVoiceClientState): Promise<void> {
    if (client.sttSession) {
      return
    }

    if (!client.sessionId || !client.speakerId) {
      this.sendError(client, 'Send hello before audio')
      return
    }

    await this.ensureSpeakerDetected(client)

    const session = await this.deps.stt.startSession(
      (chunk) => {
        client.speechPublishChain = client.speechPublishChain
          .then(() => this.publishSpeechChunk(client, chunk))
          .catch((error) => {
            this.sendError(client, error instanceof Error ? error.message : String(error))
          })
      },
      (error) => {
        this.sendError(client, error.message)
      },
    )

    client.sttSession = session
  }

  private async ensureSpeakerDetected(client: WebVoiceClientState): Promise<void> {
    if (!client.sessionId || !client.speakerId) {
      return
    }

    const presenceKey = this.getSpeakerPresenceKey(client.sessionId, client.speakerId)
    if (!presenceKey || this.detectedSpeakers.has(presenceKey)) {
      return
    }

    this.detectedSpeakers.add(presenceKey)
    try {
      await this.deps.bus.publish('bus:SPEAKER_DETECTED', {
        event: 'SPEAKER_DETECTED',
        session_id: client.sessionId,
        speaker_id: client.speakerId,
        store_id: this.deps.config.store.store_id,
      })
    } catch (error) {
      this.detectedSpeakers.delete(presenceKey)
      throw error
    }
  }

  private async maybePublishBargeIn(client: WebVoiceClientState): Promise<void> {
    if (
      !this.deps.config.voice.barge_in_enabled ||
      !client.sessionId ||
      client.bargeInSent ||
      !this.isAssistantActive(client.sessionId)
    ) {
      return
    }

    client.bargeInSent = true
    await this.deps.bus.publish('bus:BARGE_IN', {
      event: 'BARGE_IN',
      session_id: client.sessionId,
      timestamp: Date.now(),
    })
  }

  private isAssistantActive(sessionId: string): boolean {
    return this.responseActive.has(sessionId) || this.hasActiveAudioSegments(sessionId)
  }

  private async publishSpeechChunk(
    client: WebVoiceClientState,
    chunk: STTTranscriptChunk,
  ): Promise<void> {
    if (!client.sessionId || !client.speakerId) {
      return
    }

    const channel = chunk.type === 'partial' ? 'bus:SPEECH_PARTIAL' : 'bus:SPEECH_FINAL'

    if (chunk.type === 'final') {
      client.bargeInSent = false
    }

    await this.deps.bus.publish(channel, {
      event: chunk.type === 'partial' ? 'SPEECH_PARTIAL' : 'SPEECH_FINAL',
      session_id: client.sessionId,
      speaker_id: client.speakerId,
      role: client.role,
      actor_type: client.role,
      store_id: this.deps.config.store.store_id,
      locale: this.deps.config.store.locale,
      text: chunk.text,
      timestamp: chunk.timestamp,
    })
  }

  private addClientToSession(client: WebVoiceClientState, sessionId: string): void {
    const clients = this.sessionClients.get(sessionId) ?? new Set<string>()
    clients.add(client.id)
    this.sessionClients.set(sessionId, clients)
  }

  private incrementSpeakerPresence(sessionId: string | null, speakerId: string | null): void {
    const presenceKey = this.getSpeakerPresenceKey(sessionId, speakerId)
    if (!presenceKey) {
      return
    }

    this.speakerPresenceRefs.set(presenceKey, (this.speakerPresenceRefs.get(presenceKey) ?? 0) + 1)
  }

  private decrementSpeakerPresence(sessionId: string | null, speakerId: string | null): void {
    const presenceKey = this.getSpeakerPresenceKey(sessionId, speakerId)
    if (!presenceKey) {
      return
    }

    const nextCount = (this.speakerPresenceRefs.get(presenceKey) ?? 0) - 1
    if (nextCount > 0) {
      this.speakerPresenceRefs.set(presenceKey, nextCount)
      return
    }

    this.speakerPresenceRefs.delete(presenceKey)
  }

  private getSpeakerPresenceKey(sessionId: string | null, speakerId: string | null): string | null {
    if (!sessionId || !speakerId) {
      return null
    }

    return `${sessionId}::${speakerId}`
  }

  private removeClientFromSession(client: { id: string; sessionId: string | null }): void {
    if (!client.sessionId) {
      return
    }

    const clients = this.sessionClients.get(client.sessionId)
    if (!clients) {
      return
    }

    clients.delete(client.id)
    if (clients.size === 0) {
      this.sessionClients.delete(client.sessionId)
    }
  }

  private broadcast(sessionId: string, payload: Record<string, unknown>): void {
    for (const clientId of this.sessionClients.get(sessionId) ?? []) {
      const client = this.clients.get(clientId)
      if (!client) {
        continue
      }

      this.send(client, payload)
    }
  }

  private broadcastTurnState(
    sessionId: string,
    state: TurnState,
    extra: Record<string, unknown>,
  ): void {
    for (const clientId of this.sessionClients.get(sessionId) ?? []) {
      const client = this.clients.get(clientId)
      if (!client) {
        continue
      }

      client.turnState = state
      if (state === 'idle') {
        client.bargeInSent = false
      }
      this.send(client, {
        type: 'turn_state',
        state,
        session_id: sessionId,
        ...extra,
      })
    }
  }

  private hasActiveAudioSegments(sessionId: string): boolean {
    return (this.activeAudioSegments.get(sessionId)?.size ?? 0) > 0
  }

  private markAudioSegmentStarted(sessionId: string, segmentId: string | undefined): void {
    if (!segmentId) {
      return
    }

    const segments = this.activeAudioSegments.get(sessionId) ?? new Set<string>()
    segments.add(segmentId)
    this.activeAudioSegments.set(sessionId, segments)
  }

  private markAudioSegmentEnded(sessionId: string, segmentId: string | undefined): void {
    if (!segmentId) {
      return
    }

    const segments = this.activeAudioSegments.get(sessionId)
    if (!segments) {
      return
    }

    segments.delete(segmentId)
    if (segments.size === 0) {
      this.activeAudioSegments.delete(sessionId)
    }
  }

  private maybeBroadcastIdleAfterAudioEnd(sessionId: string): void {
    if (this.hasActiveAudioSegments(sessionId) || this.responseActive.has(sessionId)) {
      return
    }

    const pending = this.pendingResponseEnd.get(sessionId)
    if (!pending) {
      return
    }

    this.pendingResponseEnd.delete(sessionId)
    this.broadcastTurnState(sessionId, 'idle', pending)
  }

  private async releaseSpeakerPresence(
    sessionId: string | null,
    speakerId: string | null,
  ): Promise<void> {
    const presenceKey = this.getSpeakerPresenceKey(sessionId, speakerId)
    if (!presenceKey || !sessionId || !speakerId || !this.detectedSpeakers.has(presenceKey)) {
      return
    }

    if ((this.speakerPresenceRefs.get(presenceKey) ?? 0) > 0) {
      return
    }

    await this.deps.bus.publish('bus:SPEAKER_LOST', {
      event: 'SPEAKER_LOST',
      session_id: sessionId,
      speaker_id: speakerId,
      timestamp: Date.now(),
    })
    this.detectedSpeakers.delete(presenceKey)
  }

  private disposeRecognitionSession(client: WebVoiceClientState): void {
    client.sttSession?.close()
    client.sttSession = null
    client.speechActive = false
  }

  private send(client: WebVoiceClientState, payload: Record<string, unknown>): void {
    if (client.socket.readyState !== WebSocket.OPEN) {
      return
    }

    client.socket.send(JSON.stringify(payload))
  }

  private sendError(client: WebVoiceClientState, message: string): void {
    this.send(client, {
      type: 'error',
      message,
      timestamp: Date.now(),
    })
  }
}

export async function startWebVoiceBridgeService(deps: {
  configPath: string
  bus?: IEventBus
  host?: string
  port?: number
}): Promise<{
  manager: WebVoiceBridgeManager
  server: FastifyInstance
  shutdown(): Promise<void>
}> {
  const config = await loadStoreConfig(deps.configPath)

  if (!config.web_voice_bridge.enabled) {
    throw new Error('Web voice bridge requires web_voice_bridge.enabled=true in store config')
  }

  if (!deps.bus && config.providers.bus.driver !== 'redis') {
    throw new Error(
      'Web voice bridge requires providers.bus.driver="redis" when no bus override is provided',
    )
  }

  const bus =
    deps.bus ??
    (await createBus({
      redisUrl: config.providers.bus.driver === 'redis' ? config.providers.bus.url : undefined,
    }))
  const stt = createSTTProvider(config.providers.stt)

  const manager = new WebVoiceBridgeManager({
    bus,
    config,
    stt,
  })
  const server = buildWebVoiceBridgeServer({ config, manager })
  const wss = new WebSocketServer({ noServer: true })

  const unsubscribes = BRIDGE_CHANNELS.map((channel) =>
    bus.subscribe(channel, (payload) => {
      void manager.handleBusEvent(channel, payload)
    }),
  )

  wss.on('connection', (socket) => {
    const client = manager.attachClient(socket)

    socket.on('message', (raw) => {
      client.messageChain = client.messageChain
        .then(() => manager.handleSocketMessage(client.id, raw))
        .catch((error) => {
          socket.send(
            JSON.stringify({
              type: 'error',
              message: error instanceof Error ? error.message : String(error),
              timestamp: Date.now(),
            }),
          )
        })
    })

    socket.on('close', () => {
      void manager.disconnectClient(client.id)
    })

    socket.on('error', () => {
      void manager.disconnectClient(client.id)
    })
  })

  const upgradeHandler = (request: IncomingMessage, socket: Duplex, head: Buffer) => {
    const url = new URL(request.url ?? DEFAULT_WEB_VOICE_BRIDGE_PATH, 'http://localhost')
    if (url.pathname !== config.web_voice_bridge.mount_path) {
      return
    }

    wss.handleUpgrade(request, socket, head, (ws) => {
      wss.emit('connection', ws, request)
    })
  }

  server.server.on('upgrade', upgradeHandler)

  await server.listen({
    host:
      deps.host ??
      process.env.WEB_VOICE_BRIDGE_HOST ??
      config.web_voice_bridge.host ??
      DEFAULT_WEB_VOICE_BRIDGE_HOST,
    port:
      deps.port ??
      readPort(
        process.env.WEB_VOICE_BRIDGE_PORT,
        config.web_voice_bridge.port ?? DEFAULT_WEB_VOICE_BRIDGE_PORT,
      ),
  })

  let closed = false

  return {
    manager,
    server,
    async shutdown() {
      if (closed) {
        return
      }
      closed = true

      server.server.removeListener('upgrade', upgradeHandler)
      for (const unsubscribe of unsubscribes) {
        unsubscribe()
      }

      await manager.closeAllClients()

      await new Promise<void>((resolve) => {
        wss.close(() => resolve())
      })

      await server.close().catch(() => {})
      stt.dispose()

      if (!deps.bus && 'disconnect' in bus && typeof bus.disconnect === 'function') {
        await bus.disconnect().catch(() => {})
      }
    },
  }
}

async function main(): Promise<void> {
  dotenv.config()

  const configPath = resolveConfigPath(process.argv.slice(2))
  const service = await startWebVoiceBridgeService({ configPath })

  const shutdown = async () => {
    await service.shutdown()
  }

  process.on('SIGTERM', () => {
    void shutdown()
  })
  process.on('SIGINT', () => {
    void shutdown()
  })
}

function readPort(value: string | undefined, fallback: number): number {
  const parsed = value ? Number(value) : NaN
  return Number.isFinite(parsed) && parsed > 0 ? parsed : fallback
}

function readString(value: unknown): string | undefined {
  return typeof value === 'string' ? value : undefined
}

function readNumber(value: unknown): number | undefined {
  return typeof value === 'number' ? value : undefined
}

function readBoolean(value: unknown): boolean | undefined {
  return typeof value === 'boolean' ? value : undefined
}

function normalizeSpeakerId(value: string | undefined): string | null {
  if (!value) {
    return null
  }

  const normalized = value.trim().replace(/[^a-zA-Z0-9_-]+/g, '_')
  return normalized || null
}

if (isEntrypoint(import.meta.url)) {
  main().catch((error) => {
    console.error(
      '[store-runtime/web-voice-bridge] Boot failed:',
      error instanceof Error ? error.message : error,
    )
    process.exitCode = 1
  })
}
