/**
 * @module fitalyagents
 *
 * Multi-agent framework for async parallel tool orchestration and intelligent task dispatch.
 *
 * @example
 * ```typescript
 * import { StreamAgent, createBus } from 'fitalyagents'
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
  DraftCreatedEvent,
  DraftConfirmedEvent,
  DraftCancelledEvent,
  ApprovalVoiceRequestEvent,
  ApprovalWebhookRequestEvent,
  ApprovalExternalRequestEvent,
  ApprovalExternalResponseEvent,
  ApprovalResolvedEvent,
  SpeechPartialEvent,
  AmbientContextEvent,
  TargetDetectedEvent,
  TargetQueuedEvent,
  TargetGroupEvent,
  ProactiveTriggerEvent,
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
  DraftCreatedEventSchema,
  DraftConfirmedEventSchema,
  DraftCancelledEventSchema,
  ApprovalVoiceRequestEventSchema,
  ApprovalWebhookRequestEventSchema,
  ApprovalExternalRequestEventSchema,
  ApprovalExternalResponseEventSchema,
  ApprovalResolvedEventSchema,
  SpeechPartialEventSchema,
  AmbientContextEventSchema,
  TargetDetectedEventSchema,
  TargetQueuedEventSchema,
  TargetGroupEventSchema,
  ProactiveTriggerEventSchema,
} from './types/index.js'

// Bus
export { InMemoryBus } from './bus/in-memory-bus.js'
export { RedisBus, createBus } from './bus/redis-bus.js'

// Agent
/** @deprecated Use StreamAgent instead. Will be removed in v2.0.0. */
export { NexusAgent } from './agent/nexus-agent.js'
export type { NexusAgentOptions } from './agent/nexus-agent.js'
export { AgentBundle } from './agent/agent-bundle.js'
export type { AgentBundleOptions, Disposable } from './agent/agent-bundle.js'
export { StreamAgent } from './agent/stream-agent.js'

// Context
export { InMemoryContextStore } from './context/in-memory-context-store.js'
export { AccessDeniedError, enforceAccess } from './context/types.js'
export type { IContextStore, AmbientContext } from './context/types.js'

// Session
export { InMemorySessionManager } from './session/in-memory-session-manager.js'
export { TargetGroupStateMachine } from './session/target-group.js'
export type { TargetState, TargetEvent, SpeakerEntry } from './session/target-group.js'
export type {
  ISessionManager,
  Session,
  PriorityGroup,
  OnSessionTerminated,
} from './session/types.js'

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

// Approval Queue (v1 — backwards compat)
export { InMemoryApprovalQueue } from './approval/in-memory-approval-queue.js'
export { ApprovalNotFoundError, ApprovalAlreadyResolvedError } from './approval/types.js'
export type {
  IApprovalQueue,
  ApprovalRecord,
  ApprovalStatus,
  ApprovalQueueDeps,
} from './approval/types.js'

// Safety Module (v2)
export type {
  SafetyLevel,
  HumanRole,
  HumanProfile,
  ApprovalLimits,
  ApprovalChannelType,
  ApprovalStrategy,
  ApprovalRequest,
  ApprovalResponse,
  ChannelConfig,
  IApprovalChannel,
  SafetyDecision,
  ApprovalOrchestratorDeps,
} from './safety/channels/types.js'
export { SafetyGuard, defaultLimits } from './safety/safety-guard.js'
export type { ToolSafetyConfig } from './safety/safety-guard.js'
export { InMemoryDraftStore } from './safety/draft-store.js'
export type { IDraftStore, Draft, DraftInput, DraftStatus } from './safety/draft-store.js'
export { VoiceApprovalChannel } from './safety/channels/voice-channel.js'
export { WebhookApprovalChannel } from './safety/channels/webhook-channel.js'
export { ExternalToolChannel } from './safety/channels/external-tool-channel.js'
export type { ExternalToolChannelConfig } from './safety/channels/external-tool-channel.js'
export { ApprovalOrchestrator } from './safety/approval-orchestrator.js'
