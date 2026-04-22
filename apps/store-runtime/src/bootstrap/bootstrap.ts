import {
  AgentBundle,
  InMemoryContextStore,
  InMemoryPresenceManager,
  InMemorySessionManager,
  SafetyGuard,
  createBus,
} from 'fitalyagents'
import { loadStoreConfig } from '../config/load-store-config.js'
import { createLLMProvider } from '../providers/llm/factory.js'
import { createMemoryStore } from '../providers/memory/types.js'
import { createSTTProvider } from '../providers/stt/types.js'
import { createTTSProvider, describeTTSOutputFormat } from '../providers/tts/types.js'
import { getDb } from '../storage/db.js'
import {
  ApprovalRepository,
  CustomerRepository,
  DraftRepository,
  EmployeeRepository,
  OrderRepository,
  SessionRepository,
  WebhookRepository,
} from '../storage/repositories/index.js'
import { ToolRegistry } from '../tools/registry.js'
import { buildAgents } from '../agents/build-agents.js'
import { buildApprovalChannels } from './build-approval-channels.js'
import { buildMemoryScopeResolver } from './build-scope-resolver.js'
import { PersistentApprovalOrchestrator } from './persistent-approval-orchestrator.js'
import { PersistentDraftStore } from './persistent-draft-store.js'
import { buildShutdown } from './shutdown.js'
import { startSttBridge } from './stt-bridge.js'
import { syncEmployees } from './sync-employees.js'
import { TtsStreamService } from './tts-stream.js'
import { startHttpServer } from '../http/server.js'
import { registerRetailPresetTools } from '../retail/preset.js'

export async function bootstrap(configPath: string): Promise<() => Promise<void>> {
  const config = await loadStoreConfig(configPath)
  const db = getDb(config.storage.sqlite_path)

  const repositories = {
    customers: new CustomerRepository(db),
    employees: new EmployeeRepository(db),
    drafts: new DraftRepository(db),
    orders: new OrderRepository(db),
    approvals: new ApprovalRepository(db),
    sessions: new SessionRepository(db),
    webhooks: new WebhookRepository(db),
  }

  const bus =
    config.providers.bus.driver === 'redis'
      ? await createBus({ redisUrl: config.providers.bus.url })
      : await createBus()

  const llm = createLLMProvider(config.providers.llm)
  const stt = config.capture.driver === 'local-stt' ? createSTTProvider(config.providers.stt) : null
  const tts = createTTSProvider(config.providers.tts)
  const memoryStore = createMemoryStore(config.providers.memory, config.storage.sqlite_path)

  const contextStore = new InMemoryContextStore()
  const sessionManager = new InMemorySessionManager()
  const presenceManager = new InMemoryPresenceManager({ bus })
  presenceManager.start()

  syncEmployees(repositories.employees, presenceManager, config.employees, config.store.store_id)

  const readinessState = {
    ready: false,
    isReady() {
      return this.ready
    },
  }

  const memoryScopeResolver = buildMemoryScopeResolver(config)
  const ttsStream = new TtsStreamService({
    bus,
    tts,
    audioFormat: describeTTSOutputFormat(config.providers.tts, {
      sampleRate: config.voice.sample_rate,
    }),
    outputPath: process.env.STORE_AUDIO_OUTPUT_PIPE,
  })
  ttsStream.start()

  const approvalChannels = buildApprovalChannels(config, bus, repositories.webhooks)
  const approvalOrchestrator = new PersistentApprovalOrchestrator({
    bus,
    channelRegistry: approvalChannels,
    presenceManager,
    defaultTimeoutMs: 120_000,
    repository: repositories.approvals,
  })
  approvalOrchestrator.start()

  const toolRegistry = new ToolRegistry({
    bus,
    db,
    storeId: config.store.store_id,
    repositories,
    approvalOrchestrator,
    approvalsConfig: config.approvals,
    employees: config.employees,
    policies: config.policies,
  })

  registerEnabledTools(toolRegistry, config, db, repositories)

  const draftStore = new PersistentDraftStore({
    bus,
    repository: repositories.drafts,
    toolRegistry,
  })

  const safetyGuard = new SafetyGuard({
    toolConfigs: [...toolRegistry.toInteractionToolDefs().values()].map((tool) => ({
      name: tool.tool_id,
      safety: tool.safety,
      required_role: tool.required_role,
      confirm_prompt: tool.confirm_prompt,
      approval_channels: config.approvals.default_channels,
      approval_strategy: config.approvals.default_strategy,
      quorum: tool.quorum ?? config.approvals.quorum,
    })),
  })

  const { agents, disposables } = buildAgents({
    bus,
    llm,
    contextStore,
    sessionManager,
    presenceManager,
    safetyGuard,
    draftStore,
    approvalOrchestrator,
    toolRegistry,
    ttsStream,
    sessionRepository: repositories.sessions,
    draftRepository: repositories.drafts,
    config,
    memoryStore,
    memoryScopeResolver,
  })

  const bundle = new AgentBundle({
    agents,
    disposables: [contextStore, presenceManager, sessionManager, ...disposables],
  })

  await bundle.start()

  const httpServer = await startHttpServer({
    config,
    bus,
    presenceManager,
    sessionManager,
    repositories: {
      approvals: repositories.approvals,
      employees: repositories.employees,
      sessions: repositories.sessions,
    },
    readiness: readinessState,
    agentCount: agents.length,
  })

  const sttBridge = await startSttBridge(config, stt, bus, ttsStream)
  readinessState.ready = true

  const shutdown = buildShutdown({
    dbPath: config.storage.sqlite_path,
    bundleStop: () => bundle.stop(),
    bundleDispose: () => bundle.dispose(),
    httpClose: () => httpServer.close(),
    sttClose: () => sttBridge.close(),
    servicesDispose: [
      () => draftStore.dispose(),
      () => ttsStream.dispose(),
      () => stt?.dispose(),
      () => approvalOrchestrator.dispose(),
      () => {
        if ('disconnect' in bus && typeof bus.disconnect === 'function') {
          void bus.disconnect()
        }
      },
    ],
    llmDispose: () => llm.dispose(),
    memoryDispose: memoryStore.dispose ? () => memoryStore.dispose?.() : undefined,
  })

  process.on('SIGTERM', () => {
    void shutdown()
  })
  process.on('SIGINT', () => {
    void shutdown()
  })

  return shutdown
}

function registerEnabledTools(
  toolRegistry: ToolRegistry,
  config: Awaited<ReturnType<typeof loadStoreConfig>>,
  db: Parameters<typeof registerRetailPresetTools>[0]['db'],
  repositories: Parameters<typeof registerRetailPresetTools>[0]['repositories'],
): void {
  registerRetailPresetTools({
    toolRegistry,
    config,
    db,
    repositories,
  })
}
