import fs from 'node:fs'
import readline from 'node:readline'
import type { IEventBus, HumanRole } from 'fitalyagents'
import type { StoreConfig } from '../config/schema.js'
import type { IStreamingSTTProvider, STTTranscriptChunk } from '../providers/stt/types.js'
import type { TtsStreamService } from './tts-stream.js'
import { buildSpeakerSessionId } from './speaker-session.js'

export interface SttBridgeHandle {
  close(): void
}

export async function startSttBridge(
  config: StoreConfig,
  stt: IStreamingSTTProvider | null,
  bus: IEventBus,
  ttsStream: TtsStreamService,
  options?: { input?: NodeJS.ReadableStream },
): Promise<SttBridgeHandle> {
  switch (config.capture.driver) {
    case 'external-bus':
      return { close() {} }
    case 'voice-events':
      return startVoiceEventBridge(config, bus, ttsStream, options)
    case 'local-stt':
      if (!stt) {
        throw new Error('Local STT capture requires a configured STT provider')
      }
      return startLocalSttBridge(config, stt, bus, ttsStream, options)
  }
}

async function startLocalSttBridge(
  config: StoreConfig,
  stt: IStreamingSTTProvider,
  bus: IEventBus,
  ttsStream: TtsStreamService,
  options?: { input?: NodeJS.ReadableStream },
): Promise<SttBridgeHandle> {
  const input = resolveInputStream(config, options)
  const activeSpeakers = new Set<string>()
  const bargeInSessions = new Set<string>()

  if (config.providers.stt.driver === 'mock') {
    const rl = readline.createInterface({
      input,
      crlfDelay: Infinity,
    })

    rl.on('line', async (line) => {
      const parsed = parseMockLine(line, config.store.store_id)
      if (!parsed.text) {
        return
      }

      await ensureSpeakerDetected(bus, activeSpeakers, {
        storeId: config.store.store_id,
        sessionId: parsed.sessionId,
        speakerId: parsed.speakerId,
      })

      const session = await stt.startSession(
        (chunk) => {
          void publishSpeechChunk({
            bus,
            chunk,
            sessionId: parsed.sessionId,
            speakerId: parsed.speakerId,
            role: parsed.role,
            config,
            ttsStream,
            bargeInSessions,
          })
        },
        (error) => {
          console.error('[store-runtime] STT mock bridge error:', error.message)
        },
      )

      session.push(Buffer.from(`${parsed.text}\n`, 'utf8'))
      session.end()
      session.close()
    })

    return {
      close() {
        rl.close()
        closeInput(input, options?.input)
      },
    }
  }

  const speakerId = 'customer_main'
  const sessionId = buildSpeakerSessionId(config.store.store_id, speakerId)
  await ensureSpeakerDetected(bus, activeSpeakers, {
    storeId: config.store.store_id,
    sessionId,
    speakerId,
  })

  const session = await stt.startSession(
    (chunk) => {
      void publishSpeechChunk({
        bus,
        chunk,
        sessionId,
        speakerId,
        role: 'customer',
        config,
        ttsStream,
        bargeInSessions,
      })
    },
    (error) => {
      console.error('[store-runtime] STT bridge error:', error.message)
    },
  )

  input.on('data', (chunk) => {
    const buffer = Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk)
    session.push(buffer)
  })

  input.on('end', () => {
    session.end()
  })

  if ('resume' in input && typeof input.resume === 'function') {
    input.resume()
  }

  return {
    close() {
      session.close()
      closeInput(input, options?.input)
    },
  }
}

async function startVoiceEventBridge(
  config: StoreConfig,
  bus: IEventBus,
  ttsStream: TtsStreamService,
  options?: { input?: NodeJS.ReadableStream },
): Promise<SttBridgeHandle> {
  const input = resolveInputStream(config, options)
  const activeSpeakers = new Set<string>()
  const bargeInSessions = new Set<string>()
  const rl = readline.createInterface({
    input,
    crlfDelay: Infinity,
  })

  rl.on('line', async (line) => {
    const event = parseVoiceEventLine(line, config.store.store_id, config.store.locale)
    if (!event) {
      return
    }

    switch (event.channel) {
      case 'bus:SPEAKER_DETECTED':
        activeSpeakers.add(event.payload.speaker_id)
        await bus.publish(event.channel, event.payload)
        return
      case 'bus:SPEAKER_LOST':
        activeSpeakers.delete(event.payload.speaker_id)
        await bus.publish(event.channel, event.payload)
        return
      case 'bus:AMBIENT_CONTEXT':
        await bus.publish(event.channel, event.payload)
        return
      case 'bus:SPEECH_PARTIAL':
      case 'bus:SPEECH_FINAL':
        if (event.payload.speaker_id) {
          await ensureSpeakerDetected(bus, activeSpeakers, {
            storeId: event.payload.store_id,
            sessionId: event.payload.session_id,
            speakerId: event.payload.speaker_id,
          })
        }
        await publishVoiceBusEvent({
          bus,
          event,
          ttsStream,
          bargeInSessions,
        })
        return
    }
  })

  return {
    close() {
      rl.close()
      closeInput(input, options?.input)
    },
  }
}

function resolveInputStream(
  config: StoreConfig,
  options?: { input?: NodeJS.ReadableStream },
): NodeJS.ReadableStream {
  if (options?.input) {
    return options.input
  }

  const inputPath =
    ('pipe_path' in config.capture && config.capture.pipe_path) ||
    process.env.STORE_AUDIO_INPUT_PIPE

  return inputPath ? fs.createReadStream(inputPath) : process.stdin
}

function closeInput(input: NodeJS.ReadableStream, inputOverride?: NodeJS.ReadableStream): void {
  if (input === process.stdin || inputOverride) {
    return
  }

  if ('close' in input && typeof input.close === 'function') {
    input.close()
  }
}

async function ensureSpeakerDetected(
  bus: IEventBus,
  activeSpeakers: Set<string>,
  speaker: {
    storeId: string
    sessionId: string
    speakerId: string
  },
): Promise<void> {
  if (activeSpeakers.has(speaker.speakerId)) {
    return
  }

  activeSpeakers.add(speaker.speakerId)
  await bus.publish('bus:SPEAKER_DETECTED', {
    event: 'SPEAKER_DETECTED',
    session_id: speaker.sessionId,
    speaker_id: speaker.speakerId,
    store_id: speaker.storeId,
  })
}

async function publishVoiceBusEvent(args: {
  bus: IEventBus
  event: VoiceBridgeEvent
  ttsStream: TtsStreamService
  bargeInSessions: Set<string>
}): Promise<void> {
  const { bus, event, ttsStream, bargeInSessions } = args

  if (event.channel === 'bus:SPEECH_PARTIAL') {
    if (
      ttsStream.isSessionBusy(event.payload.session_id) &&
      !bargeInSessions.has(event.payload.session_id)
    ) {
      bargeInSessions.add(event.payload.session_id)
      await bus.publish('bus:BARGE_IN', {
        event: 'BARGE_IN',
        session_id: event.payload.session_id,
        timestamp: Date.now(),
      })
    }

    await bus.publish(event.channel, event.payload)
    return
  }

  bargeInSessions.delete(event.payload.session_id)
  await bus.publish(event.channel, event.payload)
}

async function publishSpeechChunk(args: {
  bus: IEventBus
  chunk: STTTranscriptChunk
  sessionId: string
  speakerId: string
  role: HumanRole
  config: StoreConfig
  ttsStream: TtsStreamService
  bargeInSessions: Set<string>
}): Promise<void> {
  const { bus, chunk, sessionId, speakerId, role, config, ttsStream, bargeInSessions } = args

  if (chunk.type === 'partial') {
    if (ttsStream.isSessionBusy(sessionId) && !bargeInSessions.has(sessionId)) {
      bargeInSessions.add(sessionId)
      await bus.publish('bus:BARGE_IN', {
        event: 'BARGE_IN',
        session_id: sessionId,
        timestamp: Date.now(),
      })
    }

    await bus.publish('bus:SPEECH_PARTIAL', {
      event: 'SPEECH_PARTIAL',
      session_id: sessionId,
      text: chunk.text,
      speaker_id: speakerId,
      role,
      actor_type: role,
      store_id: config.store.store_id,
      locale: config.store.locale,
      timestamp: chunk.timestamp,
    })

    return
  }

  bargeInSessions.delete(sessionId)

  await bus.publish('bus:SPEECH_FINAL', {
    event: 'SPEECH_FINAL',
    session_id: sessionId,
    text: chunk.text,
    speaker_id: speakerId,
    role,
    actor_type: role,
    store_id: config.store.store_id,
    locale: config.store.locale,
    timestamp: chunk.timestamp,
  })
}

export function parseMockLine(
  line: string,
  storeId: string,
): {
  sessionId: string
  speakerId: string
  role: HumanRole
  text: string
} {
  const trimmed = line.trim()
  if (!trimmed) {
    return {
      sessionId: buildSpeakerSessionId(storeId, 'customer_main'),
      speakerId: 'customer_main',
      role: 'customer',
      text: '',
    }
  }

  const parts = trimmed.split('|')

  if (parts.length >= 3) {
    const speakerId = parts[0]!.trim() || 'customer_main'
    const role = normalizeRole(parts[1]!.trim())
    const text = parts.slice(2).join('|').trim()

    return {
      sessionId: buildSpeakerSessionId(storeId, speakerId),
      speakerId,
      role,
      text,
    }
  }

  return {
    sessionId: buildSpeakerSessionId(storeId, 'customer_main'),
    speakerId: 'customer_main',
    role: 'customer',
    text: trimmed,
  }
}

type VoiceBridgeEvent =
  | {
      channel: 'bus:SPEAKER_DETECTED'
      payload: {
        event: 'SPEAKER_DETECTED'
        session_id: string
        speaker_id: string
        store_id: string
      }
    }
  | {
      channel: 'bus:SPEAKER_LOST'
      payload: {
        event: 'SPEAKER_LOST'
        session_id: string
        speaker_id: string
        timestamp: number
      }
    }
  | {
      channel: 'bus:AMBIENT_CONTEXT'
      payload: {
        event: 'AMBIENT_CONTEXT'
        session_id: string
        speaker_id?: string
        text: string
        timestamp: number
      }
    }
  | {
      channel: 'bus:SPEECH_PARTIAL'
      payload: {
        event: 'SPEECH_PARTIAL'
        session_id: string
        text: string
        confidence?: number
        speaker_id?: string
        role?: HumanRole
        actor_type?: HumanRole
        store_id: string
        locale: string
        timestamp: number
      }
    }
  | {
      channel: 'bus:SPEECH_FINAL'
      payload: {
        event: 'SPEECH_FINAL'
        session_id: string
        text: string
        confidence?: number
        speaker_id?: string
        role?: HumanRole
        actor_type?: HumanRole
        store_id: string
        locale: string
        timestamp: number
      }
    }

export function parseVoiceEventLine(
  line: string,
  storeId: string,
  locale = 'es',
): VoiceBridgeEvent | null {
  const trimmed = line.trim()
  if (!trimmed) {
    return null
  }

  let parsed: Record<string, unknown>
  try {
    parsed = JSON.parse(trimmed) as Record<string, unknown>
  } catch {
    return null
  }

  const channel = normalizeVoiceChannel(parsed.channel, parsed.event)
  if (!channel) {
    return null
  }

  const speakerId = typeof parsed.speaker_id === 'string' ? parsed.speaker_id : undefined
  const sessionId =
    typeof parsed.session_id === 'string'
      ? parsed.session_id
      : speakerId
        ? buildSpeakerSessionId(storeId, speakerId)
        : buildSpeakerSessionId(storeId, 'ambient')
  const timestamp = typeof parsed.timestamp === 'number' ? parsed.timestamp : Date.now()
  const resolvedStoreId = typeof parsed.store_id === 'string' ? parsed.store_id : storeId

  switch (channel) {
    case 'bus:SPEAKER_DETECTED':
      if (!speakerId) {
        return null
      }
      return {
        channel,
        payload: {
          event: 'SPEAKER_DETECTED',
          session_id: sessionId,
          speaker_id: speakerId,
          store_id: resolvedStoreId,
        },
      }
    case 'bus:SPEAKER_LOST':
      if (!speakerId) {
        return null
      }
      return {
        channel,
        payload: {
          event: 'SPEAKER_LOST',
          session_id: sessionId,
          speaker_id: speakerId,
          timestamp,
        },
      }
    case 'bus:AMBIENT_CONTEXT':
      if (typeof parsed.text !== 'string' || !parsed.text.trim()) {
        return null
      }
      return {
        channel,
        payload: {
          event: 'AMBIENT_CONTEXT',
          session_id: sessionId,
          speaker_id: speakerId,
          text: parsed.text.trim(),
          timestamp,
        },
      }
    case 'bus:SPEECH_PARTIAL':
    case 'bus:SPEECH_FINAL': {
      if (typeof parsed.text !== 'string' || !parsed.text.trim()) {
        return null
      }

      const role = typeof parsed.role === 'string' ? normalizeRole(parsed.role) : undefined
      const payload = {
        event: channel === 'bus:SPEECH_PARTIAL' ? 'SPEECH_PARTIAL' : 'SPEECH_FINAL',
        session_id: sessionId,
        text: parsed.text.trim(),
        confidence: typeof parsed.confidence === 'number' ? parsed.confidence : undefined,
        speaker_id: speakerId,
        role,
        actor_type: role,
        store_id: resolvedStoreId,
        locale: typeof parsed.locale === 'string' ? parsed.locale : locale,
        timestamp,
      }

      return {
        channel,
        payload,
      } as VoiceBridgeEvent
    }
  }
}

function normalizeVoiceChannel(
  channel: unknown,
  event: unknown,
): VoiceBridgeEvent['channel'] | null {
  if (typeof channel === 'string') {
    switch (channel) {
      case 'bus:SPEAKER_DETECTED':
      case 'bus:SPEAKER_LOST':
      case 'bus:AMBIENT_CONTEXT':
      case 'bus:SPEECH_PARTIAL':
      case 'bus:SPEECH_FINAL':
        return channel
    }
  }

  if (typeof event !== 'string') {
    return null
  }

  switch (event) {
    case 'SPEAKER_DETECTED':
      return 'bus:SPEAKER_DETECTED'
    case 'SPEAKER_LOST':
      return 'bus:SPEAKER_LOST'
    case 'AMBIENT_CONTEXT':
      return 'bus:AMBIENT_CONTEXT'
    case 'SPEECH_PARTIAL':
      return 'bus:SPEECH_PARTIAL'
    case 'SPEECH_FINAL':
      return 'bus:SPEECH_FINAL'
    default:
      return null
  }
}

function normalizeRole(value: string): HumanRole {
  switch (value) {
    case 'user':
    case 'staff':
    case 'agent':
    case 'cashier':
    case 'operator':
    case 'manager':
    case 'supervisor':
    case 'owner':
      return value
    default:
      return 'customer'
  }
}
