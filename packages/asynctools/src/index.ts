/**
 * @module fitalyagents/asynctools
 *
 * Standalone async parallel tool execution for any LLM agent.
 * No Redis, no bus — just wrap your agent and get parallel async tools.
 *
 * @example
 * ```typescript
 * import { ToolRegistry } from 'fitalyagents/asynctools'
 *
 * const registry = new ToolRegistry()
 * registry.register({
 *   tool_id: 'product_search',
 *   executor: { type: 'http', url: 'https://api.store.com/search', method: 'POST' },
 *   execution_mode: 'async',
 *   timeout_ms: 5000,
 * })
 * ```
 */

// Types — re-export everything
export type {
  ExecutionMode,
  InjectionStrategy,
  ToolStatus,
  ExecutorType,
  HttpExecutorConfig,
  FunctionExecutorConfig,
  SubprocessExecutorConfig,
  ExecutorConfig,
  RetryConfig,
  RateLimitConfig,
  CircuitBreakerConfig,
  ToolDefinition,
  ToolResult,
  PendingToolCall,
  TurnState,
  IInnerAgent,
  Message,
  ToolResultContent,
  ToolCallRequest,
  AgentResponse,
  ExecutorStats,
} from './types/index.js'

// Schemas — re-export for runtime validation
export {
  ExecutionModeSchema,
  InjectionStrategySchema,
  ToolStatusSchema,
  ExecutorTypeSchema,
  HttpExecutorConfigSchema,
  FunctionExecutorConfigSchema,
  SubprocessExecutorConfigSchema,
  ExecutorConfigSchema,
  RetryConfigSchema,
  RateLimitConfigSchema,
  CircuitBreakerConfigSchema,
  ToolDefinitionSchema,
} from './types/index.js'

// Registry
export { ToolRegistry } from './registry/tool-registry.js'

// Executor
export { ExecutorPool } from './executor/executor-pool.js'
export { HttpExecutor } from './executor/http-executor.js'
export { FunctionExecutor } from './executor/function-executor.js'
export { SubprocessExecutor } from './executor/subprocess-executor.js'
export { registerFunctionHandler, clearFunctionHandlers } from './executor/function-executor.js'
export { RateLimiter } from './executor/rate-limiter.js'
export { CircuitBreaker } from './executor/circuit-breaker.js'
export type { CircuitState, CircuitBreakerCallbacks } from './executor/circuit-breaker.js'
export type { IExecutor } from './executor/types.js'

// Tracking
export { InMemoryPendingStateTracker } from './tracking/in-memory-tracker.js'
export type { IPendingStateTracker } from './tracking/types.js'

// Injection
export { InjectionManager } from './injection/injection-manager.js'

// AsyncAgent wrapper
export { AsyncAgent } from './wrapper/async-agent.js'
export type { AsyncAgentOptions } from './wrapper/async-agent.js'

// Errors
export {
  FitalyError,
  ToolNotFoundError,
  ToolValidationError,
  DuplicateToolError,
  HttpExecutorError,
  ToolExecutionError,
} from './errors.js'
