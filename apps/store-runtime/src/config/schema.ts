import { z } from 'zod'
import { HUMAN_ROLE_VALUES } from './human-roles.js'
import { ApprovalLimitsSchema } from './approval-limits.js'
import { RETAIL_PHASE1_TOOL_IDS } from '../retail/capabilities.js'
import {
  RetailConfigSchema,
  RetailConnectorsSchema,
  RetailDevicesSchema,
  RetailPoliciesSchema,
} from '../retail/schemas.js'

export const QuorumSchema = z.object({
  required: z.number().int().min(2),
  eligible_roles: z.array(z.enum(HUMAN_ROLE_VALUES)),
  reject_on_any_no: z.boolean().default(true),
})

const VoiceModeSchema = z.enum(['direct-device', 'web-bridge', 'hybrid'])
const VoiceTurnDetectionSchema = z.enum(['browser-vad', 'server-vad', 'hybrid'])
const WebVoiceSurfaceSchema = z.enum(['avatar', 'customer-display', 'staff-ui', 'voice-only'])
const LiveKitSpeakerIdSourceSchema = z.enum(['participant_identity', 'participant_metadata'])

export const StoreConfigSchema = z.object({
  store: z.object({
    store_id: z.string().min(1),
    name: z.string().min(1),
    timezone: z.string().default('UTC'),
    locale: z.string().default('en'),
  }),

  providers: z.object({
    bus: z
      .discriminatedUnion('driver', [
        z.object({ driver: z.literal('inmemory') }),
        z.object({ driver: z.literal('redis'), url: z.string().url() }),
      ])
      .default({ driver: 'inmemory' }),

    llm: z
      .discriminatedUnion('driver', [
        z.object({
          driver: z.literal('groq'),
          model: z.string().default('llama-3.1-8b-instant'),
        }),
        z.object({
          driver: z.literal('anthropic'),
          model: z.string().default('claude-haiku-4-5-20251001'),
        }),
        z.object({
          driver: z.literal('openai'),
          model: z.string().default('gpt-4o-mini'),
        }),
      ])
      .default({ driver: 'groq', model: 'llama-3.1-8b-instant' }),

    stt: z
      .discriminatedUnion('driver', [
        z.object({
          driver: z.literal('vosk'),
          language: z.string().default('es'),
          url: z.string().default('ws://localhost:2700'),
          sample_rate: z.number().int().positive().default(16000),
        }),
        z.object({
          driver: z.literal('sherpa-onnx'),
          url: z.string().url(),
        }),
        z.object({ driver: z.literal('mock') }),
      ])
      .default({ driver: 'mock' }),

    tts: z
      .discriminatedUnion('driver', [
        z.object({
          driver: z.literal('piper'),
          voice: z.string(),
          model_path: z.string().optional(),
        }),
        z.object({
          driver: z.literal('elevenlabs'),
          voice_id: z.string(),
          model: z.string().default('eleven_flash_v2_5'),
          output_format: z.string().default('mp3_44100_128'),
        }),
        z.object({
          driver: z.literal('openai-tts'),
          voice: z.string().default('alloy'),
        }),
        z.object({ driver: z.literal('mock') }),
      ])
      .default({ driver: 'mock' }),

    memory: z
      .discriminatedUnion('driver', [
        z.object({ driver: z.literal('inmemory') }),
        z.object({ driver: z.literal('sqlite') }),
        z.object({ driver: z.literal('mempalace'), palace_path: z.string() }),
      ])
      .default({ driver: 'sqlite' }),
  }),

  capture: z
    .discriminatedUnion('driver', [
      z.object({
        driver: z.literal('local-stt'),
        input: z.enum(['stdin', 'pipe']).default('stdin'),
        pipe_path: z.string().optional(),
      }),
      z.object({
        driver: z.literal('voice-events'),
        input: z.enum(['stdin', 'pipe']).default('stdin'),
        pipe_path: z.string().optional(),
        format: z.literal('ndjson').default('ndjson'),
      }),
      z.object({
        driver: z.literal('external-bus'),
      }),
    ])
    .default({ driver: 'local-stt', input: 'stdin' }),

  employees: z
    .array(
      z.object({
        id: z.string().min(1),
        name: z.string().min(1),
        role: z.enum(HUMAN_ROLE_VALUES),
        approval_limits: ApprovalLimitsSchema,
        voice_id: z.string().optional(),
      }),
    )
    .default([]),

  approvals: z
    .object({
      default_channels: z
        .array(
          z.object({
            type: z.enum(['webhook', 'voice', 'external_tool']),
            timeout_ms: z.number().int().positive().default(60_000),
            config: z.record(z.unknown()).optional(),
          }),
        )
        .default([{ type: 'webhook', timeout_ms: 60_000 }]),
      default_strategy: z.enum(['parallel', 'sequential', 'quorum']).default('parallel'),
      quorum: QuorumSchema.optional(),
    })
    .default({}),

  webhooks: z
    .object({
      approval_push_url: z.string().url().optional(),
      approval_response_path: z.string().default('/approvals/respond'),
    })
    .default({}),

  tools: z
    .object({
      enabled: z.array(z.string()).default([...RETAIL_PHASE1_TOOL_IDS]),
    })
    .default({}),

  safety: z
    .object({
      unknown_tool_default: z
        .enum(['safe', 'staged', 'protected', 'restricted'])
        .default('restricted'),
      tool_overrides: z
        .array(
          z.object({
            name: z.string(),
            safety: z.enum(['safe', 'staged', 'protected', 'restricted']),
            required_role: z.enum(HUMAN_ROLE_VALUES).optional(),
            quorum: QuorumSchema.optional(),
          }),
        )
        .default([]),
    })
    .default({}),

  storage: z
    .object({
      sqlite_path: z.string().default('./data/store.db'),
    })
    .default({}),

  voice: z
    .object({
      mode: VoiceModeSchema.default('direct-device'),
      barge_in_enabled: z.boolean().default(true),
      turn_detection: VoiceTurnDetectionSchema.default('hybrid'),
      sample_rate: z.number().int().positive().default(16000),
    })
    .default({}),

  retail: RetailConfigSchema,

  connectors: RetailConnectorsSchema,

  devices: RetailDevicesSchema,

  policies: RetailPoliciesSchema,

  http: z
    .object({
      port: z.number().int().positive().default(3000),
      host: z.string().default('127.0.0.1'),
      admin_secret_env: z.string().default('STORE_ADMIN_SECRET'),
    })
    .default({}),

  web_voice_bridge: z
    .object({
      enabled: z.boolean().default(false),
      host: z.string().default('0.0.0.0'),
      port: z.number().int().positive().default(3040),
      mount_path: z.string().min(1).default('/ws/voice'),
      transport: z.literal('websocket').default('websocket'),
      audio_format: z.literal('pcm_s16le').default('pcm_s16le'),
      surface_defaults: z.array(WebVoiceSurfaceSchema).default(['avatar', 'customer-display']),
      publish_mode: z.enum(['redis', 'local']).default('redis'),
      browser_vad: z.boolean().default(true),
      require_auth: z.boolean().default(false),
    })
    .default({}),

  livekit_voice_bridge: z
    .object({
      enabled: z.boolean().default(false),
      host: z.string().default('0.0.0.0'),
      port: z.number().int().positive().default(3050),
      agent_name: z.string().min(1).default('fitaly-store-runtime'),
      transport: z.enum(['noop', 'livekit-rtc']).default('noop'),
      websocket_url_env: z.string().min(1).default('LIVEKIT_URL'),
      api_key_env: z.string().min(1).default('LIVEKIT_API_KEY'),
      api_secret_env: z.string().min(1).default('LIVEKIT_API_SECRET'),
      room_name: z.string().min(1).optional(),
      room_name_env: z.string().min(1).default('LIVEKIT_ROOM'),
      participant_identity: z.string().min(1).default('fitaly-store-runtime'),
      speaker_id_source: LiveKitSpeakerIdSourceSchema.default('participant_identity'),
      input_topic: z.string().min(1).default('fitaly.transcript'),
      output_topic: z.string().min(1).default('fitaly.runtime'),
      audio_track_name: z.string().min(1).default('fitaly-audio'),
      publish_transcripts: z.boolean().default(true),
      forward_tts_audio: z.boolean().default(true),
      debug_ingress_enabled: z.boolean().default(false),
    })
    .default({}),

  avatar: z
    .object({
      enabled: z.boolean().default(false),
      mode: z.enum(['internal', 'external']).default('internal'),
      airi_url: z.string().url().optional(),
    })
    .default({ enabled: false, mode: 'internal' }),
})

export type StoreConfig = z.infer<typeof StoreConfigSchema>
export type StoreEmployeeConfig = StoreConfig['employees'][number]
export type ToolOverrideConfig = StoreConfig['safety']['tool_overrides'][number]
