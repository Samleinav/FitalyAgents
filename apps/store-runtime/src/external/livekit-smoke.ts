import dotenv from 'dotenv'
import type * as LiveKitRtc from '@livekit/rtc-node'
import { AccessToken } from 'livekit-server-sdk'
import { resolveConfigPath } from '../cli/resolve-config-path.js'
import { isEntrypoint } from '../cli/is-entrypoint.js'
import { HUMAN_ROLE_VALUES, type StoreHumanRole } from '../config/human-roles.js'
import { loadStoreConfig } from '../config/load-store-config.js'
import type { StoreConfig } from '../config/schema.js'

type LiveKitRtcModule = typeof LiveKitRtc

interface LiveKitSmokeOptions {
  configPath: string
  text: string
  participantIdentity: string
  role: StoreHumanRole
  timeoutMs: number
  waitForOutput: boolean
  inputMode: 'data' | 'text-stream'
}

interface RuntimeEventMessage {
  type?: string
  channel?: string
  payload?: unknown
  timestamp?: number
}

export async function runLiveKitSmoke(
  options: LiveKitSmokeOptions,
): Promise<RuntimeEventMessage[]> {
  const config = await loadStoreConfig(options.configPath)
  const livekit = await import('@livekit/rtc-node')

  const bridgeConfig = config.livekit_voice_bridge
  const url = readRequiredEnv(bridgeConfig.websocket_url_env)
  const apiKey = readRequiredEnv(bridgeConfig.api_key_env)
  const apiSecret = readRequiredEnv(bridgeConfig.api_secret_env)
  const roomName = bridgeConfig.room_name ?? readRequiredEnv(bridgeConfig.room_name_env)
  const token = await buildParticipantToken({
    apiKey,
    apiSecret,
    roomName,
    identity: options.participantIdentity,
    name: 'Fitaly Smoke Client',
    metadata: JSON.stringify({
      role: options.role,
      speaker_id: options.participantIdentity,
    }),
  })
  const room = new livekit.Room()
  const outputMessages: RuntimeEventMessage[] = []

  room.on(livekit.RoomEvent.DataReceived, (payload, _participant, _kind, topic) => {
    if (topic !== bridgeConfig.output_topic) {
      return
    }

    const message = parseRuntimeEventMessage(new TextDecoder().decode(payload))
    if (message) {
      outputMessages.push(message)
    }
  })

  room.registerTextStreamHandler(bridgeConfig.output_topic, (reader) => {
    void reader.readAll().then((text) => {
      const message = parseRuntimeEventMessage(text)
      if (message) {
        outputMessages.push(message)
      }
    })
  })

  try {
    await room.connect(url, token, { autoSubscribe: true, dynacast: true })
    await publishTranscript(livekit, room, config, options)

    if (options.waitForOutput) {
      await waitFor(() => outputMessages.length > 0, options.timeoutMs)
    }

    return outputMessages
  } finally {
    await room.disconnect().catch(() => {})
    await livekit.dispose().catch(() => {})
  }
}

async function publishTranscript(
  livekit: LiveKitRtcModule,
  room: InstanceType<LiveKitRtcModule['Room']>,
  config: StoreConfig,
  options: LiveKitSmokeOptions,
): Promise<void> {
  const participant = room.localParticipant
  if (!participant) {
    throw new Error('LiveKit smoke client connected without a local participant')
  }

  const payload = {
    type: 'transcript',
    participant_identity: options.participantIdentity,
    speaker_id: options.participantIdentity,
    role: options.role,
    text: options.text,
    final: true,
    locale: config.store.locale,
    timestamp: Date.now(),
  }

  if (options.inputMode === 'text-stream') {
    const stream = await participant.streamText({
      topic: config.livekit_voice_bridge.input_topic,
    })
    await stream.write(JSON.stringify(payload))
    await stream.close()
  } else {
    await participant.publishData(new TextEncoder().encode(JSON.stringify(payload)), {
      reliable: true,
      topic: config.livekit_voice_bridge.input_topic,
    })
  }

  // Touch the imported module so type-only builds do not hide SDK drift in this file.
  void livekit.RoomEvent.DataReceived
}

async function buildParticipantToken(args: {
  apiKey: string
  apiSecret: string
  roomName: string
  identity: string
  name: string
  metadata: string
}): Promise<string> {
  const token = new AccessToken(args.apiKey, args.apiSecret, {
    identity: args.identity,
    name: args.name,
    metadata: args.metadata,
    ttl: '1h',
  })
  token.addGrant({
    room: args.roomName,
    roomJoin: true,
    canPublish: true,
    canSubscribe: true,
    canPublishData: true,
  })
  return token.toJwt()
}

function parseLiveKitSmokeOptions(args: string[], env: NodeJS.ProcessEnv): LiveKitSmokeOptions {
  const role = readArg(args, '--role') ?? 'customer'
  if (!(HUMAN_ROLE_VALUES as readonly string[]).includes(role)) {
    throw new Error(`Invalid --role "${role}"`)
  }

  return {
    configPath: resolveConfigPath(args, env),
    text: readArg(args, '--text') ?? 'quiero ver tenis talla 42',
    participantIdentity: readArg(args, '--participant') ?? 'fitaly-smoke-customer',
    role: role as StoreHumanRole,
    timeoutMs: readPositiveNumber(readArg(args, '--timeout-ms'), 20_000),
    waitForOutput: !hasFlag(args, '--no-wait-output'),
    inputMode: hasFlag(args, '--text-stream') ? 'text-stream' : 'data',
  }
}

function readArg(args: string[], name: string): string | undefined {
  const index = args.indexOf(name)
  if (index < 0) {
    return undefined
  }
  return args[index + 1]
}

function hasFlag(args: string[], name: string): boolean {
  return args.includes(name)
}

function readPositiveNumber(value: string | undefined, fallback: number): number {
  if (!value) {
    return fallback
  }
  const parsed = Number(value)
  return Number.isFinite(parsed) && parsed > 0 ? parsed : fallback
}

function parseRuntimeEventMessage(text: string): RuntimeEventMessage | null {
  try {
    const parsed = JSON.parse(text) as unknown
    return parsed && typeof parsed === 'object' ? (parsed as RuntimeEventMessage) : null
  } catch {
    return null
  }
}

function readRequiredEnv(name: string): string {
  const value = process.env[name]
  if (!value) {
    throw new Error(`Missing required environment variable ${name}`)
  }
  return value
}

async function waitFor(condition: () => boolean, timeoutMs: number): Promise<void> {
  const started = Date.now()

  while (Date.now() - started < timeoutMs) {
    if (condition()) {
      return
    }
    await new Promise((resolve) => setTimeout(resolve, 50))
  }

  throw new Error(`Timed out after ${timeoutMs}ms waiting for LiveKit runtime output`)
}

async function main(): Promise<void> {
  dotenv.config()

  const options = parseLiveKitSmokeOptions(process.argv.slice(2), process.env)
  const outputMessages = await runLiveKitSmoke(options)

  process.stdout.write(
    JSON.stringify(
      {
        ok: true,
        sent_text: options.text,
        input_mode: options.inputMode,
        waited_for_output: options.waitForOutput,
        output_count: outputMessages.length,
        first_output: outputMessages[0] ?? null,
      },
      null,
      2,
    ) + '\n',
  )
}

if (isEntrypoint(import.meta.url)) {
  main().catch((error) => {
    console.error(
      '[store-runtime/livekit-smoke] Smoke failed:',
      error instanceof Error ? error.message : error,
    )
    process.exitCode = 1
  })
}
