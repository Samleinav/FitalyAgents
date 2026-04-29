import { mkdtemp, rm, writeFile } from 'node:fs/promises'
import os from 'node:os'
import path from 'node:path'
import type Database from 'better-sqlite3'
import type { StoreConfig } from '../src/config/schema.js'
import { closeDb, getDb } from '../src/storage/db.js'

export async function createTempDir(prefix = 'store-runtime-test-'): Promise<string> {
  return mkdtemp(path.join(os.tmpdir(), prefix))
}

export async function cleanupTempDir(dir: string): Promise<void> {
  await rm(dir, { recursive: true, force: true })
}

export function createTempDbPath(dir: string, name = 'store.db'): string {
  return path.join(dir, name)
}

export async function writeJsonFile(filePath: string, value: unknown): Promise<void> {
  await writeFile(filePath, JSON.stringify(value, null, 2), 'utf8')
}

export function ensureDb(dbPath: string): Database.Database {
  return getDb(dbPath)
}

export function closeTestDb(dbPath: string): void {
  closeDb(dbPath)
}

export function createBaseConfig(overrides: Record<string, unknown> = {}): StoreConfig {
  return {
    store: {
      store_id: 'store-test',
      name: 'Store Test',
      timezone: 'UTC',
      locale: 'es',
    },
    providers: {
      bus: { driver: 'inmemory' },
      llm: { driver: 'groq', model: 'llama-3.1-8b-instant' },
      stt: { driver: 'mock' },
      tts: { driver: 'mock' },
      memory: { driver: 'sqlite' },
    },
    capture: {
      driver: 'local-stt',
      input: 'stdin',
    },
    employees: [],
    approvals: {
      default_channels: [{ type: 'webhook', timeout_ms: 60_000 }],
      default_strategy: 'parallel',
    },
    webhooks: {
      approval_response_path: '/approvals/respond',
    },
    tools: {
      enabled: [
        'product_search',
        'inventory_check',
        'customer_lookup',
        'order_create',
        'order_update',
        'order_confirm',
        'payment_intent_create',
        'receipt_print',
      ],
    },
    safety: {
      unknown_tool_default: 'restricted',
      tool_overrides: [],
    },
    storage: {
      sqlite_path: './data/store.db',
    },
    voice: {
      mode: 'direct-device',
      barge_in_enabled: true,
      turn_detection: 'hybrid',
      sample_rate: 16000,
    },
    retail: {
      service_mode: 'assisted-retail',
      store_position: 'cashier',
      greeting_style: 'Saluda con calidez y guía al cliente con claridad.',
      upsell_policy: 'light',
      handoff_policy: 'manual',
      customer_display_enabled: false,
      customer_display_mode: 'order',
    },
    connectors: {
      products: {
        driver: 'mock',
        headers: {},
        health_timeout_ms: 3000,
        retry_policy: { max_attempts: 3, backoff_ms: 250 },
        options: {},
      },
      orders: {
        driver: 'mock',
        headers: {},
        health_timeout_ms: 3000,
        retry_policy: { max_attempts: 3, backoff_ms: 250 },
        options: {},
      },
      customers: {
        driver: 'mock',
        headers: {},
        health_timeout_ms: 3000,
        retry_policy: { max_attempts: 3, backoff_ms: 250 },
        options: {},
      },
      payments: {
        driver: 'mock',
        headers: {},
        health_timeout_ms: 3000,
        retry_policy: { max_attempts: 3, backoff_ms: 250 },
        options: {},
      },
      inventory: {
        driver: 'mock',
        headers: {},
        health_timeout_ms: 3000,
        retry_policy: { max_attempts: 3, backoff_ms: 250 },
        options: {},
      },
      receipts: {
        driver: 'mock',
        headers: {},
        health_timeout_ms: 3000,
        retry_policy: { max_attempts: 3, backoff_ms: 250 },
        options: {},
      },
    },
    devices: {
      payment_terminal: { driver: 'mock', timeout_ms: 2000, connection: {} },
      receipt_printer: { driver: 'mock', timeout_ms: 2000, connection: {} },
      cash_drawer: { driver: 'mock', timeout_ms: 2000, connection: {} },
      customer_display: { driver: 'mock', timeout_ms: 2000, connection: {} },
    },
    policies: {
      discount_max_pct: 10,
      refund_max: 150,
      price_override_requires_role: 'manager',
      cancellation_window_minutes: 30,
      allowed_payment_methods: ['card', 'cash'],
      role_approval_defaults: {},
    },
    http: {
      host: '127.0.0.1',
      port: 3000,
      admin_secret_env: 'STORE_ADMIN_SECRET',
    },
    web_voice_bridge: {
      enabled: false,
      host: '0.0.0.0',
      port: 3040,
      mount_path: '/ws/voice',
      transport: 'websocket',
      audio_format: 'pcm_s16le',
      surface_defaults: ['avatar', 'customer-display'],
      publish_mode: 'redis',
      browser_vad: true,
      require_auth: false,
    },
    livekit_voice_bridge: {
      enabled: false,
      host: '0.0.0.0',
      port: 3050,
      agent_name: 'fitaly-store-runtime',
      transport: 'noop',
      websocket_url_env: 'LIVEKIT_URL',
      api_key_env: 'LIVEKIT_API_KEY',
      api_secret_env: 'LIVEKIT_API_SECRET',
      room_name_env: 'LIVEKIT_ROOM',
      participant_identity: 'fitaly-store-runtime',
      speaker_id_source: 'participant_identity',
      input_topic: 'fitaly.transcript',
      output_topic: 'fitaly.runtime',
      audio_track_name: 'fitaly-audio',
      publish_transcripts: true,
      forward_tts_audio: true,
      debug_ingress_enabled: false,
    },
    avatar: {
      enabled: false,
      mode: 'internal',
    },
    ...overrides,
  } as StoreConfig
}
