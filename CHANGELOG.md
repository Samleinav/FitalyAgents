# Changelog

All notable changes to this project will be documented in this file.

The format is based on [Keep a Changelog](https://keepachangelog.com/en/1.1.0/),
and this project adheres to [Semantic Versioning](https://semver.org/spec/v2.0.0.html).

---

## [2.0.0] — Unreleased

> FitalyAgents v2: el LLM es el cerebro, el dispatcher es un acelerador especulativo.
> Framework reenfocado como motor para asistentes de voz en retail físico (FitalyStore).

### Breaking Changes

- **Eliminados de `packages/core`:** `CapabilityRouter`, `SimpleRouter`, `AgentRegistry`, `LockManager`, `TaskQueue` — el LLM hace el routing directamente via tool_call
- **`NexusAgent`** reemplazado por `StreamAgent` (subscribe to bus channels, no inbox/outbox)
- **`InMemoryApprovalQueue`** migrado a `ApprovalOrchestrator` con canales configurables; `IApprovalQueue` se mantiene como re-export para backwards compat
- Bus events eliminados: `bus:TASK_AVAILABLE`, `bus:DISPATCH_FALLBACK`, `bus:INTENT_UPDATED`
- Channels eliminados: `queue:*:inbox`, `queue:*:outbox`

### Changed

- `HumanRole` y `HumanProfile` ahora aceptan aliases genÃ©ricos (`user`, `agent`, `operator`, `supervisor`) ademÃ¡s del modelo retail legacy (`customer`, `staff`, `cashier`, `manager`), y soportan `org_id` junto con `store_id`
- `StaffAgent` amplÃ­a sus roles por defecto para cubrir aliases genÃ©ricos y puede ejecutar un comando inline en la misma frase de activaciÃ³n cuando la intervenciÃ³n sÃ­ parece una orden operativa
- DocumentaciÃ³n de governance, human roles y hardening alineada con el runtime actual, incluyendo `bus:AGENT_ERROR` y el comportamiento real de `HALF_OPEN`

### Fixed

- `CircuitBreaker` en `@fitalyagents/asynctools` ahora deja pasar un solo probe concurrente en `HALF_OPEN`
- `InMemoryBus.publish()` ya no bloquea el resto de handlers cuando uno falla, sigue esperando handlers async y vuelve a despachar handlers sync en el mismo tick
- `StreamAgent` deja de tragar errores silenciosamente y publica `bus:AGENT_ERROR` cuando `onEvent()` falla
- `DraftStore` vuelve a publicar de forma determinÃ­stica `bus:DRAFT_CANCELLED` en expiraciÃ³n TTL sobre `InMemoryBus`
- Flujos integrados con `StaffAgent` y `UIAgent` vuelven a reflejar correctamente `STAFF_COMMAND` en escenarios multi-agent

### Added

- New runnable framework examples under `examples/openai-agent`, `examples/langchain-agent`, and `examples/vercel-ai-sdk-agent`
- Integration docs refreshed to match the current `InteractionAgent` / `IStreamingLLM` runtime and point to those examples

#### Core — Safety Module (`packages/core/src/safety/`)

**SafetyGuard**

- Tool-level risk classification: `safe | staged | protected | restricted`
- `SafetyGuard.evaluate(action, params, speaker, context)` → `SafetyDecision`
- `roleHasPermission(role, action, params)` — verifica límites numéricos y porcentuales
- `findNearbyApprover(requiredRole, storeId)` — busca aprobador presente en tienda

**DraftStore**

- Drafts mutables con TTL automático (Redis/InMemory)
- Lifecycle completo: `create`, `update`, `confirm`, `cancel`, `rollback`
- Historial de cambios para rollback granular
- Cliente puede modificar N veces antes de confirmar sin crear órdenes fantasma

**Multi-Channel Approval (ApprovalOrchestrator)**

- `IApprovalChannel` interface: `notify(request, approver)` + `waitForResponse(request, timeoutMs)` + `cancel(requestId)`
- `VoiceApprovalChannel` — aprobación por voz; integra `VoiceIdentifierAgent`; escucha `bus:SPEECH_FINAL` con NLU yes/no
- `WebhookApprovalChannel` — HTTP webhook (migra `InMemoryApprovalQueue`); notifica vía `bus:APPROVAL_WEBHOOK_REQUEST`
- `ExternalToolChannel` — herramienta externa configurable vía HTTP/bus; recibe respuesta en `bus:APPROVAL_EXTERNAL_RESPONSE`
- `VisionApprovalChannel` — gestos vía `VisionDetectorAgent` (Sprint futuro)
- Estrategia `parallel`: todos los canales a la vez, primero en responder cancela los demás
- Estrategia `sequential`: intenta voz primero; si timeout → webhook/app
- Configuración por tool: `approval_channels: [{ type, timeout_ms }]`, `approval_strategy`

**Human Role Model**

- `HumanRole: 'customer' | 'staff' | 'cashier' | 'manager' | 'owner'`
- `HumanProfile` con `voice_embedding` (registrado por `VoiceIdentifierAgent`) y `approval_limits`
- `ApprovalLimits`: `payment_max`, `discount_max_pct`, `refund_max` por rol
- Roles en humanos (no en agentes IA) — define quién puede aprobar qué y con qué límites

**New Bus Events**

- `bus:APPROVAL_VOICE_REQUEST` — solicitud de aprobación por voz al empleado identificado
- `bus:APPROVAL_WEBHOOK_REQUEST` — notificación push para app móvil
- `bus:APPROVAL_EXTERNAL_REQUEST` / `bus:APPROVAL_EXTERNAL_RESPONSE` — canal externo configurable
- `bus:APPROVAL_RESOLVED` — resultado final de cualquier canal (incluye `channel_used: string`)
- `bus:SPEECH_PARTIAL` — audio parcial para speculative dispatch (desde FitalyVoice)
- `bus:AMBIENT_CONTEXT` — conversación no dirigida al agente (enriquece contexto)
- `bus:TARGET_DETECTED` / `bus:TARGET_QUEUED` / `bus:TARGET_GROUP` — multi-speaker state machine
- `bus:DRAFT_CREATED` / `bus:DRAFT_CONFIRMED` / `bus:DRAFT_CANCELLED` — lifecycle de drafts
- `bus:PROACTIVE_TRIGGER` — ProactiveAgent detecta situación de ayuda proactiva

#### Core — Session + Context v2

**TargetGroup**

- `TargetGroupStateMachine` — multi-speaker: TARGET (habla al agente), AMBIENT (conversación de fondo), QUEUED (espera)
- Priority queue para múltiples clientes simultáneos

**ContextStore ambient**

- `getAmbient(sessionId)` / `setAmbient(sessionId, data)` — contexto de conversación no dirigida

#### Core — Agentes Autónomos

**StreamAgent** (reemplaza NexusAgent)

- Subscribe to bus channels directamente, sin inbox/outbox
- Lifecycle: `start()`, `stop()`, `dispose()` con health monitoring

**ContextBuilderAgent**

- Consume `SPEECH_FINAL`, `AMBIENT_CONTEXT`, `ACTION_COMPLETED`, `DRAFT_*`
- Mantiene resumen de conversación y contexto enriquecido por sesión

**ProactiveAgent**

- Detecta: cliente esperando, producto agotado, oferta relevante
- Emite `bus:PROACTIVE_TRIGGER` → `InteractionAgent` decide cuándo hablar

#### Dispatcher — Speculative Engine (`packages/dispatcher/`)

**SpeculativeCache**

- Pre-ejecuta SAFE tools en `SPEECH_PARTIAL` antes de que el LLM los pida (ahorro ~250ms)
- STAGED: crea draft especulativo con TTL y referencia en cache
- PROTECTED/RESTRICTED: solo registra hint (no ejecuta nada)
- LRU con capacidad configurable (default 256 entries)

**IntentTeacher** (migrado desde `examples/agent-comparison/`)

- `instructionPrompt` inyectable por negocio — sin business logic hardcoded
- Evalúa correcciones del LLM: `add | skip | flag`
- Actualiza vector store en vivo via `addExample()`
- Redis backend para persistencia de correcciones

**IntentScoreStore** (migrado desde `examples/agent-comparison/`)

- EMA (α=0.1) por tool para tracking de accuracy
- Training mode (siempre especula) → Production mode (solo si score ≥ 0.70)
- Auto-suggest switch a production cuando hit rate ≥ 90%

#### Interaction Agent (`packages/core/src/agent/interaction-agent.ts`)

- LLM streaming con tool calling (Groq Llama 3.1 8B / Claude Haiku)
- Integra `SpeculativeCache` del dispatcher — tool results pre-computados en 0ms
- Tool call interception con `SafetyGuard`: SAFE ejecuta, STAGED presenta draft, PROTECTED pide confirmación, RESTRICTED lanza ApprovalOrchestrator
- Streaming response → `ttsCallback` para TTS inmediato

#### Documentation

- `docs/ARCHITECTURE-V2.md` — visión v2 con diagramas de capas
- `docs/SAFETY-MODEL.md` — safety levels, DraftStore lifecycle, flujos concretos
- `docs/APPROVAL-CHANNELS.md` — multi-canal configurable, estrategias, ejemplos por tool
- `docs/HUMAN-ROLES.md` — modelo de roles, límites, escalación automática
- `docs/FITALYSTORE-PRODUCT.md` — visión de producto retail, tiers, FitalyCloud, FitalyInsights
- `docs/DISPATCHER-SPECULATIVE.md` — cache especulativa, L1/L2/L3, Teacher + ScoreStore

### Removed

- `packages/core/src/routing/capability-router.ts` — LLM hace el routing
- `packages/core/src/routing/simple-router.ts`
- `packages/core/src/routing/types.ts`
- `packages/core/src/registry/agent-registry.ts` — reemplazado por `ToolRegistry`
- `packages/core/src/locks/lock-manager.ts` — simplificado a `DraftStore`
- `packages/core/src/tasks/task-queue.ts` — LLM maneja secuencia de tools
- `packages/core/src/agent/nexus-agent.ts` — reemplazado por `StreamAgent`

### Test Coverage (objetivo al cierre de Sprint 3.3)

| Package                 | Actual  | Objetivo             |
| ----------------------- | ------- | -------------------- |
| `packages/core`         | 212     | 300+                 |
| `packages/dispatcher`   | 40      | 90+                  |
| `examples/voice-retail` | 73      | 73 (sin regresiones) |
| **Total**               | **325** | **463+**             |

---

## [1.1.0] — 2026-02-24

### Added

#### License

- Changed from MIT to **Apache 2.0 + Commons Clause** — source-available, use freely to build products, cannot sell the SDK itself

#### Core (`fitalyagents`) — DX utilities

**SimpleRouter**

- `SimpleRouter` — subscribes to `bus:TASK_AVAILABLE` and routes to `queue:<agent-id>:inbox` via `bus.lpush`
- `routes: Record<string, string>` — maps `intent_id` → `agent_id`
- `alwaysNotify?: string[]` — agents that always receive a copy (e.g. InteractionAgent for filler audio)
- Replaces the manually-written `createSimpleRouter()` pattern that was re-implemented across every E2E test

**AgentBundle**

- `AgentBundle` — lifecycle manager for a group of `NexusAgent` instances and disposable resources
- `start()` — starts all agents in registration order
- `shutdown()` — shuts down all agents in reverse order
- `dispose()` — calls `dispose()` on all registered disposables (audio queues, context stores, etc.)

#### Dispatcher (`fitalyagents/dispatcher`) — LLM enhancements

**LLMProvider interface**

- `LLMProvider` — minimal `complete(system, user): Promise<string>` interface; wraps any LLM backend

**ClaudeLLMProvider**

- `ClaudeLLMProvider` — wraps `@anthropic-ai/sdk`; reads `ANTHROPIC_API_KEY` from env
- Defaults to `claude-haiku-4-5-20251001` (fast + cheap for classification tasks)
- Optional: configure `apiKey`, `model`, `maxTokens`

**DispatcherBootstrapper**

- `DispatcherBootstrapper` — generates intent training examples from agent manifests using an LLM
- `bootstrapFromManifests(manifests)` — reads capabilities/scope/domain, calls LLM, populates intent library
- `bootstrapFromRegistry(registry)` — reads all registered agent manifests from `AgentRegistry`
- Idempotent: enriches existing intents rather than overwriting them
- Capability naming: `PRODUCT_SEARCH` → intent `product_search` (automatic `UPPER_CASE` → `snake_case`)
- Publishes `bus:INTENT_UPDATED` after each intent for hot-reload

**LLMDirectClassifier**

- `LLMDirectClassifier` — drop-in `IEmbeddingClassifier` replacement that classifies via LLM
- `init()` — loads intent metadata (no embeddings computed)
- `classify(text)` — sends intent list + utterance to LLM, returns `ClassifyResult`
- `reloadIntent(intentId)` — hot-reloads a single intent's metadata
- Parses markdown-fenced JSON from LLM responses transparently

### Changed

- `DispatcherBootstrapper.bootstrapFromManifests()` now published to `bus:INTENT_UPDATED` for each intent if `bus` is provided
- Updated `docs/guides/training-the-dispatcher.md` with new Auto-Bootstrap and LLMDirectClassifier sections

### Test Coverage

| Package                 | Tests                                           |
| ----------------------- | ----------------------------------------------- |
| `packages/core`         | **212** (+19 SimpleRouter + AgentBundle)        |
| `packages/dispatcher`   | **40** (+24 Bootstrapper + LLMDirectClassifier) |
| `examples/voice-retail` | **73** (no regressions)                         |
| **Total**               | **325**                                         |

---

## [1.0.0] — 2026-02-24

### Added

#### Core (`fitalyagents`)

**Bus**

- `InMemoryBus` — in-memory event bus with pub/sub and Redis-style queue simulation (`lpush`/`brpop`)
- `RedisBus` / `createBus(options)` — Redis-backed event bus for production use

**NexusAgent**

- `NexusAgent` base class — all agents extend this; handles inbox listening via `brpop`, start/shutdown lifecycle

**AgentRegistry**

- `AgentRegistry` — registers and queries agent manifests; supports filtering by scope, capability, domain

**ContextStore**

- `InMemoryContextStore` — session-scoped key/value store with access control
- `enforceAccess()` / `AccessDeniedError` — enforces `ContextAccess` rules

**LockManager**

- `InMemoryLockManager` — distributed-style lock management with TTL and expiry callbacks

**SessionManager**

- `InMemorySessionManager` — full session lifecycle: create, get, assign group, set priority group, pause, resume, terminate
- `PriorityGroup` type: `0` (social), `1` (individual, default), `2` (employee/system)
- Employee Interrupt Protocol: `pauseSession(sessionId, pausedBy?)` / `resumeSession(sessionId)`
- `listActiveSessions()` — only `status: 'active'` sessions
- `listByPriorityGroup(pg)` — non-terminated sessions by priority group
- `onTerminated(callback)` — register cleanup hooks fired on `terminateSession()`

**TaskQueue**

- `InMemoryTaskQueue` — publish, claim, start, complete, fail, cancel tasks; priority ordering; lock integration

**CapabilityRouter**

- `CapabilityRouter` — routes tasks to the correct agent based on capabilities; integrates with TaskQueue and LockManager

**AudioQueueService**

- `InMemoryAudioQueueService` — priority-based audio segment queue with barge-in support
- `bus:BARGE_IN` event interrupts active audio for a session
- `start()` returns `Unsubscribe` for clean teardown

**ApprovalQueue** _(new in 1.0.0)_

- `InMemoryApprovalQueue` — human-in-the-loop approval queue for orders and refunds
- `start()` subscribes to `bus:ORDER_PENDING_APPROVAL`
- `approve(draftId, approverId)` → publishes `bus:ORDER_APPROVED` + `bus:ACTION_COMPLETED`
- `reject(draftId, reason)` → publishes `bus:ORDER_APPROVAL_REJECTED` + `bus:ACTION_COMPLETED`
- Auto-timeout with configurable `approval_timeout_ms` → publishes `bus:ORDER_APPROVAL_TIMEOUT` + `bus:ACTION_COMPLETED`
- `ApprovalNotFoundError` / `ApprovalAlreadyResolvedError` error types

**Types & Schemas**

- Full Zod schemas for all event types: `TaskPayloadEvent`, `TaskResultEvent`, `ActionCompletedEvent`, `HeartbeatEvent`, etc.
- `AgentManifest`, `Domain`, `AgentRole`, `ContextMode`, `ContextAccess` schemas and types
- `TaskStatus`: `'completed' | 'failed' | 'waiting_approval' | 'cancelled'`

#### AsyncTools (`@fitalyagents/asynctools`)

- `ToolRegistry` — register, get, list, unregister tools with Zod validation
- `ToolRegistry.fromFile(path)` / `ToolRegistry.fromObject(config)` — load from JSON
- `DuplicateToolError` / `ToolNotFoundError` / `ToolValidationError`
- `ExecutorPool` — parallel tool execution with injection strategies
- Execution modes: `sync`, `async`, `fire_forget`, `deferred`
- Injection strategies: `inject_when_all`, `inject_when_ready`, `inject_on_timeout`
- `PendingStateTracker` — tracks in-flight tool calls per session
- `AsyncAgent` wrapper — adds async tool execution to any agent

#### Voice Retail Example (`examples/voice-retail`)

- `InteractionAgent` — voice interaction agent (TEN Framework via mockeable `ITENClient`)
- `WorkAgent` — tool execution agent (LangChain.js via mockeable `IToolExecutor`)
- `OrderAgent` — order lifecycle management with human approval support
- `createApprovalWebhookHandler` — Express/Hono-compatible webhook for approval decisions
- E2E test suite: pipeline, order approval, multi-session isolation, order lifecycle, cancel chain
- **73 tests**, all passing

#### Documentation

- `docs/guides/getting-started.md` — 10-minute quickstart
- `docs/guides/asynctools-standalone.md` — Layer 2 with LangGraph
- `docs/guides/add-new-agent.md` — step-by-step agent creation
- `docs/guides/training-the-dispatcher.md` — intent classification and training
- `docs/guides/rust-dispatcher.md` — Phase 5 Rust dispatcher overview

### Compatibility

| Component  | Minimum | Recommended |
| ---------- | ------- | ----------- |
| Node.js    | 18.x    | 20.x LTS    |
| Redis      | 6.x     | 7.x         |
| TypeScript | 5.0     | 5.5+        |
| pnpm       | 8.x     | 9.x         |

### Test Coverage

| Package                 | Tests                       |
| ----------------------- | --------------------------- |
| `packages/core`         | 193 tests                   |
| `packages/asynctools`   | (included in core test run) |
| `examples/voice-retail` | 73 tests                    |
| **Total**               | **266 tests**               |

---

## [0.0.1] — Initial development

Internal development builds — not published.

- Sprint 0.x: Monorepo scaffolding, ToolRegistry, ExecutorPool, AsyncAgent
- Sprint 1.x: InMemoryBus, NexusAgent, AgentRegistry, ContextStore, LockManager
- Sprint 2.x: TaskQueue, CapabilityRouter, AudioQueueService, voice-retail E2E
- Sprint 3.x: OrderAgent, ApprovalQueue, webhook handler, order-approval E2E
- Sprint 4.x: Multi-session E2E, SessionManager priority groups, employee interrupt protocol
