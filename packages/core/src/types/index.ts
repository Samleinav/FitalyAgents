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
