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

export class NoopLiveKitBridgeTransport implements LiveKitBridgeTransport {
  readonly sent: LiveKitBridgeOutboundEvent[] = []

  async send(event: LiveKitBridgeOutboundEvent): Promise<void> {
    this.sent.push(event)
  }
}

export class LiveKitRtcBridgeTransport implements LiveKitBridgeTransport {
  private room: Awaited<ReturnType<typeof createLiveKitRoom>> | null = null
  private rtc: LiveKitRtcModule | null = null
  private audioSource: InstanceType<LiveKitRtcModule['AudioSource']> | null = null
  private audioTrack: InstanceType<LiveKitRtcModule['LocalAudioTrack']> | null = null

  constructor(private readonly config: StoreConfig) {}

  async start(manager: LiveKitVoiceBridgeManager): Promise<void> {
    const livekit = await import('@livekit/rtc-node')
    const { AccessToken } = await import('livekit-server-sdk')
    this.rtc = livekit

    const bridgeConfig = this.config.livekit_voice_bridge
    const url = readRequiredEnv(bridgeConfig.websocket_url_env)
    const apiKey = readRequiredEnv(bridgeConfig.api_key_env)
    const apiSecret = readRequiredEnv(bridgeConfig.api_secret_env)
    const roomName = bridgeConfig.room_name ?? readRequiredEnv(bridgeConfig.room_name_env)
    const identity = bridgeConfig.participant_identity

    const tokenBuilder = new AccessToken(apiKey, apiSecret, {
      identity,
      name: bridgeConfig.agent_name,
      ttl: '6h',
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
        void manager.ensureParticipantDetected({
          participantIdentity: participant.identity,
          participantMetadata: participant.metadata,
          role: readMetadataRole(participant.metadata),
        })
      })
      .on(livekit.RoomEvent.ParticipantDisconnected, (participant) => {
        void manager.disconnectParticipant(participant.identity)
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
    await this.audioTrack?.close().catch(() => {})
    this.audioTrack = null
    this.audioSource = null

    await this.room?.disconnect().catch(() => {})
    this.room = null

    if (this.rtc) {
      await this.rtc.dispose().catch(() => {})
    }
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

  constructor(
    private readonly deps: {
      bus: IEventBus
      config: StoreConfig
      transport: LiveKitBridgeTransport
    },
  ) {}

  async start(): Promise<void> {
    await this.deps.transport.start?.(this)
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

  server.get('/health', async () => {
    const state = deps.manager.getState()
    return {
      status: 'ok',
      store_id: state.store_id,
      enabled: state.enabled,
      agent_name: state.agent_name,
      participant_count: state.participant_count,
      active_sessions: state.active_sessions,
    }
  })

  server.get('/state', async () => deps.manager.getState())

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

  await manager.start()

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
