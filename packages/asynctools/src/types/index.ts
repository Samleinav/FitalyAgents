import { z } from 'zod'

// ─── Execution Mode ─────────────────────────────────────────────────────────
/**
 * Controls how a tool call is executed relative to the agent's turn.
 *
 * - `sync` — Block the turn until the tool completes. Result injected immediately.
 * - `async` — Launch in background. Result injected when strategy resolves.
 * - `fire_forget` — Launch in background. Result is NEVER injected.
 * - `deferred` — Like async but waits until end of turn to inject.
 */
export const ExecutionModeSchema = z.enum(['sync', 'async', 'fire_forget', 'deferred'])
export type ExecutionMode = z.infer<typeof ExecutionModeSchema>

// ─── Injection Strategy ─────────────────────────────────────────────────────
/**
 * Determines when pending async tool results are re-injected into the agent.
 *
 * - `inject_when_all` — Wait for ALL tool calls to complete/fail/timeout.
 * - `inject_when_ready` — Inject as soon as ANY single tool completes.
 * - `inject_on_timeout` — Only inject when the global timeout expires.
 */
export const InjectionStrategySchema = z.enum([
  'inject_when_all',
  'inject_when_ready',
  'inject_on_timeout',
])
export type InjectionStrategy = z.infer<typeof InjectionStrategySchema>

// ─── Tool Status ────────────────────────────────────────────────────────────
export const ToolStatusSchema = z.enum(['pending', 'running', 'completed', 'failed', 'timed_out'])
export type ToolStatus = z.infer<typeof ToolStatusSchema>

// ─── Executor Type ──────────────────────────────────────────────────────────
export const ExecutorTypeSchema = z.enum(['http', 'ts_fn', 'subprocess'])
export type ExecutorType = z.infer<typeof ExecutorTypeSchema>

// ─── HTTP Executor Config ───────────────────────────────────────────────────
export const HttpExecutorConfigSchema = z.object({
  type: z.literal('http'),
  url: z.string().url(),
  method: z.enum(['GET', 'POST', 'PUT']).default('POST'),
  headers: z.record(z.string()).optional(),
})
export type HttpExecutorConfig = z.infer<typeof HttpExecutorConfigSchema>

// ─── Function Executor Config ───────────────────────────────────────────────
export const FunctionExecutorConfigSchema = z.object({
  type: z.literal('ts_fn'),
  /** The function reference is set programmatically, not from JSON */
  handler: z.any().optional(),
})
export type FunctionExecutorConfig = z.infer<typeof FunctionExecutorConfigSchema>

// ─── Subprocess Executor Config ─────────────────────────────────────────────
export const SubprocessExecutorConfigSchema = z.object({
  type: z.literal('subprocess'),
  command: z.string(),
  args: z.array(z.string()).default([]),
  cwd: z.string().optional(),
  env: z.record(z.string()).optional(),
})
export type SubprocessExecutorConfig = z.infer<typeof SubprocessExecutorConfigSchema>

// ─── Executor Config (union) ────────────────────────────────────────────────
export const ExecutorConfigSchema = z.discriminatedUnion('type', [
  HttpExecutorConfigSchema,
  FunctionExecutorConfigSchema,
  SubprocessExecutorConfigSchema,
])
export type ExecutorConfig = z.infer<typeof ExecutorConfigSchema>

// ─── Retry Config ───────────────────────────────────────────────────────────
export const RetryConfigSchema = z.object({
  max_attempts: z.number().int().min(1).default(1),
  backoff_ms: z.number().int().min(0).default(200),
})
export type RetryConfig = z.infer<typeof RetryConfigSchema>

// ─── Tool Definition ────────────────────────────────────────────────────────
/**
 * Complete definition of a tool that an async agent can invoke.
 *
 * @example
 * ```typescript
 * const tool: ToolDefinition = {
 *   tool_id: 'product_search',
 *   description: 'Search products by brand, size, color',
 *   executor: { type: 'http', url: 'https://api.store.com/search', method: 'POST' },
 *   execution_mode: 'async',
 *   timeout_ms: 5000,
 *   max_concurrent: 3,
 *   retry: { max_attempts: 2, backoff_ms: 300 },
 *   input_schema: { type: 'object', properties: { brand: { type: 'string' } } },
 *   output_schema: { type: 'object', properties: { results: { type: 'array' } } },
 * }
 * ```
 */
export const ToolDefinitionSchema = z.object({
  tool_id: z.string().min(1),
  description: z.string().optional(),
  executor: ExecutorConfigSchema,
  execution_mode: ExecutionModeSchema.default('async'),
  timeout_ms: z.number().int().min(100).default(10_000),
  max_concurrent: z.number().int().min(1).default(5),
  retry: RetryConfigSchema.default({}),
  input_schema: z.record(z.unknown()).optional(),
  output_schema: z.record(z.unknown()).optional(),

  // ── Safety (v2) ──────────────────────────────────────────────────
  /** Safety level: safe, staged, protected, restricted. Default: safe */
  safety: z.enum(['safe', 'staged', 'protected', 'restricted']).default('safe'),
  /** Role required to execute without approval (for restricted tools) */
  required_role: z.enum(['customer', 'staff', 'cashier', 'manager', 'owner']).optional(),
  /** Confirmation prompt template (for protected tools) */
  confirm_prompt: z.string().optional(),
  /** Action name for creating staged drafts */
  staged_action: z.string().optional(),
  /** Approval channels config (for restricted tools) */
  approval_channels: z
    .array(
      z.object({
        type: z.enum(['voice', 'webhook', 'external_tool']),
        timeout_ms: z.number().int().min(100),
        config: z
          .object({
            url: z.string().optional(),
            method: z.enum(['POST', 'GET']).optional(),
            auth: z.string().optional(),
          })
          .optional(),
      }),
    )
    .optional(),
  /** Approval strategy: parallel or sequential */
  approval_strategy: z.enum(['parallel', 'sequential']).optional(),
})
export type ToolDefinition = z.infer<typeof ToolDefinitionSchema>

// ─── Tool Result ────────────────────────────────────────────────────────────
export interface ToolResult {
  tool_call_id: string
  tool_id: string
  status: ToolStatus
  result?: unknown
  error?: string
  started_at: number
  completed_at: number
  duration_ms: number
}

// ─── Pending Tool Call ──────────────────────────────────────────────────────
export interface PendingToolCall {
  tool_call_id: string
  tool_id: string
  status: ToolStatus
  input: unknown
  created_at: number
}

// ─── Turn State ─────────────────────────────────────────────────────────────
export interface TurnState {
  turn_id: string
  agent_id: string
  strategy: InjectionStrategy
  global_timeout_ms: number
  tool_calls: Map<string, PendingToolCall>
  results: Map<string, ToolResult>
  created_at: number
}

// ─── Inner Agent interface ──────────────────────────────────────────────────
/**
 * Minimal interface that any LLM agent must satisfy to be wrapped by AsyncAgent.
 * This is intentionally loose — works with OpenAI, Anthropic, LangChain, custom, etc.
 */
export interface IInnerAgent {
  run(messages: Message[]): Promise<AgentResponse>
}

// ─── Message types ──────────────────────────────────────────────────────────
export interface Message {
  role: 'user' | 'assistant' | 'system' | 'tool'
  content: string | ToolResultContent[]
  tool_call_id?: string
}

export interface ToolResultContent {
  type: 'tool_result'
  tool_call_id: string
  content: string
}

export interface ToolCallRequest {
  id: string
  tool_id: string
  input: unknown
}

export interface AgentResponse {
  content?: string
  tool_calls?: ToolCallRequest[]
  stop_reason?: 'end_turn' | 'tool_use' | 'max_tokens'
}

// ─── Executor Stats ─────────────────────────────────────────────────────────
export interface ExecutorStats {
  executing: number
  queued: number
  completed: number
  failed: number
}
