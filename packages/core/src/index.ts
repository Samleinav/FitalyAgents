/**
 * @module fitalyagents
 *
 * SDK for async parallel tool orchestration and intelligent agent dispatch.
 *
 * @example
 * ```typescript
 * import { NexusAgent, createBus } from 'fitalyagents'
 *
 * const bus = await createBus({ redisUrl: process.env.REDIS_URL })
 * ```
 */

// Types — re-export everything
export type {
  Domain,
  ContextMode,
  AgentRole,
  ContextAccess,
  AgentManifest,
  HeartbeatStatus,
  HeartbeatEvent,
  AgentRegisteredEvent,
  AgentDeregisteredEvent,
  TaskPayloadEvent,
  TaskStatus,
  TaskResultEvent,
  ActionCompletedEvent,
  BusHandler,
  PatternBusHandler,
  Unsubscribe,
  BusOptions,
  IEventBus,
} from './types/index.js'

// Schemas — re-export for runtime validation
export {
  DomainSchema,
  ContextModeSchema,
  AgentRoleSchema,
  ContextAccessSchema,
  AgentManifestSchema,
  HeartbeatStatusSchema,
  HeartbeatEventSchema,
  AgentRegisteredEventSchema,
  AgentDeregisteredEventSchema,
  TaskPayloadEventSchema,
  TaskStatusSchema,
  TaskResultEventSchema,
  ActionCompletedEventSchema,
} from './types/index.js'

// Bus
export { InMemoryBus } from './bus/in-memory-bus.js'
export { RedisBus, createBus } from './bus/redis-bus.js'

// Agent
export { NexusAgent } from './agent/nexus-agent.js'
export type { NexusAgentOptions } from './agent/nexus-agent.js'

// Registry
export { AgentRegistry } from './registry/agent-registry.js'
export type { RegistryFilters } from './registry/agent-registry.js'

// Context
export { InMemoryContextStore } from './context/in-memory-context-store.js'
export { AccessDeniedError, enforceAccess } from './context/types.js'
export type { IContextStore } from './context/types.js'

// Locks
export { InMemoryLockManager } from './locks/in-memory-lock-manager.js'
export type { ILockManager, LockValue, OnLockExpired } from './locks/types.js'

// Session
export { InMemorySessionManager } from './session/in-memory-session-manager.js'
export type {
  ISessionManager,
  Session,
  PriorityGroup,
  OnSessionTerminated,
} from './session/types.js'

// Tasks
export { InMemoryTaskQueue } from './tasks/in-memory-task-queue.js'
export type { ITaskQueue, Task, TaskInput, QueueTaskStatus, TaskQueueDeps } from './tasks/types.js'

// Routing
export { CapabilityRouter } from './routing/capability-router.js'
export type {
  ICapabilityRouter,
  RouteResult,
  RouteRequirements,
  TaskAvailableEvent,
  CapabilityRouterDeps,
} from './routing/types.js'

// Audio Queue
export { InMemoryAudioQueueService } from './audio/in-memory-audio-queue-service.js'
export type {
  IAudioQueueService,
  AudioSegment,
  PushResult,
  PlaybackState,
  OnSegmentReady,
  AudioQueueServiceDeps,
} from './audio/types.js'

// Approval Queue
export { InMemoryApprovalQueue } from './approval/in-memory-approval-queue.js'
export { ApprovalNotFoundError, ApprovalAlreadyResolvedError } from './approval/types.js'
export type {
  IApprovalQueue,
  ApprovalRecord,
  ApprovalStatus,
  ApprovalQueueDeps,
} from './approval/types.js'
