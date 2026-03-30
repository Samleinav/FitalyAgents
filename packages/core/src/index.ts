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
  AgentErrorEvent,
  DraftCreatedEvent,
  DraftConfirmedEvent,
  DraftCancelledEvent,
  ApprovalVoiceRequestEvent,
  ApprovalWebhookRequestEvent,
  ApprovalExternalRequestEvent,
  ApprovalExternalResponseEvent,
  ApprovalResolvedEvent,
  SpeechPartialEvent,
  SpeechFinalEvent,
  AmbientContextEvent,
  TargetDetectedEvent,
  TargetQueuedEvent,
  TargetGroupEvent,
  ProactiveTriggerEvent,
  TargetGroupChangedEvent,
  InteractionPauseEvent,
  InteractionResumeEvent,
  StaffCommandEvent,
  UIUpdateEvent,
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
  AgentErrorEventSchema,
  DraftCreatedEventSchema,
  DraftConfirmedEventSchema,
  DraftCancelledEventSchema,
  ApprovalVoiceRequestEventSchema,
  ApprovalWebhookRequestEventSchema,
  ApprovalExternalRequestEventSchema,
  ApprovalExternalResponseEventSchema,
  ApprovalResolvedEventSchema,
  SpeechPartialEventSchema,
  SpeechFinalEventSchema,
  AmbientContextEventSchema,
  TargetDetectedEventSchema,
  TargetQueuedEventSchema,
  TargetGroupEventSchema,
  ProactiveTriggerEventSchema,
  TargetGroupChangedEventSchema,
  InteractionPauseEventSchema,
  InteractionResumeEventSchema,
  StaffCommandEventSchema,
  UIUpdateEventSchema,
} from './types/index.js'

// Bus
export { InMemoryBus } from './bus/in-memory-bus.js'
export { RedisBus, createBus } from './bus/redis-bus.js'

// Agent
export { AgentBundle } from './agent/agent-bundle.js'
export type { AgentBundleOptions, Disposable, IAgent } from './agent/agent-bundle.js'
export { StreamAgent } from './agent/stream-agent.js'
export { InteractionAgent } from './agent/interaction-agent.js'
export { StaffAgent } from './agent/staff-agent.js'
export type { StaffAgentConfig, StaffAgentDeps, StaffSpeechPayload } from './agent/staff-agent.js'
export { UIAgent } from './agent/ui-agent.js'
export type { UIUpdatePayload, UIEventHandler, UIAgentDeps } from './agent/ui-agent.js'
export { AmbientAgent } from './agent/ambient-agent.js'
export type {
  AmbientAnalysis,
  AmbientAgentConfig,
  AmbientAgentDeps,
} from './agent/ambient-agent.js'
export { ContextBuilderAgent } from './agent/context-builder-agent.js'
export type {
  ConversationContext,
  ConversationTurn,
  ContextBuilderConfig,
} from './agent/context-builder-agent.js'
export { ProactiveAgent } from './agent/proactive-agent.js'
export type {
  ProactiveReason,
  ProactiveTrigger,
  ProactiveAgentConfig,
} from './agent/proactive-agent.js'
export type {
  IStreamingLLM,
  LLMStreamChunk,
  InteractionToolDef,
  IToolExecutor,
  ISpeculativeCache,
  ToolCallResult,
  InteractionAgentDeps,
  DraftFlowResult,
  DraftUserIntent,
  ProtectedConfirmResult,
} from './agent/interaction-agent.js'
export { TargetGroupBridge } from './agent/target-group-bridge.js'
export type {
  TargetGroupBridgeConfig,
  TargetGroupSnapshot,
  SpeakerDetectedPayload,
  SpeakerLostPayload,
  SpeakerAmbientPayload,
} from './agent/target-group-bridge.js'

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

// Tracing
export type {
  ITracer,
  ITrace,
  ISpan,
  GenerationParams,
  TracerStartParams,
} from './tracing/types.js'
export { NoopTracer, NoopTrace, NoopSpan } from './tracing/noop-tracer.js'
export { LangfuseTracer } from './tracing/langfuse-tracer.js'
export type { LangfuseClientLike } from './tracing/langfuse-tracer.js'
