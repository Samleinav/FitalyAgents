import {
  AIRIRenderer,
  AmbientAgent,
  AvatarAgent,
  ContextBuilderAgent,
  type IEventBus,
  InteractionAgent,
  ProactiveAgent,
  SentimentGuard,
  StaffAgent,
  UIAgent,
  TargetGroupBridge,
  type IAgent,
  type InMemoryContextStore,
  type InMemoryPresenceManager,
  type InMemorySessionManager,
  type SafetyGuard,
} from 'fitalyagents'
import type { IMemoryStore, MemoryScopeResolver } from '@fitalyagents/dispatcher'
import type { StoreConfig } from '../config/schema.js'
import type { SessionBoundLLM } from '../providers/llm/types.js'
import type { PersistentApprovalOrchestrator } from '../bootstrap/persistent-approval-orchestrator.js'
import type { PersistentDraftStore } from '../bootstrap/persistent-draft-store.js'
import { buildSpeakerSessionId } from '../bootstrap/speaker-session.js'
import type { TtsStreamService } from '../bootstrap/tts-stream.js'
import type { SessionRepository, DraftRepository } from '../storage/repositories/index.js'
import type { ToolRegistry } from '../tools/registry.js'
import { InteractionRuntimeAgent } from './interaction-runtime-agent.js'
import { buildRetailSystemPrompt } from '../retail/preset.js'

export interface BuildAgentsResult {
  agents: IAgent[]
  interaction: InteractionAgent
  disposables: Array<{ dispose(): void }>
}

export function buildAgents(deps: {
  bus: IEventBus
  llm: SessionBoundLLM
  contextStore: InMemoryContextStore
  sessionManager: InMemorySessionManager
  presenceManager: InMemoryPresenceManager
  safetyGuard: SafetyGuard
  draftStore: PersistentDraftStore
  approvalOrchestrator: PersistentApprovalOrchestrator
  toolRegistry: ToolRegistry
  ttsStream: TtsStreamService
  sessionRepository: SessionRepository
  draftRepository: DraftRepository
  config: StoreConfig
  memoryStore?: IMemoryStore
  memoryScopeResolver?: MemoryScopeResolver
}): BuildAgentsResult {
  const interaction = new InteractionAgent({
    bus: deps.bus,
    llm: deps.llm,
    contextStore: deps.contextStore,
    toolRegistry: deps.toolRegistry.toInteractionToolDefs(),
    executor: deps.toolRegistry,
    safetyGuard: deps.safetyGuard,
    draftStore: deps.draftStore,
    approvalOrchestrator: deps.approvalOrchestrator,
    systemPrompt: buildRetailSystemPrompt(deps.config),
    ttsCallback: (text, sessionId) => {
      void deps.ttsStream.handleTextChunk(sessionId, text)
    },
  })

  const interactionUnsubs = [
    interaction.subscribePauseResume(),
    interaction.subscribeApprovalEvents(),
    interaction.subscribeDraftExpiry(),
  ]

  const staffProfiles = new Map(
    deps.config.employees.map((employee) => [
      employee.id,
      {
        id: employee.id,
        name: employee.name,
        role: employee.role,
        org_id: deps.config.store.store_id,
        store_id: deps.config.store.store_id,
        approval_limits: employee.approval_limits,
      },
    ]),
  )

  const agents: IAgent[] = [
    new TargetGroupBridge({
      bus: deps.bus,
      sessionManager: deps.sessionManager,
      storeId: deps.config.store.store_id,
      defaultSessionMetadata: {
        store_id: deps.config.store.store_id,
      },
      resolveSessionId:
        deps.config.capture.driver === 'local-stt'
          ? undefined
          : (speakerId: string) => buildSpeakerSessionId(deps.config.store.store_id, speakerId),
    }),
    new StaffAgent({
      bus: deps.bus,
      llm: deps.llm,
      safetyGuard: deps.safetyGuard,
      toolRegistry: deps.toolRegistry.toInteractionToolDefs(),
      executor: deps.toolRegistry,
      staffProfiles,
    }),
    new AmbientAgent({
      bus: deps.bus,
      llm: deps.llm,
      contextStore: deps.contextStore,
    }),
    new SentimentGuard({
      bus: deps.bus,
      contextStore: deps.contextStore,
    }),
    new ProactiveAgent({
      bus: deps.bus,
      contextStore: deps.contextStore,
    }),
    new ContextBuilderAgent({
      bus: deps.bus,
      contextStore: deps.contextStore,
    }),
    new UIAgent({
      bus: deps.bus,
    }),
    new InteractionRuntimeAgent({
      bus: deps.bus,
      interaction,
      llm: deps.llm,
      toolRegistry: deps.toolRegistry,
      contextStore: deps.contextStore,
      sessionManager: deps.sessionManager,
      sessionRepository: deps.sessionRepository,
      draftStore: deps.draftStore,
      draftRepository: deps.draftRepository,
      ttsStream: deps.ttsStream,
      storeId: deps.config.store.store_id,
      captureDriver: deps.config.capture.driver,
      memoryStore: deps.memoryStore,
      memoryScopeResolver: deps.memoryScopeResolver,
    }),
  ]

  if (
    deps.config.avatar.enabled &&
    deps.config.avatar.mode === 'internal' &&
    deps.config.avatar.airi_url
  ) {
    agents.push(
      new AvatarAgent({
        bus: deps.bus,
        renderer: new AIRIRenderer({
          url: deps.config.avatar.airi_url,
        }),
      }),
    )
  }

  return {
    agents,
    interaction,
    disposables: [
      {
        dispose() {
          for (const unsub of interactionUnsubs) {
            unsub()
          }
        },
      },
    ],
  }
}
