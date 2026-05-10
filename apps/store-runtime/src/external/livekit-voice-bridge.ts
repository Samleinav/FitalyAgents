import dotenv from 'dotenv'
import Fastify, { type FastifyInstance } from 'fastify'
import { createBus, type HumanRole, type IEventBus } from 'fitalyagents'
import type * as LiveKitRtc from '@livekit/rtc-node'
import { z } from 'zod'
import { buildSpeakerSessionId } from '../bootstrap/speaker-session.js'
import { isEntrypoint } from '../cli/is-entrypoint.js'
import { resolveConfigPath } from '../cli/resolve-config-path.js'
import { HUMAN_ROLE_VALUES } from '../config/human-roles.js'
import { loadStoreConfig } from '../config/load-store-config.js'
import type { StoreConfig } from '../config/schema.js'

export const LIVEKIT_BRIDGE_CHANNELS = [
  'bus:RESPONSE_START',
  'bus:AVATAR_SPEAK',
  'bus:TTS_SEGMENT_START',
  'bus:TTS_AUDIO_CHUNK',
  'bus:TTS_SEGMENT_END',
  'bus:RESPONSE_END',
  'bus:BARGE_IN',
] as const

export type LiveKitBridgeChannel = (typeof LIVEKIT_BRIDGE_CHANNELS)[number]

export interface LiveKitTranscriptInput {
  participantIdentity: string
  participantMetadata?: unknown
  sessionId?: string
  speakerId?: string
  role?: HumanRole
  text: string
  final?: boolean
  locale?: string
  timestamp?: number
}

export interface LiveKitBridgeOutboundEvent {
  type: 'runtime_event'
  channel: LiveKitBridgeChannel
  payload: unknown
  timestamp: number
}

export interface LiveKitBridgeTransport {
  start?(manager: LiveKitVoiceBridgeManager): Promise<void>
  send(event: LiveKitBridgeOutboundEvent): Promise<void>
  closeRoom?(reason?: string): Promise<void>
  close?(): Promise<void>
}

type LiveKitRtcModule = typeof LiveKitRtc

interface LiveKitParticipantState {
  participantIdentity: string
  sessionId: string
  speakerId: string
  role: HumanRole
  detected: boolean
  speechActive: boolean
  bargeInSent: boolean
  lastTranscriptAt: number | null
}

interface LiveKitBridgeState {
  store_id: string
  enabled: boolean
  agent_name: string
  transport: StoreConfig['livekit_voice_bridge']['transport']
  participant_count: number
  active_sessions: number
  response_sessions: number
  active_audio_segments: number
  room_connected: boolean
  room_idle_timeout_ms: number
  participants: Array<{
    participant_identity: string
    session_id: string
    speaker_id: string
    role: HumanRole
    speech_active: boolean
    last_transcript_at: number | null
  }>
}

const DebugTranscriptSchema = z.object({
  participant_identity: z.string().min(1),
  participant_metadata: z.unknown().optional(),
  session_id: z.string().min(1).optional(),
  speaker_id: z.string().min(1).optional(),
  role: z.enum(HUMAN_ROLE_VALUES).optional(),
  text: z.string().min(1),
  final: z.boolean().default(true),
  locale: z.string().optional(),
  timestamp: z.number().optional(),
})

const LiveKitTranscriptDataSchema = z.object({
  type: z.enum(['transcript', 'speech']).default('transcript'),
  participant_identity: z.string().min(1).optional(),
  participant_metadata: z.unknown().optional(),
  session_id: z.string().min(1).optional(),
  speaker_id: z.string().min(1).optional(),
  role: z.enum(HUMAN_ROLE_VALUES).optional(),
  text: z.string().min(1),
  final: z.boolean().default(true),
  locale: z.string().optional(),
  timestamp: z.number().optional(),
})

const LiveKitClientTokenQuerySchema = z.object({
  identity: z.string().min(1).optional(),
  role: z.enum(HUMAN_ROLE_VALUES).default('customer'),
})

export class NoopLiveKitBridgeTransport implements LiveKitBridgeTransport {
  readonly sent: LiveKitBridgeOutboundEvent[] = []
  closeRoomCalls = 0

  async send(event: LiveKitBridgeOutboundEvent): Promise<void> {
    this.sent.push(event)
  }

  async closeRoom(): Promise<void> {
    this.closeRoomCalls += 1
  }
}

export class LiveKitRtcBridgeTransport implements LiveKitBridgeTransport {
  private room: Awaited<ReturnType<typeof createLiveKitRoom>> | null = null
  private rtc: LiveKitRtcModule | null = null
  private audioSource: InstanceType<LiveKitRtcModule['AudioSource']> | null = null
  private audioTrack: InstanceType<LiveKitRtcModule['LocalAudioTrack']> | null = null
  private idleTimer: ReturnType<typeof setTimeout> | null = null
  private starting: Promise<void> | null = null

  constructor(private readonly config: StoreConfig) {}

  async start(manager: LiveKitVoiceBridgeManager): Promise<void> {
    if (this.room?.localParticipant) {
      this.cancelIdleClose()
      this.scheduleIdleCloseIfEmpty('start_existing')
      return
    }

    if (this.starting) {
      await this.starting
      return
    }

    this.starting = this.connectRoom(manager).finally(() => {
      this.starting = null
    })
    await this.starting
  }

  isRoomConnected(): boolean {
    return Boolean(this.room?.localParticipant)
  }

  async closeRoom(reason = 'manual'): Promise<void> {
    this.cancelIdleClose()
    const roomName = resolveLiveKitRoomName(this.config)
    await this.closeLocalRoom()
    await this.deleteLiveKitRoom(roomName, reason)
  }

  private async connectRoom(manager: LiveKitVoiceBridgeManager): Promise<void> {
    const livekit = await import('@livekit/rtc-node')
    const { AccessToken, RoomServiceClient } = await import('livekit-server-sdk')
    this.rtc = livekit

    const bridgeConfig = this.config.livekit_voice_bridge
    const url = readRequiredEnv(bridgeConfig.websocket_url_env)
    const apiKey = readRequiredEnv(bridgeConfig.api_key_env)
    const apiSecret = readRequiredEnv(bridgeConfig.api_secret_env)
    const roomName = resolveLiveKitRoomName(this.config)
    const identity = bridgeConfig.participant_identity

    const roomService = new RoomServiceClient(toLiveKitHttpUrl(url), apiKey, apiSecret)
    await roomService
      .createRoom({
        name: roomName,
        emptyTimeout: Math.max(5, Math.ceil(bridgeConfig.room_idle_timeout_ms / 1000)),
        departureTimeout: Math.max(5, Math.ceil(bridgeConfig.room_idle_timeout_ms / 1000)),
      })
      .catch(() => {})

    const tokenBuilder = new AccessToken(apiKey, apiSecret, {
      identity,
      name: bridgeConfig.agent_name,
      ttl: bridgeConfig.token_ttl,
    })
    tokenBuilder.addGrant({
      room: roomName,
      roomJoin: true,
      canPublish: true,
      canSubscribe: true,
      canPublishData: true,
    })

    const token = await tokenBuilder.toJwt()
    const room = createLiveKitRoom(livekit)
    this.room = room

    room
      .on(livekit.RoomEvent.ParticipantConnected, (participant) => {
        this.cancelIdleClose()
        void manager.ensureParticipantDetected({
          participantIdentity: participant.identity,
          participantMetadata: participant.metadata,
          role: readMetadataRole(participant.metadata),
        })
      })
      .on(livekit.RoomEvent.ParticipantDisconnected, (participant) => {
        void manager.disconnectParticipant(participant.identity)
        this.scheduleIdleCloseIfEmpty('participant_disconnected')
      })
      .on(livekit.RoomEvent.Disconnected, () => {
        this.cancelIdleClose()
        this.room = null
        this.audioSource = null
        this.audioTrack = null
        void manager.disconnectAllParticipants(Date.now())
      })
      .on(livekit.RoomEvent.DataReceived, (payload, participant, _kind, topic) => {
        if (topic !== bridgeConfig.input_topic) {
          return
        }
        void this.handleIncomingTranscriptData(manager, payload, participant?.identity)
      })

    room.registerTextStreamHandler(bridgeConfig.input_topic, (reader, participantInfo) => {
      void reader.readAll().then((text) => {
        void this.handleIncomingTranscriptText(manager, text, participantInfo.identity)
      })
    })

    await room.connect(url, token, { autoSubscribe: true, dynacast: true })

    for (const participant of room.remoteParticipants.values()) {
      await manager.ensureParticipantDetected({
        participantIdentity: participant.identity,
        participantMetadata: participant.metadata,
        role: readMetadataRole(participant.metadata),
      })
    }

    if (bridgeConfig.forward_tts_audio) {
      await this.publishAudioTrack(livekit, room)
    }

    this.scheduleIdleCloseIfEmpty('start')
  }

  async send(event: LiveKitBridgeOutboundEvent): Promise<void> {
    const room = this.room
    const participant = room?.localParticipant
    if (!participant) {
      return
    }

    const payload = JSON.stringify(event)
    await participant.publishData(new TextEncoder().encode(payload), {
      reliable: true,
      topic: this.config.livekit_voice_bridge.output_topic,
    })

    if (this.config.livekit_voice_bridge.forward_tts_audio) {
      await this.maybeCaptureAudio(event)
    }
  }

  async close(): Promise<void> {
    this.cancelIdleClose()
    await this.closeLocalRoom()

    if (this.rtc) {
      await this.rtc.dispose().catch(() => {})
      this.rtc = null
    }
  }

  private async closeLocalRoom(): Promise<void> {
    await this.audioTrack?.close().catch(() => {})
    this.audioTrack = null
    this.audioSource = null

    await this.room?.disconnect().catch(() => {})
    this.room = null
  }

  private scheduleIdleCloseIfEmpty(reason: string): void {
    const timeoutMs = this.config.livekit_voice_bridge.room_idle_timeout_ms
    if (!this.room || this.room.remoteParticipants.size > 0 || this.idleTimer) {
      return
    }

    this.idleTimer = setTimeout(() => {
      this.idleTimer = null
      if (!this.room || this.room.remoteParticipants.size > 0) {
        return
      }

      void this.closeRoom(`idle:${reason}`).catch(() => {})
    }, timeoutMs)
  }

  private cancelIdleClose(): void {
    if (!this.idleTimer) {
      return
    }

    clearTimeout(this.idleTimer)
    this.idleTimer = null
  }

  private async deleteLiveKitRoom(roomName: string, _reason: string): Promise<void> {
    if (!this.config.livekit_voice_bridge.delete_room_on_idle) {
      return
    }

    const { RoomServiceClient } = await import('livekit-server-sdk')
    const bridgeConfig = this.config.livekit_voice_bridge
    const url = readRequiredEnv(bridgeConfig.websocket_url_env)
    const apiKey = readRequiredEnv(bridgeConfig.api_key_env)
    const apiSecret = readRequiredEnv(bridgeConfig.api_secret_env)
    const roomService = new RoomServiceClient(toLiveKitHttpUrl(url), apiKey, apiSecret)

    await roomService.deleteRoom(roomName).catch(() => {})
  }

  private async handleIncomingTranscriptData(
    manager: LiveKitVoiceBridgeManager,
    payload: Uint8Array,
    participantIdentity?: string,
  ): Promise<void> {
    const text = new TextDecoder().decode(payload)
    await this.handleIncomingTranscriptText(manager, text, participantIdentity)
  }

  private async handleIncomingTranscriptText(
    manager: LiveKitVoiceBridgeManager,
    text: string,
    participantIdentity?: string,
  ): Promise<void> {
    let parsed: z.infer<typeof LiveKitTranscriptDataSchema>
    try {
      parsed = LiveKitTranscriptDataSchema.parse(JSON.parse(text))
    } catch {
      parsed = LiveKitTranscriptDataSchema.parse({
        participant_identity: participantIdentity,
        text,
        final: true,
      })
    }

    const resolvedParticipantIdentity = parsed.participant_identity ?? participantIdentity
    if (!resolvedParticipantIdentity) {
      return
    }

    await manager.ingestTranscript({
      participantIdentity: resolvedParticipantIdentity,
      participantMetadata: parsed.participant_metadata,
      sessionId: parsed.session_id,
      speakerId: parsed.speaker_id,
      role: parsed.role,
      text: parsed.text,
      final: parsed.final,
      locale: parsed.locale,
      timestamp: parsed.timestamp,
    })
  }

  private async publishAudioTrack(
    livekit: LiveKitRtcModule,
    room: Awaited<ReturnType<typeof createLiveKitRoom>>,
  ): Promise<void> {
    if (!room.localParticipant || this.audioSource || this.audioTrack) {
      return
    }

    this.audioSource = new livekit.AudioSource(this.config.voice.sample_rate, 1)
    this.audioTrack = livekit.LocalAudioTrack.createAudioTrack(
      this.config.livekit_voice_bridge.audio_track_name,
      this.audioSource,
    )
    const options = new livekit.TrackPublishOptions()
    options.source = livekit.TrackSource.SOURCE_MICROPHONE
    await room.localParticipant.publishTrack(this.audioTrack, options)
  }

  private async maybeCaptureAudio(event: LiveKitBridgeOutboundEvent): Promise<void> {
    if (event.channel !== 'bus:TTS_AUDIO_CHUNK' || !this.audioSource || !this.rtc) {
      return
    }

    const payload = event.payload as {
      chunk_base64?: unknown
      encoding?: unknown
      sample_rate?: unknown
      channels?: unknown
    }
    const encoding = typeof payload.encoding === 'string' ? payload.encoding : null
    const sampleRate = typeof payload.sample_rate === 'number' ? payload.sample_rate : null
    const channels = typeof payload.channels === 'number' ? payload.channels : 1
    const chunkBase64 = typeof payload.chunk_base64 === 'string' ? payload.chunk_base64 : null

    if (encoding !== 'pcm_s16le' || !sampleRate || channels !== 1 || !chunkBase64) {
      return
    }

    const pcm = Buffer.from(chunkBase64, 'base64')
    if (pcm.length < 2 || pcm.length % 2 !== 0) {
      return
    }

    const samples = new Int16Array(pcm.length / 2)
    for (let index = 0; index < samples.length; index += 1) {
      samples[index] = pcm.readInt16LE(index * 2)
    }

    await this.audioSource.captureFrame(
      new this.rtc.AudioFrame(samples, sampleRate, channels, samples.length),
    )
  }
}

export class LiveKitVoiceBridgeManager {
  private readonly participants = new Map<string, LiveKitParticipantState>()
  private readonly sessionParticipants = new Map<string, Set<string>>()
  private readonly responseActive = new Set<string>()
  private readonly activeAudioSegments = new Map<string, Set<string>>()
  private startPromise: Promise<void> | null = null

  constructor(
    private readonly deps: {
      bus: IEventBus
      config: StoreConfig
      transport: LiveKitBridgeTransport
    },
  ) {}

  async start(): Promise<void> {
    if (!this.deps.transport.start) {
      return
    }

    if (!this.startPromise) {
      this.startPromise = this.deps.transport.start(this).finally(() => {
        this.startPromise = null
      })
    }

    await this.startPromise
  }

  getState(): LiveKitBridgeState {
    const participants = [...this.participants.values()].map((participant) => ({
      participant_identity: participant.participantIdentity,
      session_id: participant.sessionId,
      speaker_id: participant.speakerId,
      role: participant.role,
      speech_active: participant.speechActive,
      last_transcript_at: participant.lastTranscriptAt,
    }))

    return {
      store_id: this.deps.config.store.store_id,
      enabled: this.deps.config.livekit_voice_bridge.enabled,
      agent_name: this.deps.config.livekit_voice_bridge.agent_name,
      transport: this.deps.config.livekit_voice_bridge.transport,
      participant_count: participants.length,
      active_sessions: this.sessionParticipants.size,
      response_sessions: this.responseActive.size,
      active_audio_segments: [...this.activeAudioSegments.values()].reduce(
        (count, segments) => count + segments.size,
        0,
      ),
      room_connected: readTransportConnected(this.deps.transport),
      room_idle_timeout_ms: this.deps.config.livekit_voice_bridge.room_idle_timeout_ms,
      participants,
    }
  }

  async ingestTranscript(input: LiveKitTranscriptInput): Promise<void> {
    const text = input.text.trim()
    if (!text) {
      return
    }

    const participant = await this.ensureParticipant(input)
    const timestamp = input.timestamp ?? Date.now()

    participant.speechActive = !input.final
    participant.lastTranscriptAt = timestamp

    if (!input.final && this.isSessionBusy(participant.sessionId) && !participant.bargeInSent) {
      participant.bargeInSent = true
      await this.deps.bus.publish('bus:BARGE_IN', {
        event: 'BARGE_IN',
        session_id: participant.sessionId,
        speaker_id: participant.speakerId,
        timestamp,
      })
    }

    if (input.final) {
      participant.bargeInSent = false
    }

    await this.deps.bus.publish(input.final ? 'bus:SPEECH_FINAL' : 'bus:SPEECH_PARTIAL', {
      event: input.final ? 'SPEECH_FINAL' : 'SPEECH_PARTIAL',
      session_id: participant.sessionId,
      text,
      speaker_id: participant.speakerId,
      role: participant.role,
      actor_type: participant.role,
      store_id: this.deps.config.store.store_id,
      locale: input.locale ?? this.deps.config.store.locale,
      timestamp,
      source: 'livekit',
      participant_identity: participant.participantIdentity,
    })
  }

  async ensureParticipantDetected(input: {
    participantIdentity: string
    participantMetadata?: unknown
    sessionId?: string
    speakerId?: string
    role?: HumanRole
    timestamp?: number
  }): Promise<void> {
    await this.ensureParticipant({
      participantIdentity: input.participantIdentity,
      participantMetadata: input.participantMetadata,
      sessionId: input.sessionId,
      speakerId: input.speakerId,
      role: input.role,
      text: '',
      final: true,
      timestamp: input.timestamp,
    })
  }

  async disconnectParticipant(participantIdentity: string, timestamp = Date.now()): Promise<void> {
    const participant = this.participants.get(participantIdentity)
    if (!participant) {
      return
    }

    this.participants.delete(participantIdentity)
    const sessionSet = this.sessionParticipants.get(participant.sessionId)
    sessionSet?.delete(participantIdentity)
    if (sessionSet?.size === 0) {
      this.sessionParticipants.delete(participant.sessionId)
    }

    if (participant.detected) {
      await this.deps.bus.publish('bus:SPEAKER_LOST', {
        event: 'SPEAKER_LOST',
        session_id: participant.sessionId,
        speaker_id: participant.speakerId,
        store_id: this.deps.config.store.store_id,
        timestamp,
        source: 'livekit',
        participant_identity: participant.participantIdentity,
      })
    }
  }

  async disconnectAllParticipants(timestamp = Date.now()): Promise<void> {
    for (const participantIdentity of [...this.participants.keys()]) {
      await this.disconnectParticipant(participantIdentity, timestamp)
    }

    this.responseActive.clear()
    this.activeAudioSegments.clear()
  }

  async handleBusEvent(channel: LiveKitBridgeChannel, payload: unknown): Promise<void> {
    const sessionId = readString((payload as { session_id?: unknown }).session_id)
    const segmentId = readString((payload as { segment_id?: unknown }).segment_id)

    switch (channel) {
      case 'bus:RESPONSE_START':
      case 'bus:AVATAR_SPEAK':
        if (sessionId) {
          this.responseActive.add(sessionId)
        }
        break
      case 'bus:TTS_SEGMENT_START':
        if (sessionId && segmentId) {
          this.markAudioSegmentStarted(sessionId, segmentId)
        }
        break
      case 'bus:TTS_SEGMENT_END':
        if (sessionId && segmentId) {
          this.markAudioSegmentEnded(sessionId, segmentId)
        }
        break
      case 'bus:RESPONSE_END':
      case 'bus:BARGE_IN':
        if (sessionId) {
          this.responseActive.delete(sessionId)
          this.resetBargeIn(sessionId)
        }
        break
      case 'bus:TTS_AUDIO_CHUNK':
        break
    }

    await this.deps.transport.send({
      type: 'runtime_event',
      channel,
      payload,
      timestamp: Date.now(),
    })
  }

  async close(): Promise<void> {
    await this.deps.transport.close?.()
  }

  async closeRoom(reason = 'manual'): Promise<void> {
    await this.disconnectAllParticipants(Date.now())
    await this.deps.transport.closeRoom?.(reason)
  }

  private async ensureParticipant(input: LiveKitTranscriptInput): Promise<LiveKitParticipantState> {
    const speakerId = this.resolveSpeakerId(input)
    const sessionId =
      input.sessionId ?? buildSpeakerSessionId(this.deps.config.store.store_id, speakerId)
    const existing = this.participants.get(input.participantIdentity)

    if (existing) {
      existing.role = input.role ?? existing.role
      return existing
    }

    const participant: LiveKitParticipantState = {
      participantIdentity: input.participantIdentity,
      sessionId,
      speakerId,
      role: input.role ?? 'customer',
      detected: true,
      speechActive: false,
      bargeInSent: false,
      lastTranscriptAt: null,
    }

    this.participants.set(input.participantIdentity, participant)
    if (!this.sessionParticipants.has(sessionId)) {
      this.sessionParticipants.set(sessionId, new Set())
    }
    this.sessionParticipants.get(sessionId)?.add(input.participantIdentity)

    await this.deps.bus.publish('bus:SPEAKER_DETECTED', {
      event: 'SPEAKER_DETECTED',
      session_id: sessionId,
      speaker_id: speakerId,
      store_id: this.deps.config.store.store_id,
      role: participant.role,
      source: 'livekit',
      participant_identity: input.participantIdentity,
      timestamp: input.timestamp ?? Date.now(),
    })

    return participant
  }

  private resolveSpeakerId(input: LiveKitTranscriptInput): string {
    if (input.speakerId) {
      return input.speakerId
    }

    if (this.deps.config.livekit_voice_bridge.speaker_id_source === 'participant_metadata') {
      const metadataSpeakerId = readMetadataString(input.participantMetadata, 'speaker_id')
      if (metadataSpeakerId) {
        return metadataSpeakerId
      }
    }

    return input.participantIdentity
  }

  private isSessionBusy(sessionId: string): boolean {
    return (
      this.responseActive.has(sessionId) || (this.activeAudioSegments.get(sessionId)?.size ?? 0) > 0
    )
  }

  private markAudioSegmentStarted(sessionId: string, segmentId: string): void {
    if (!this.activeAudioSegments.has(sessionId)) {
      this.activeAudioSegments.set(sessionId, new Set())
    }
    this.activeAudioSegments.get(sessionId)?.add(segmentId)
  }

  private markAudioSegmentEnded(sessionId: string, segmentId: string): void {
    const segments = this.activeAudioSegments.get(sessionId)
    if (!segments) {
      return
    }

    segments.delete(segmentId)
    if (segments.size === 0) {
      this.activeAudioSegments.delete(sessionId)
    }
  }

  private resetBargeIn(sessionId: string): void {
    for (const participantIdentity of this.sessionParticipants.get(sessionId) ?? []) {
      const participant = this.participants.get(participantIdentity)
      if (participant) {
        participant.bargeInSent = false
      }
    }
  }
}

export function buildLiveKitVoiceBridgeServer(deps: {
  config: StoreConfig
  manager: LiveKitVoiceBridgeManager
}): FastifyInstance {
  const server = Fastify({ logger: false })

  server.get('/', async (_request, reply) => {
    return reply.type('text/html; charset=utf-8').send(renderLiveKitClientHtml(deps.config))
  })

  server.get('/health', async () => {
    const state = deps.manager.getState()
    return {
      status: 'ok',
      store_id: state.store_id,
      enabled: state.enabled,
      agent_name: state.agent_name,
      participant_count: state.participant_count,
      active_sessions: state.active_sessions,
      room_connected: state.room_connected,
    }
  })

  server.get('/state', async () => deps.manager.getState())

  server.post('/room/close', async (request, reply) => {
    if (!isAuthorizedAdminRequest(deps.config, request.headers)) {
      return reply.code(401).send({ ok: false, error: 'unauthorized' })
    }

    await deps.manager.closeRoom('http_request')
    return { ok: true, room_name: resolveLiveKitRoomName(deps.config) }
  })

  server.get('/client-token', async (request) => {
    await deps.manager.start()

    const query = LiveKitClientTokenQuerySchema.parse(request.query)
    const { AccessToken } = await import('livekit-server-sdk')
    const bridgeConfig = deps.config.livekit_voice_bridge
    const url = readRequiredEnv(bridgeConfig.websocket_url_env)
    const apiKey = readRequiredEnv(bridgeConfig.api_key_env)
    const apiSecret = readRequiredEnv(bridgeConfig.api_secret_env)
    const roomName = resolveLiveKitRoomName(deps.config)
    const identity =
      query.identity?.trim() || `browser-customer-${Math.random().toString(36).slice(2, 8)}`

    const token = new AccessToken(apiKey, apiSecret, {
      identity,
      name: identity,
      metadata: JSON.stringify({
        role: query.role,
        speaker_id: identity,
      }),
      ttl: bridgeConfig.token_ttl,
    })
    token.addGrant({
      room: roomName,
      roomJoin: true,
      canPublish: true,
      canSubscribe: true,
      canPublishData: true,
    })

    return {
      url,
      token: await token.toJwt(),
      room_name: roomName,
      participant_identity: identity,
      role: query.role,
      store_id: deps.config.store.store_id,
      locale: deps.config.store.locale,
      input_topic: bridgeConfig.input_topic,
      output_topic: bridgeConfig.output_topic,
    }
  })

  server.post('/debug/transcript', async (request, reply) => {
    if (!deps.config.livekit_voice_bridge.debug_ingress_enabled) {
      reply.code(404)
      return { ok: false, error: 'Debug transcript ingress is disabled' }
    }

    const body = DebugTranscriptSchema.parse(request.body)
    await deps.manager.ingestTranscript({
      participantIdentity: body.participant_identity,
      participantMetadata: body.participant_metadata,
      sessionId: body.session_id,
      speakerId: body.speaker_id,
      role: body.role,
      text: body.text,
      final: body.final,
      locale: body.locale,
      timestamp: body.timestamp,
    })

    return { ok: true }
  })

  return server
}

function renderLiveKitClientHtml(config: StoreConfig): string {
  return `<!doctype html>
<html lang="es">
  <head>
    <meta charset="utf-8" />
    <meta name="viewport" content="width=device-width, initial-scale=1" />
    <title>Fitaly LiveKit Voice Test</title>
    <style>
      :root {
        color-scheme: light;
        --bg: #f7f4ef;
        --panel: #ffffff;
        --ink: #1f2933;
        --muted: #62717f;
        --line: #d9e0e7;
        --accent: #0f766e;
        --accent-soft: #e0f2f1;
        --danger: #b42318;
        --warn: #9a6700;
        --ok: #237a57;
        --shadow: 0 18px 60px rgba(31, 41, 51, 0.08);
        font-family: "Segoe UI", system-ui, sans-serif;
      }

      * { box-sizing: border-box; }

      body {
        margin: 0;
        background: var(--bg);
        color: var(--ink);
      }

      main {
        width: min(1120px, calc(100vw - 28px));
        margin: 24px auto;
        display: grid;
        gap: 16px;
      }

      section {
        background: var(--panel);
        border: 1px solid var(--line);
        border-radius: 8px;
        box-shadow: var(--shadow);
        padding: 18px;
      }

      h1, h2 { margin: 0; }
      h1 { font-size: 28px; }
      h2 { font-size: 17px; margin-bottom: 12px; }
      p { margin: 8px 0 0; color: var(--muted); line-height: 1.55; }

      .grid {
        display: grid;
        grid-template-columns: 0.95fr 1.05fr;
        gap: 16px;
      }

      .controls {
        display: grid;
        gap: 12px;
      }

      .row {
        display: flex;
        gap: 10px;
        flex-wrap: wrap;
        align-items: end;
      }

      label {
        display: grid;
        gap: 6px;
        color: var(--muted);
        font-size: 13px;
        flex: 1 1 180px;
      }

      input, select, textarea, button {
        font: inherit;
      }

      input, select, textarea {
        width: 100%;
        border: 1px solid var(--line);
        border-radius: 8px;
        padding: 10px 11px;
        background: #fff;
        color: var(--ink);
      }

      textarea {
        min-height: 82px;
        resize: vertical;
      }

      button {
        border: 0;
        border-radius: 8px;
        padding: 10px 14px;
        font-weight: 700;
        cursor: pointer;
      }

      button:disabled {
        opacity: 0.48;
        cursor: not-allowed;
      }

      .primary { background: var(--accent); color: white; }
      .secondary { background: #e8edf2; color: var(--ink); }
      .danger { background: #fee4e2; color: var(--danger); }

      .status-grid {
        display: grid;
        grid-template-columns: repeat(auto-fit, minmax(150px, 1fr));
        gap: 8px;
      }

      .status-card {
        border: 1px solid var(--line);
        border-radius: 8px;
        padding: 10px;
        background: #fbfcfd;
      }

      .label {
        color: var(--muted);
        font-size: 11px;
        text-transform: uppercase;
        letter-spacing: 0.04em;
        margin-bottom: 5px;
      }

      .value {
        font-family: Consolas, "SFMono-Regular", monospace;
        font-size: 12px;
        word-break: break-word;
      }

      .dotline {
        display: flex;
        gap: 9px;
        align-items: center;
        color: var(--muted);
      }

      .dot {
        width: 10px;
        height: 10px;
        border-radius: 999px;
        background: var(--warn);
      }

      .dot.ok { background: var(--ok); }
      .dot.err { background: var(--danger); }

      .bubble {
        border: 1px solid var(--line);
        border-radius: 8px;
        padding: 12px;
        background: #fbfcfd;
        margin-bottom: 10px;
      }

      .bubble.assistant {
        background: var(--accent-soft);
      }

      .bubble small {
        display: block;
        color: var(--muted);
        text-transform: uppercase;
        letter-spacing: 0.04em;
        font-size: 11px;
        margin-bottom: 6px;
      }

      pre {
        margin: 0;
        white-space: pre-wrap;
        word-break: break-word;
        font-family: Consolas, "SFMono-Regular", monospace;
        font-size: 12px;
        line-height: 1.45;
      }

      @media (max-width: 860px) {
        main { width: min(100vw - 18px, 100%); margin: 10px auto; }
        .grid { grid-template-columns: 1fr; }
      }
    </style>
  </head>
  <body>
    <main>
      <section>
        <h1>LiveKit Voice Test</h1>
        <p>
          Usa el microfono del navegador para dictar, publica transcripts al room LiveKit y
          escucha los eventos que vuelve a emitir el runtime. Funciona mejor en Chrome o Edge
          porque usa Web Speech API para STT local del navegador.
        </p>
      </section>

      <section class="status-grid">
        <div class="status-card">
          <div class="label">Store</div>
          <div class="value">${escapeHtml(config.store.store_id)}</div>
        </div>
        <div class="status-card">
          <div class="label">Transport</div>
          <div class="value">${escapeHtml(config.livekit_voice_bridge.transport)}</div>
        </div>
        <div class="status-card">
          <div class="label">Input Topic</div>
          <div class="value">${escapeHtml(config.livekit_voice_bridge.input_topic)}</div>
        </div>
        <div class="status-card">
          <div class="label">Output Topic</div>
          <div class="value">${escapeHtml(config.livekit_voice_bridge.output_topic)}</div>
        </div>
      </section>

      <section class="grid">
        <div>
          <section>
            <h2>Control</h2>
            <div class="controls">
              <div class="row">
                <label>
                  Identity
                  <input id="identity" value="browser-customer-1" />
                </label>
                <label>
                  Role
                  <select id="role">
                    <option value="customer">customer</option>
                    <option value="cashier">cashier</option>
                    <option value="manager">manager</option>
                  </select>
                </label>
              </div>
              <div class="row">
                <button id="connect" class="primary">Conectar LiveKit</button>
                <button id="listen" class="primary" disabled>Hablar</button>
                <button id="stop" class="secondary" disabled>Detener</button>
                <button id="disconnect" class="danger" disabled>Desconectar</button>
                <button id="close-room" class="danger">Cerrar Sala</button>
              </div>
              <div class="row">
                <label style="flex: 1 1 100%">
                  Enviar texto manual
                  <textarea id="manual" placeholder="Ejemplo: quiero ver tenis talla 42"></textarea>
                </label>
              </div>
              <div class="row">
                <button id="send-manual" class="secondary" disabled>Enviar Texto</button>
                <button id="clear" class="secondary">Limpiar Log</button>
                <label style="display:flex; gap:8px; align-items:center; flex:0 0 auto; color:var(--ink)">
                  <input id="speak-answer" type="checkbox" checked style="width:auto" />
                  Leer respuesta
                </label>
                <label style="display:flex; gap:8px; align-items:center; flex:1 1 180px; color:var(--ink)">
                  Velocidad
                  <input id="voice-rate" type="range" min="0.7" max="1.1" step="0.05" value="0.86" />
                </label>
                <label style="display:flex; gap:8px; align-items:center; flex:0 0 auto; color:var(--ink)">
                  <input id="thinking-cue" type="checkbox" checked style="width:auto" />
                  Pausa natural
                </label>
              </div>
              <div class="dotline">
                <span id="dot" class="dot"></span>
                <span id="status">Desconectado.</span>
              </div>
            </div>
          </section>
        </div>

        <div>
          <section>
            <h2>Conversacion</h2>
            <div class="bubble">
              <small>Parcial</small>
              <pre id="partial">Sin dictado activo.</pre>
            </div>
            <div class="bubble">
              <small>Cliente</small>
              <pre id="user">Sin transcript final.</pre>
            </div>
            <div class="bubble assistant">
              <small>Asistente / Runtime</small>
              <pre id="assistant">Sin respuesta todavia.</pre>
            </div>
          </section>
        </div>
      </section>

      <section>
        <h2>Eventos LiveKit</h2>
        <pre id="events">Esperando actividad...</pre>
      </section>
    </main>

    <script type="module">
      import { Room, RoomEvent, DataPacket_Kind } from 'https://esm.sh/livekit-client@2?bundle'

      const els = {
        identity: document.getElementById('identity'),
        role: document.getElementById('role'),
        connect: document.getElementById('connect'),
        listen: document.getElementById('listen'),
        stop: document.getElementById('stop'),
        disconnect: document.getElementById('disconnect'),
        closeRoom: document.getElementById('close-room'),
        manual: document.getElementById('manual'),
        sendManual: document.getElementById('send-manual'),
        clear: document.getElementById('clear'),
        speakAnswer: document.getElementById('speak-answer'),
        voiceRate: document.getElementById('voice-rate'),
        thinkingCue: document.getElementById('thinking-cue'),
        dot: document.getElementById('dot'),
        status: document.getElementById('status'),
        partial: document.getElementById('partial'),
        user: document.getElementById('user'),
        assistant: document.getElementById('assistant'),
        events: document.getElementById('events'),
      }

      const SpeechRecognition = window.SpeechRecognition || window.webkitSpeechRecognition
      let room = null
      let tokenInfo = null
      let recognition = null
      let listening = false
      let lastPartial = ''
      let thinkingTimer = null

      els.connect.addEventListener('click', () => connect())
      els.listen.addEventListener('click', () => startListening())
      els.stop.addEventListener('click', () => stopListening())
      els.disconnect.addEventListener('click', () => disconnect())
      els.closeRoom.addEventListener('click', () => closeRoom())
      els.sendManual.addEventListener('click', () => {
        const text = els.manual.value.trim()
        if (!text) return
        publishTranscript(text, true)
        els.manual.value = ''
      })
      els.clear.addEventListener('click', () => {
        els.events.textContent = 'Esperando actividad...'
      })

      async function connect() {
        try {
          setStatus('Conectando...', 'warn')
          const identity = sanitizeIdentity(els.identity.value) || 'browser-customer-1'
          els.identity.value = identity
          const params = new URLSearchParams({ identity, role: els.role.value })
          const response = await fetch('/client-token?' + params.toString())
          if (!response.ok) {
            throw new Error('Token HTTP ' + response.status)
          }
          tokenInfo = await response.json()

          room = new Room()
          room.on(RoomEvent.DataReceived, (payload, participant, _kind, topic) => {
            if (topic !== tokenInfo.output_topic) return
            const text = new TextDecoder().decode(payload)
            handleRuntimeEvent(text, participant?.identity)
          })
          room.on(RoomEvent.Disconnected, () => {
            setConnected(false)
            setStatus('Desconectado de LiveKit.', 'warn')
          })

          await room.connect(tokenInfo.url, tokenInfo.token)
          setConnected(true)
          setStatus('Conectado al room ' + tokenInfo.room_name + '.', 'ok')
          appendEvent({ type: 'connected', room: tokenInfo.room_name, identity })
        } catch (error) {
          setStatus(error instanceof Error ? error.message : String(error), 'err')
          appendEvent({ type: 'connect_error', error: String(error) })
        }
      }

      async function disconnect() {
        stopListening()
        if (room) {
          await room.disconnect()
          room = null
        }
        setConnected(false)
      }

      async function closeRoom() {
        await disconnect()
        const response = await fetch('/room/close', {
          method: 'POST',
          headers: { 'content-type': 'application/json' },
          body: '{}',
        })
        if (!response.ok) {
          setStatus('No pude cerrar la sala: HTTP ' + response.status, 'err')
          appendEvent({ type: 'room_close_error', status: response.status })
          return
        }

        const result = await response.json()
        setStatus('Sala LiveKit cerrada.', 'warn')
        appendEvent({ type: 'room_closed', room: result.room_name })
      }

      async function startListening() {
        if (!room || !tokenInfo) {
          setStatus('Conecta LiveKit primero.', 'warn')
          return
        }
        if (!SpeechRecognition) {
          setStatus('Este navegador no soporta SpeechRecognition. Usa texto manual.', 'err')
          return
        }
        if (requiresSecureMicContext()) {
          const error = 'microfono requiere HTTPS en celular'
          setStatus(error + '. Usa HTTPS/tunel seguro o texto manual.', 'err')
          appendEvent({ type: 'speech_error', error: 'secure-context-required' })
          return
        }
        if (listening) return

        const granted = await requestMicrophonePermission()
        if (!granted) {
          return
        }

        recognition = new SpeechRecognition()
        recognition.lang = tokenInfo.locale === 'es' ? 'es-ES' : tokenInfo.locale
        recognition.continuous = true
        recognition.interimResults = true

        recognition.onstart = () => {
          listening = true
          els.listen.disabled = true
          els.stop.disabled = false
          setStatus('Escuchando microfono...', 'ok')
        }
        recognition.onerror = (event) => {
          setStatus('SpeechRecognition: ' + event.error, 'err')
          appendEvent({ type: 'speech_error', error: event.error })
        }
        recognition.onend = () => {
          listening = false
          els.listen.disabled = !room
          els.stop.disabled = true
          if (lastPartial) {
            lastPartial = ''
            els.partial.textContent = 'Sin dictado activo.'
          }
        }
        recognition.onresult = (event) => {
          for (let index = event.resultIndex; index < event.results.length; index += 1) {
            const result = event.results[index]
            const text = Array.from(result).map((entry) => entry.transcript).join(' ').trim()
            if (!text) continue

            if (result.isFinal) {
              lastPartial = ''
              els.partial.textContent = 'Sin dictado activo.'
              els.user.textContent = text
              void publishTranscript(text, true)
            } else if (text !== lastPartial) {
              lastPartial = text
              els.partial.textContent = text
              void publishTranscript(text, false)
            }
          }
        }

        try {
          recognition.start()
        } catch (error) {
          setStatus(error instanceof Error ? error.message : String(error), 'err')
          appendEvent({ type: 'speech_error', error: String(error) })
        }
      }

      function stopListening() {
        if (recognition) {
          recognition.stop()
          recognition = null
        }
        listening = false
        els.listen.disabled = !room
        els.stop.disabled = true
      }

      async function publishTranscript(text, final) {
        if (!room || !tokenInfo) {
          setStatus('No hay conexion LiveKit.', 'warn')
          return
        }

        const payload = {
          type: 'transcript',
          participant_identity: tokenInfo.participant_identity,
          speaker_id: tokenInfo.participant_identity,
          role: tokenInfo.role,
          text,
          final,
          locale: tokenInfo.locale,
          timestamp: Date.now(),
        }
        const bytes = new TextEncoder().encode(JSON.stringify(payload))

        try {
          await room.localParticipant.publishData(bytes, {
            reliable: true,
            topic: tokenInfo.input_topic,
          })
        } catch {
          await room.localParticipant.publishData(bytes, DataPacket_Kind.RELIABLE, {
            topic: tokenInfo.input_topic,
          })
        }

        appendEvent({ type: final ? 'sent_final' : 'sent_partial', text })
      }

      function handleRuntimeEvent(raw, participantIdentity) {
        let event
        try {
          event = JSON.parse(raw)
        } catch {
          appendEvent({ type: 'runtime_text', participantIdentity, raw })
          return
        }

        appendEvent(event)
        const channel = event.channel
        const payload = event.payload || {}

        if (channel === 'bus:RESPONSE_START') {
          setStatus('Runtime pensando...', 'ok')
          scheduleThinkingCue()
          return
        }

        if (channel === 'bus:TTS_SEGMENT_START') {
          clearThinkingCue()
          const text = payload.text || ''
          if (text) {
            els.assistant.textContent = text
            speak(text)
          }
          return
        }

        if (channel === 'bus:AVATAR_SPEAK') {
          const text = payload.text || ''
          if (text) {
            els.assistant.textContent = text
            speak(text)
          }
          return
        }

        if (channel === 'bus:RESPONSE_END') {
          clearThinkingCue()
          setStatus('Turno finalizado: ' + (payload.reason || 'end_turn'), 'ok')
          return
        }

        if (channel === 'bus:BARGE_IN') {
          clearThinkingCue()
          window.speechSynthesis.cancel()
          setStatus('Interrupcion enviada.', 'warn')
        }
      }

      function speak(text) {
        if (!els.speakAnswer.checked || !window.speechSynthesis) return
        window.speechSynthesis.cancel()
        const utterance = new SpeechSynthesisUtterance(text)
        utterance.lang = tokenInfo?.locale === 'es' ? 'es-ES' : 'en-US'
        utterance.rate = Number(els.voiceRate.value) || 0.86
        utterance.pitch = 1
        const voice = window.speechSynthesis
          .getVoices()
          .find((entry) => entry.lang.toLowerCase().startsWith(utterance.lang.toLowerCase().slice(0, 2)))
        if (voice) utterance.voice = voice
        window.speechSynthesis.speak(utterance)
      }

      function scheduleThinkingCue() {
        clearThinkingCue()
        if (!els.thinkingCue.checked) return
        thinkingTimer = window.setTimeout(() => {
          thinkingTimer = null
          if (!room) return
          const cue = 'Un momento, estoy revisando.'
          els.assistant.textContent = cue
          appendEvent({ type: 'thinking_cue', text: cue })
          speak(cue)
        }, 850)
      }

      function clearThinkingCue() {
        if (thinkingTimer) {
          window.clearTimeout(thinkingTimer)
          thinkingTimer = null
        }
      }

      function requiresSecureMicContext() {
        const host = window.location.hostname
        const local = host === 'localhost' || host === '127.0.0.1' || host === '::1'
        return window.location.protocol !== 'https:' && !local
      }

      async function requestMicrophonePermission() {
        if (!navigator.mediaDevices?.getUserMedia) {
          return true
        }

        try {
          const stream = await navigator.mediaDevices.getUserMedia({ audio: true })
          stream.getTracks().forEach((track) => track.stop())
          return true
        } catch (error) {
          const name = error instanceof Error ? error.name : String(error)
          setStatus('Permiso de microfono: ' + name, 'err')
          appendEvent({ type: 'speech_error', error: name })
          return false
        }
      }

      function setConnected(connected) {
        els.connect.disabled = connected
        els.disconnect.disabled = !connected
        els.listen.disabled = !connected
        els.sendManual.disabled = !connected
        els.role.disabled = connected
        els.identity.disabled = connected
        els.dot.className = 'dot' + (connected ? ' ok' : '')
      }

      function setStatus(text, level) {
        els.status.textContent = text
        els.dot.className = 'dot' + (level === 'ok' ? ' ok' : level === 'err' ? ' err' : '')
      }

      function appendEvent(event) {
        const current = els.events.textContent === 'Esperando actividad...' ? [] : els.events.textContent.split('\\n')
        current.unshift('[' + new Date().toLocaleTimeString() + '] ' + JSON.stringify(event))
        els.events.textContent = current.slice(0, 28).join('\\n')
      }

      function sanitizeIdentity(value) {
        return String(value || '').trim().replace(/[^a-zA-Z0-9_-]+/g, '_')
      }
    </script>
  </body>
</html>`
}

function escapeHtml(value: string): string {
  return value
    .replaceAll('&', '&amp;')
    .replaceAll('<', '&lt;')
    .replaceAll('>', '&gt;')
    .replaceAll('"', '&quot;')
    .replaceAll("'", '&#39;')
}

export async function startLiveKitVoiceBridgeService(deps: {
  configPath: string
  bus?: IEventBus
  transport?: LiveKitBridgeTransport
  host?: string
  port?: number
}): Promise<{
  manager: LiveKitVoiceBridgeManager
  server: FastifyInstance
  shutdown(): Promise<void>
}> {
  const config = await loadStoreConfig(deps.configPath)

  if (!config.livekit_voice_bridge.enabled) {
    throw new Error(
      'LiveKit voice bridge requires livekit_voice_bridge.enabled=true in store config',
    )
  }

  if (!deps.bus && config.providers.bus.driver !== 'redis') {
    throw new Error(
      'LiveKit voice bridge requires providers.bus.driver="redis" when no bus override is provided',
    )
  }

  const bus =
    deps.bus ??
    (await createBus({
      redisUrl: config.providers.bus.driver === 'redis' ? config.providers.bus.url : undefined,
    }))
  const transport =
    deps.transport ??
    (config.livekit_voice_bridge.transport === 'livekit-rtc'
      ? new LiveKitRtcBridgeTransport(config)
      : new NoopLiveKitBridgeTransport())
  const manager = new LiveKitVoiceBridgeManager({ bus, config, transport })
  const server = buildLiveKitVoiceBridgeServer({ config, manager })

  const unsubscribes = LIVEKIT_BRIDGE_CHANNELS.map((channel) =>
    bus.subscribe(channel, (payload) => {
      void manager.handleBusEvent(channel, payload)
    }),
  )

  if (config.livekit_voice_bridge.transport !== 'livekit-rtc') {
    await manager.start()
  }

  await server.listen({
    host: deps.host ?? process.env.LIVEKIT_VOICE_BRIDGE_HOST ?? config.livekit_voice_bridge.host,
    port:
      deps.port ??
      readPort(process.env.LIVEKIT_VOICE_BRIDGE_PORT, config.livekit_voice_bridge.port),
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

      for (const unsubscribe of unsubscribes) {
        unsubscribe()
      }
      await manager.close().catch(() => {})
      await server.close().catch(() => {})

      if (!deps.bus && 'disconnect' in bus && typeof bus.disconnect === 'function') {
        await bus.disconnect().catch(() => {})
      }
    },
  }
}

async function main(): Promise<void> {
  dotenv.config()

  const configPath = resolveConfigPath(process.argv.slice(2))
  const service = await startLiveKitVoiceBridgeService({ configPath })

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

function readTransportConnected(transport: LiveKitBridgeTransport): boolean {
  const candidate = transport as LiveKitBridgeTransport & { isRoomConnected?: () => boolean }
  if (typeof candidate.isRoomConnected === 'function') {
    return candidate.isRoomConnected()
  }

  return false
}

function resolveLiveKitRoomName(config: StoreConfig): string {
  return (
    config.livekit_voice_bridge.room_name ??
    readRequiredEnv(config.livekit_voice_bridge.room_name_env)
  )
}

function toLiveKitHttpUrl(value: string): string {
  const url = new URL(value)
  if (url.protocol === 'wss:') {
    url.protocol = 'https:'
  } else if (url.protocol === 'ws:') {
    url.protocol = 'http:'
  }
  return url.toString()
}

function isAuthorizedAdminRequest(
  config: StoreConfig,
  headers: Record<string, string | string[] | undefined>,
): boolean {
  const expected = process.env[config.http.admin_secret_env]
  if (!expected) {
    return true
  }

  const received = headers['x-admin-secret']
  return Array.isArray(received) ? received.includes(expected) : received === expected
}

function readRequiredEnv(name: string): string {
  const value = process.env[name]
  if (!value) {
    throw new Error(`Missing required environment variable ${name}`)
  }
  return value
}

function readString(value: unknown): string | undefined {
  return typeof value === 'string' && value.length > 0 ? value : undefined
}

function readMetadataString(metadata: unknown, key: string): string | undefined {
  if (metadata && typeof metadata === 'object' && key in metadata) {
    return readString((metadata as Record<string, unknown>)[key])
  }

  if (typeof metadata !== 'string') {
    return undefined
  }

  try {
    const parsed = JSON.parse(metadata) as unknown
    if (parsed && typeof parsed === 'object' && key in parsed) {
      return readString((parsed as Record<string, unknown>)[key])
    }
  } catch {
    return undefined
  }

  return undefined
}

function readMetadataRole(metadata: unknown): HumanRole | undefined {
  const value = readMetadataString(metadata, 'role')
  if (value && (HUMAN_ROLE_VALUES as readonly string[]).includes(value)) {
    return value as HumanRole
  }
  return undefined
}

function createLiveKitRoom(livekit: LiveKitRtcModule): InstanceType<LiveKitRtcModule['Room']> {
  return new livekit.Room()
}

if (isEntrypoint(import.meta.url)) {
  main().catch((error) => {
    console.error(
      '[store-runtime/livekit-voice-bridge] Boot failed:',
      error instanceof Error ? error.message : error,
    )
    process.exitCode = 1
  })
}
