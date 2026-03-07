import { z } from 'zod'

// ── AgentManifest ────────────────────────────────────────────────────────────

export const DomainSchema = z.enum(['customer_facing', 'internal_ops', 'inter_agent', 'system'])
export type Domain = z.infer<typeof DomainSchema>

export const ContextModeSchema = z.enum(['stateless', 'stateful'])
export type ContextMode = z.infer<typeof ContextModeSchema>

export const AgentRoleSchema = z.enum(['DISPATCHER', 'SYSTEM']).nullable()
export type AgentRole = z.infer<typeof AgentRoleSchema>

export const ContextAccessSchema = z.object({
  read: z.array(z.string()),
  write: z.array(z.string()),
  forbidden: z.array(z.string()),
})
export type ContextAccess = z.infer<typeof ContextAccessSchema>

export const AgentManifestSchema = z.object({
  agent_id: z.string().min(1),
  display_name: z.string().optional(),
  description: z.string(),
  version: z.string(),
  domain: DomainSchema,
  scope: z.string(),
  capabilities: z.array(z.string()),
  context_mode: ContextModeSchema,
  context_access: ContextAccessSchema,
  async_tools: z.array(z.string()),
  input_channel: z.string(),
  output_channel: z.string(),
  priority: z.number().int().min(0).max(10),
  max_concurrent: z.number().int().min(1),
  timeout_ms: z.number().int().min(100),
  heartbeat_interval_ms: z.number().int().default(3000),
  role: AgentRoleSchema.default(null),
  accepts_from: z.array(z.string()),
  requires_human_approval: z.boolean().default(false),
})
export type AgentManifest = z.infer<typeof AgentManifestSchema>

// ── Bus Event schemas ────────────────────────────────────────────────────────

export const HeartbeatStatusSchema = z.enum(['idle', 'busy', 'draining'])
export type HeartbeatStatus = z.infer<typeof HeartbeatStatusSchema>

export const HeartbeatEventSchema = z.object({
  event: z.literal('HEARTBEAT'),
  agent_id: z.string(),
  status: HeartbeatStatusSchema,
  current_tasks: z.number().int().min(0),
  max_tasks: z.number().int().min(1),
  timestamp: z.number(),
})
export type HeartbeatEvent = z.infer<typeof HeartbeatEventSchema>

export const AgentRegisteredEventSchema = z.object({
  event: z.literal('AGENT_REGISTERED'),
  ...AgentManifestSchema.shape,
})
export type AgentRegisteredEvent = z.infer<typeof AgentRegisteredEventSchema>

export const AgentDeregisteredEventSchema = z.object({
  event: z.literal('AGENT_DEREGISTERED'),
  agent_id: z.string(),
  timestamp: z.number(),
})
export type AgentDeregisteredEvent = z.infer<typeof AgentDeregisteredEventSchema>

export const TaskPayloadEventSchema = z.object({
  event: z.literal('TASK_PAYLOAD'),
  task_id: z.string(),
  session_id: z.string(),
  intent_id: z.string(),
  slots: z.record(z.unknown()),
  context_snapshot: z.record(z.unknown()),
  cancel_token: z.string().nullable(),
  timeout_ms: z.number().int(),
  reply_to: z.string(),
})
export type TaskPayloadEvent = z.infer<typeof TaskPayloadEventSchema>

export const TaskStatusSchema = z.enum(['completed', 'failed', 'waiting_approval', 'cancelled'])
export type TaskStatus = z.infer<typeof TaskStatusSchema>

export const TaskResultEventSchema = z.object({
  event: z.literal('TASK_RESULT'),
  task_id: z.string(),
  session_id: z.string(),
  status: TaskStatusSchema,
  result: z.unknown().optional(),
  context_patch: z.record(z.unknown()),
  error: z.string().optional(),
  completed_at: z.number(),
})
export type TaskResultEvent = z.infer<typeof TaskResultEventSchema>

export const ActionCompletedEventSchema = z.object({
  event: z.literal('ACTION_COMPLETED'),
  task_id: z.string(),
  session_id: z.string(),
  intent_id: z.string(),
  agent_id: z.string(),
  result: z.unknown(),
  timestamp: z.number(),
})
export type ActionCompletedEvent = z.infer<typeof ActionCompletedEventSchema>

// ── Safety Bus Events (v2) ───────────────────────────────────────────────────

export const DraftCreatedEventSchema = z.object({
  event: z.literal('DRAFT_CREATED'),
  draft_id: z.string(),
  session_id: z.string(),
  intent_id: z.string(),
  summary: z.record(z.unknown()),
  ttl: z.number(),
})
export type DraftCreatedEvent = z.infer<typeof DraftCreatedEventSchema>

export const DraftConfirmedEventSchema = z.object({
  event: z.literal('DRAFT_CONFIRMED'),
  draft_id: z.string(),
  session_id: z.string(),
  intent_id: z.string(),
  items: z.record(z.unknown()),
  total: z.number().optional(),
})
export type DraftConfirmedEvent = z.infer<typeof DraftConfirmedEventSchema>

export const DraftCancelledEventSchema = z.object({
  event: z.literal('DRAFT_CANCELLED'),
  draft_id: z.string(),
  session_id: z.string(),
  reason: z.string(),
})
export type DraftCancelledEvent = z.infer<typeof DraftCancelledEventSchema>

export const ApprovalVoiceRequestEventSchema = z.object({
  event: z.literal('APPROVAL_VOICE_REQUEST'),
  request_id: z.string(),
  draft_id: z.string(),
  approver_id: z.string(),
  prompt_text: z.string(),
})
export type ApprovalVoiceRequestEvent = z.infer<typeof ApprovalVoiceRequestEventSchema>

export const ApprovalWebhookRequestEventSchema = z.object({
  event: z.literal('APPROVAL_WEBHOOK_REQUEST'),
  request_id: z.string(),
  draft_id: z.string(),
  required_role: z.string(),
  action: z.string(),
  amount: z.number().optional(),
  session_id: z.string(),
})
export type ApprovalWebhookRequestEvent = z.infer<typeof ApprovalWebhookRequestEventSchema>

export const ApprovalExternalRequestEventSchema = z.object({
  event: z.literal('APPROVAL_EXTERNAL_REQUEST'),
  request_id: z.string(),
  draft_id: z.string(),
  payload: z.record(z.unknown()),
})
export type ApprovalExternalRequestEvent = z.infer<typeof ApprovalExternalRequestEventSchema>

export const ApprovalExternalResponseEventSchema = z.object({
  event: z.literal('APPROVAL_EXTERNAL_RESPONSE'),
  request_id: z.string(),
  approved: z.boolean(),
  approver_id: z.string(),
  reason: z.string().optional(),
})
export type ApprovalExternalResponseEvent = z.infer<typeof ApprovalExternalResponseEventSchema>

export const ApprovalResolvedEventSchema = z.object({
  event: z.literal('APPROVAL_RESOLVED'),
  request_id: z.string(),
  draft_id: z.string(),
  approved: z.boolean(),
  approver_id: z.string(),
  channel_used: z.string(),
  timestamp: z.number(),
})
export type ApprovalResolvedEvent = z.infer<typeof ApprovalResolvedEventSchema>

// ── Session / Target Bus Events (v2) ─────────────────────────────────────────

export const SpeechPartialEventSchema = z.object({
  event: z.literal('SPEECH_PARTIAL'),
  session_id: z.string(),
  text: z.string(),
  confidence: z.number(),
  speaker_id: z.string().optional(),
})
export type SpeechPartialEvent = z.infer<typeof SpeechPartialEventSchema>

export const AmbientContextEventSchema = z.object({
  event: z.literal('AMBIENT_CONTEXT'),
  session_id: z.string(),
  speaker_id: z.string().optional(),
  text: z.string(),
  timestamp: z.number(),
})
export type AmbientContextEvent = z.infer<typeof AmbientContextEventSchema>

export const TargetDetectedEventSchema = z.object({
  event: z.literal('TARGET_DETECTED'),
  session_id: z.string(),
  speaker_id: z.string(),
  store_id: z.string(),
})
export type TargetDetectedEvent = z.infer<typeof TargetDetectedEventSchema>

export const TargetQueuedEventSchema = z.object({
  event: z.literal('TARGET_QUEUED'),
  session_id: z.string(),
  speaker_id: z.string(),
  position: z.number(),
})
export type TargetQueuedEvent = z.infer<typeof TargetQueuedEventSchema>

export const TargetGroupEventSchema = z.object({
  event: z.literal('TARGET_GROUP'),
  session_id: z.string(),
  speaker_ids: z.array(z.string()),
  primary: z.string().nullable(),
})
export type TargetGroupEvent = z.infer<typeof TargetGroupEventSchema>

export const ProactiveTriggerEventSchema = z.object({
  event: z.literal('PROACTIVE_TRIGGER'),
  session_id: z.string(),
  reason: z.string(),
  context: z.record(z.unknown()),
})
export type ProactiveTriggerEvent = z.infer<typeof ProactiveTriggerEventSchema>

export const TargetGroupChangedEventSchema = z.object({
  event: z.literal('TARGET_GROUP_CHANGED'),
  store_id: z.string(),
  primary: z.string().nullable(),
  queued: z.array(z.string()),
  ambient: z.array(z.string()),
  speakers: z.array(
    z.object({
      speakerId: z.string(),
      state: z.enum(['idle', 'targeted', 'responding', 'queued', 'ambient']),
    }),
  ),
  timestamp: z.number(),
})
export type TargetGroupChangedEvent = z.infer<typeof TargetGroupChangedEventSchema>

// ── IEventBus interface ──────────────────────────────────────────────────────

/**
 * Subscription handler for a specific channel.
 */
export type BusHandler = (data: unknown) => void

/**
 * Pattern subscription handler — receives the actual channel name and data.
 */
export type PatternBusHandler = (channel: string, data: unknown) => void

/**
 * Unsubscribe function returned by subscribe/psubscribe.
 */
export type Unsubscribe = () => void

/**
 * Options for creating a bus instance.
 */
export interface BusOptions {
  /** Redis URL (e.g. redis://localhost:6379). Required for RedisBus. */
  redisUrl?: string
  /** Whether to validate payloads with Zod on receive. Default: true */
  validateOnReceive?: boolean
}

/**
 * Abstract event bus interface.
 *
 * All inter-agent communication goes through an IEventBus.
 * Implementations: InMemoryBus (testing), RedisBus (production).
 */
export interface IEventBus {
  /**
   * Publish a message to a channel.
   * The payload is JSON-serialized automatically.
   */
  publish(channel: string, payload: unknown): Promise<void>

  /**
   * Subscribe to a specific channel.
   * Returns an unsubscribe function.
   */
  subscribe(channel: string, handler: BusHandler): Unsubscribe

  /**
   * Subscribe to channels matching a glob pattern (e.g. `bus:*`).
   * Handler receives the actual channel name and data.
   * Returns an unsubscribe function.
   */
  psubscribe(pattern: string, handler: PatternBusHandler): Unsubscribe

  /**
   * Push a message to a Redis list (for queue-based communication like agent inboxes).
   * Falls back to publish() in InMemoryBus.
   */
  lpush(key: string, payload: unknown): Promise<void>

  /**
   * Blocking pop from a Redis list (for queue-based communication).
   * Returns null if timeout expires.
   */
  brpop(key: string, timeoutSeconds: number): Promise<unknown | null>

  /**
   * Gracefully disconnect from the bus.
   */
  disconnect(): Promise<void>
}
