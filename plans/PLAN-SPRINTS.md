# FitalyAgents — Sprints & Checklists
> Checklist granular de cada sprint. Ver `PLAN.md` para visión general, `PLAN-ARCHITECTURE.md` para schemas.

---

## Estado de leyenda
- ⬜ Pendiente
- 🔄 En progreso
- ✅ Completado
- 🚫 Bloqueado

---

## FASE 0 — Fundación & `fitalyagents/asynctools`
**Objetivo:** Librería de async tools publicable, standalone, sin dependencias de Layer 1.  
**Semanas:** 1–3

---

### Sprint 0.1 — Monorepo & Scaffolding
**Semanas 1, días 1–3**

#### Setup del repositorio
- [x] `git init fitalyagents` + `.gitignore` (node_modules, dist, .env, *.rs build artifacts)
- [x] `pnpm-workspace.yaml` con packages: `['packages/*']`
- [x] `turbo.json` con pipelines: build, test, lint, type-check
- [x] `tsconfig.base.json` con: `strict: true`, `moduleResolution: bundler`, `target: ES2022`
- [x] `.nvmrc` con Node 20+

#### Paquete `fitalyagents/asynctools`
- [x] `packages/asynctools/package.json`:
  - `name: "@fitalyagents/asynctools"`
  - `exports`: ESM + CJS + types
  - `types`, `main`, `module` correctos
- [x] `packages/asynctools/tsconfig.json` extendiendo base
- [x] Estructura de directorios: `src/{registry,executor,injection,wrapper,tracking,types}`

#### Paquete `fitalyagents` (core + dispatcher)
- [x] `packages/core/package.json`
- [x] `packages/dispatcher/package.json` con exports: `"./dispatcher"`

#### Tooling
- [x] `vitest.config.ts` en root + por paquete
- [x] `eslint.config.js` (flat config) con `@typescript-eslint/recommended`
- [x] `prettier.config.js`
- [x] `husky` + `lint-staged` + `commitlint` (`feat:`, `fix:`, `chore:`)
- [x] `tsup.config.ts` en todos los paquetes: ESM + CJS + tipos

#### CI
- [x] `.github/workflows/ci.yml`:
  - `pnpm install --frozen-lockfile`
  - `turbo lint`
  - `turbo type-check`
  - `turbo test`
  - `turbo build`
- [x] Badge de CI en README

#### Tipos base
- [x] `packages/asynctools/src/types/index.ts` — exportar todos los tipos públicos:
  ```typescript
  type ExecutionMode = 'sync' | 'async' | 'fire_forget' | 'deferred'
  type InjectionStrategy = 'inject_when_all' | 'inject_when_ready' | 'inject_on_timeout'
  type ToolStatus = 'pending' | 'running' | 'completed' | 'failed' | 'timed_out'
  type ExecutorType = 'http' | 'ts_fn' | 'subprocess'
  interface ToolDefinition { ... }
  interface ToolResult { ... }
  interface PendingToolCall { ... }
  interface TurnState { ... }
  ```
- [x] `ToolDefinitionSchema` con Zod (tool_id, executor, mode, timeout, retry, schemas)
- [x] Tests de tipos: 15 tests con vitest validando todos los Zod schemas

**Entregable:** Monorepo funcionando, CI verde en vacío. ✅

---

### Sprint 0.2 — ToolRegistry
**Semana 1, días 4–5**

- [x] Clase `ToolRegistry`:
  - [x] `register(tool: ToolDefinition): void` — valida con Zod, lanza si inválido
  - [x] `registerMany(tools: ToolDefinition[]): void` — transaccional (all-or-nothing)
  - [x] `static fromFile(path: string): Promise<ToolRegistry>`
  - [x] `static fromObject(config: unknown): ToolRegistry`
  - [x] `get(toolId: string): ToolDefinition | undefined`
  - [x] `getOrThrow(toolId: string): ToolDefinition`
  - [x] `list(): ToolDefinition[]`
  - [x] `has(toolId: string): boolean`
  - [x] `unregister(toolId: string): void`
- [x] Error types: `ToolNotFoundError`, `ToolValidationError`, `DuplicateToolError`
- [x] Tests (35 tests):
  - [x] registro exitoso de tool válida
  - [x] falla con Zod error en tool inválida
  - [x] `fromFile` con JSON de ejemplo
  - [x] `fromObject` con objeto mal formado
  - [x] duplicado lanza `DuplicateToolError`
  - [x] `getOrThrow` lanza `ToolNotFoundError`
- [x] JSDoc en todos los métodos públicos

**Entregable:** `ToolRegistry` funcional y testeado ✅

---

### Sprint 0.3 — ExecutorPool
**Semana 2, días 1–3**

#### Interface y tipos
- [x] `interface IExecutor { execute(toolId, input, signal?: AbortSignal): Promise<unknown> }`
- [x] `class ExecutorPool { execute(toolId, toolCallId, input): Promise<ToolResult> }`

#### HttpExecutor
- [x] `method: 'GET' | 'POST' | 'PUT'` configurable por tool
- [x] `fetch()` nativo (Node 18+), sin deps externas
- [x] Serialización JSON automática
- [x] Headers customizables en `ToolDefinition.executor.headers`
- [x] `AbortController` para timeout
- [x] Errores tipados: `HttpExecutorError { status, body }`

#### FunctionExecutor
- [x] Acepta `(input: unknown) => unknown | Promise<unknown>`
- [x] Wrapping automático de funciones síncronas en Promise
- [x] Handler registry con `registerFunctionHandler()`

#### SubprocessExecutor
- [x] `command: string`, `args: string[]` en `ToolDefinition.executor`
- [x] stdin/stdout como JSON
- [x] `child_process.spawn` con timeout via `AbortController`

#### ExecutorPool
- [x] `new ExecutorPool(registry: ToolRegistry)`
- [x] `execute(toolId, input): Promise<ToolResult>`
- [x] Concurrencia máxima por tool (`max_concurrent` en ToolDefinition)
- [x] Cola interna: `Map<toolId, QueuedTask[]>` (una queue por tool)
- [x] Retry con backoff exponencial: `max_attempts`, `backoff_ms`
- [x] Timeout via `AbortController` + `Promise.race`
- [x] Métricas básicas: `getStats(toolId)` → `{ executing, queued, completed, failed }`

#### Tests (11 tests)
- [x] HTTP: servidor real local (no mocks)
  - [x] POST exitoso
  - [x] HTTP 500 → falla
  - [x] Timeout
- [x] Function executor: sync y async
- [x] Concurrencia: 5 tools con max_concurrent=2, verificar que no superan 2 a la vez
- [x] Retry: tool falla 2 veces, tiene max_attempts=3, 3ra vez ok

**Entregable:** `ExecutorPool` completo con 3 executors ✅

---

### Sprint 0.4 — PendingStateTracker
**Semana 2, días 4–5**

- [x] Interface `IPendingStateTracker`
- [x] Clase `InMemoryPendingStateTracker`:
  - [x] `createTurn(turnId, agentId, strategy, globalTimeoutMs): TurnState`
  - [x] `addPending(turnId, toolCallId, toolId): void`
  - [x] `markRunning(turnId, toolCallId): void`
  - [x] `markCompleted(turnId, toolCallId, result): void`
  - [x] `markFailed(turnId, toolCallId, error): void`
  - [x] `markTimedOut(turnId, toolCallId): void`
  - [x] `isResolved(turnId): boolean` — lógica diferente por strategy
  - [x] `getResults(turnId): ToolResult[]` — solo los completados
  - [x] `getPending(turnId): string[]` — toolCallIds aún pendientes
  - [x] `getTimedOut(turnId): string[]`
  - [x] `deleteTurn(turnId): void`
- [x] Lógica de `isResolved`:
  - [x] `inject_when_all` → true cuando TODOS los tool_calls son completed/failed/timed_out
  - [x] `inject_when_ready` → true cuando CUALQUIERA completa
  - [x] `inject_on_timeout` → true cuando global timeout expira
- [x] Limpieza automática de turns huérfanos (TTL configurable, default 60s)
- [ ] Clase `RedisPendingStateTracker` (mismo interface, backend Redis) — planificado para Layer 1
- [x] Tests (24 tests):
  - [x] `inject_when_all` — 3 tools, se resuelve al completar el último
  - [x] `inject_when_ready` — se resuelve al completar el primero
  - [x] `inject_on_timeout` — global timeout expira antes que los tools
  - [x] Limpieza de turns huérfanos

**Entregable:** `PendingStateTracker` con ambos backends ✅

---

### Sprint 0.5 — InjectionManager & AsyncAgent
**Semana 3, días 1–4**

#### InjectionManager
- [x] `new InjectionManager(tracker: IPendingStateTracker)`
- [x] `watchTurn(turnId, onReady: (results: ToolResult[]) => void): void`
  - Poll-based con intervalo configurable
- [x] `waitForResolution(turnId): Promise<ToolResult[]>` — Promise API
- [x] `formatForReinjection(results: ToolResult[]): Message[]`
  - Formatea como tool_result messages para el LLM
- [x] `cancelTurn(turnId): void` — cancela todos los pendientes
- [x] `dispose(): void` — limpia todos los watchers

#### AsyncAgent wrapper
- [x] `new AsyncAgent({ inner, toolRegistry, executorPool, tracker, injectionStrategy, globalTimeoutMs, maxTurns })`
  - `inner`: cualquier objeto con `run(messages)` — NO acoplado a un SDK
  - Interface genérica: `IInnerAgent { run(messages: Message[]): Promise<AgentResponse> }`
- [x] `run(userMessage: string | Message[]): Promise<AgentResponse>`
  - [x] Llamar `inner.run()` para primera vuelta
  - [x] Detectar `tool_calls` en la respuesta
  - [x] Por cada tool_call, verificar su `execution_mode` en ToolRegistry
  - [x] `sync` → ejecutar en ExecutorPool y bloquear
  - [x] `async` → lanzar worker, registrar en PendingStateTracker como pending
  - [x] `fire_forget` → lanzar sin registrar, sin inyección
  - [x] `deferred` → async pero marcar como esperar fin de turno
  - [x] Cuando `isResolved(turnId) === true` → construir messages con resultados → nueva vuelta `inner.run()`
  - [x] Repetir hasta no haber tool_calls pendientes
- [x] Manejo de errores: tool falla → resultado con `status: 'failed'`, continúa
- [x] `globalTimeoutMs` → AbortController para la vuelta completa
- [x] `maxTurns` → previene recursión infinita (default 10)
- [x] Factory method: `AsyncAgent.fromFunction(fn, options)`
- [ ] Adaptadores incluidos para:
  - [ ] OpenAI SDK (`AsyncAgent.fromOpenAI(client)`) — planificado
  - [ ] Anthropic SDK (`AsyncAgent.fromAnthropic(client)`) — planificado

#### Tests E2E (mock LLM) — 6 tests
- [x] LLM mock que retorna 2 tool_calls en paralelo → ambas async → inject_when_all → respuesta final
- [x] fire_forget → tool se ejecuta pero resultado NO inyectado
- [x] sync tool → bloquea, resultado inyectado inmediatamente
- [x] Tool failure → continúa gracefully
- [x] Agente con 3 tools: 1 sync, 1 async, 1 fire_forget → comportamiento correcto de cada uno
- [x] No tool calls → retorna respuesta directa

**Entregable:** `AsyncAgent` wrapper funcionando ✅

---

### Sprint 0.6 — Publicación Layer 2
**Semana 3, día 5**

- [x] `package.json` de `@fitalyagents/asynctools` con exports correctos (`types` primero)
- [x] `tsup.config.ts` genera ESM + CJS + `.d.ts` sin errores
- [ ] `typedoc` genera docs desde JSDoc — opcional (no instalado en este sprint)
- [x] `README.md` del paquete con:
  - [x] Instalación
  - [x] Quickstart: 5 líneas para wrappear cualquier agente
  - [x] Tabla de execution modes
  - [x] Tabla de injection strategies
  - [x] Ejemplo con HttpExecutor
  - [x] Ejemplo con FunctionExecutor
- [x] `examples/asynctools-only/` con ejemplo funcional (`run.ts` + `package.json` + `README.md`)
- [ ] `npm publish --dry-run` — pendiente (requiere npm account configurado)
- [ ] Tag `v0.1.0-asynctools` en git — pendiente

**Entregable:** `fitalyagents/asynctools` publicable ✅

---

## FASE 1 — Layer 1: Agent Middleware Bus Core
**Objetivo:** Bus minimal operacional. NexusAgent base class. Dispatcher Node funcionando.  
**Semanas:** 4–7

---

### Sprint 1.1 — NexusAgent Base Class + Bus Abstraction
**Semana 4, días 1–3**

#### IEventBus abstraction
- [ ] `interface IEventBus`:
  - [ ] `publish(channel: string, payload: unknown): Promise<void>`
  - [ ] `subscribe(channel: string, handler: (data: unknown) => void): () => void` (retorna unsubscribe)
  - [ ] `psubscribe(pattern: string, handler: (channel: string, data: unknown) => void): () => void`
  - [ ] `disconnect(): Promise<void>`
- [ ] `RedisBus` implementando `IEventBus` con ioredis
  - [ ] Conexión con reconexión automática
  - [ ] Conexiones separadas para pub y sub (requerimiento ioredis)
  - [ ] Validación Zod al recibir (configurable, default: true)
- [ ] Exportar `createBus(options: BusOptions): IEventBus`

#### AgentManifest schema completo
- [ ] `AgentManifestSchema` con Zod (todos los campos de `PLAN-ARCHITECTURE.md`)
- [ ] Tipos derivados: `AgentManifest`, `ContextAccess`, `ApprovalConfig`

#### NexusAgent base class
- [ ] Clase `NexusAgent` (ver `PLAN-ARCHITECTURE.md` para implementación de referencia)
- [ ] `start(): Promise<void>` — publica manifiesto, inicia heartbeat, escucha inbox
- [ ] `shutdown(): Promise<void>` — publica AGENT_DEREGISTERED, cierra conexiones
- [ ] `abstract process(task: TaskPayload): Promise<TaskResult>`
- [ ] `listenInbox()` con `BRPOP` (no pub/sub — BRPOP es más eficiente para queues)
- [ ] Error handling en `process()` → publica `TASK_RESULT status: failed`
- [ ] Graceful shutdown con `SIGTERM`
- [ ] Typing genérico: `NexusAgent<TSlots, TResult>`

#### Tests
- [ ] Mock bus → verificar que `start()` publica `AGENT_REGISTERED`
- [ ] Mock inbox → verificar que `process()` es llamado y resultado publicado
- [ ] Subclass de prueba que implementa `process()`
- [ ] Error en `process()` → verifica que se publica `status: failed`

---

### Sprint 1.2 — AgentRegistry
**Semana 4, días 4–5**

- [x] Clase `AgentRegistry`:
  - [x] `register(manifest: AgentManifest): void`
  - [x] `unregister(agentId: string): void`
  - [x] `get(agentId: string): Promise<AgentManifest | null>`
  - [x] `list(filters?: RegistryFilters): Promise<AgentManifest[]>`
    - [x] `filters: { domain?, scope?, capabilities?, role? }`
  - [x] `updateHeartbeat(agentId: string, status: HeartbeatStatus): void`
  - [x] `getHeartbeat(agentId: string): HeartbeatRecord | null`
  - [x] `getStale(thresholdMs: number): Promise<AgentManifest[]>` — agentes sin heartbeat
  - [x] `getCurrentLoad(agentId: string): Promise<number>`
  - [x] `incrementLoad(agentId: string): Promise<void>`
  - [x] `decrementLoad(agentId: string): Promise<void>` — floor at 0
  - [x] `has(agentId): boolean`, `size: number`
- [x] Suscripción automática a `bus:AGENT_REGISTERED`, `bus:AGENT_DEREGISTERED`, `bus:HEARTBEAT`
- [x] `listen(): Unsubscribe` + `dispose()`
- [x] In-memory mirror para operaciones de lectura rápida
- [x] Tests (22 tests):
  - [x] Registro y lookup manual
  - [x] Bus event sync: REGISTERED → auto-register, DEREGISTERED → auto-remove, HEARTBEAT → record
  - [x] Filtros: por domain, scope, capabilities (todos presentes), role, combinados
  - [x] `getStale`: never seen, expired, fresh, mixto
  - [x] Load tracking: start=0, increment, decrement, floor=0, clear on unregister

---

### Sprint 1.3 — ContextStore
**Semana 5, días 1–2**

- [x] Clase `ContextStore`:
  - [x] `get<T>(sessionId, field): Promise<T | null>`
  - [x] `set(sessionId, field, value): Promise<void>`
  - [x] `patch(sessionId, updates: Record<string, unknown>): Promise<void>` — JSON merge atómico
  - [x] `getMany(sessionId, fields: string[]): Promise<Partial<SessionContext>>`
  - [x] `getSnapshot(sessionId, allowedFields: string[]): Promise<Record<string, unknown>>`
    - Aplica filtro de `context_access.read` del agente
    - Maneja `"*"` como "todos los campos"
    - Excluye `forbidden` aunque estén en `read`
  - [x] `delete(sessionId, field?): Promise<void>` — campo específico o sesión entera
  - [x] `exists(sessionId): Promise<boolean>`
  - [x] `setTTL(sessionId, ttlSeconds: number): Promise<void>`
- [x] Namespace: `context:{session_id}` (InMemory / RedisJSON-ready)
- [x] `enforceAccess(agentManifest, patch: Record<string, unknown>): void`
  - Lanza `AccessDeniedError` si patch contiene campos `forbidden`
- [x] Tests:
  - [x] Aislamiento: patch de sess_ana no afecta sess_pedro
  - [x] `getSnapshot` respeta `read` y excluye `forbidden`
  - [x] `patch` atómico: múltiples campos en una operación
  - [x] `enforceAccess` lanza en campo forbidden

---

### Sprint 1.4 — LockManager & SessionManager
**Semana 5, días 3–4**

#### LockManager
- [x] `acquire(taskId, agentId, ttlMs): Promise<boolean>` — Redis SET NX PX
- [x] `release(taskId, agentId): Promise<void>` — solo si el agente es el dueño
- [x] `releaseAll(agentId): Promise<void>` — en caso de crash/timeout del agente
- [x] `get(taskId): Promise<LockValue | null>`
- [x] `isLocked(taskId): Promise<boolean>`
- [x] Watchdog: `startWatchdog(intervalMs: 1000)` — scannea locks expirados, los libera y re-encola tareas

#### SessionManager
- [x] `createSession(sessionId, metadata?): Promise<Session>`
- [x] `getSession(sessionId): Promise<Session | null>`
- [x] `assignGroup(sessionId, group): Promise<void>`
- [x] `terminateSession(sessionId): Promise<void>` — limpia context, locks, tasks pendientes
- [x] `listActiveSessions(): Promise<string[]>`

#### Tests
- [x] Lock adquirido por agent_A → agent_B no puede adquirirlo
- [x] Lock expira por TTL → task re-encolada
- [x] `releaseAll(agentId)` libera todos los locks de ese agente
- [x] Sesiones completamente aisladas

---

### Sprint 1.5 — TaskQueue + Lifecycle
**Semana 5, día 5 — Semana 6, día 1**

- [x] Clase `TaskQueue`:
  - [x] `publish(input: TaskInput): Promise<Task>` → TASK_AVAILABLE (publica a bus)
  - [x] `claim(agentId, taskId): Promise<Task | null>` → TASK_LOCKED (con lock)
  - [x] `start(taskId): Promise<void>` → TASK_RUNNING
  - [x] `complete(taskId, result): Promise<void>` → TASK_COMPLETED + unlock dependents
  - [x] `fail(taskId, error): Promise<void>` → TASK_FAILED + release lock
  - [x] `cancel(taskId, cancelToken): Promise<boolean>` → TASK_CANCELLED (solo pre-RUNNING)
  - [x] `timeout(taskId): Promise<void>` → TASK_TIMED_OUT + release lock + requeue
  - [x] `waitHumanApproval(taskId): Promise<void>` → TASK_WAITING_HUMAN
  - [x] `publishDependents(completedTaskId): Promise<void>` — desbloquear tasks depends_on
  - [x] `getStatus(taskId): Promise<TaskStatus>`
- [x] Priority-based ordering (score = priority)
- [x] Timeout watchdog integrado con LockManager
- [x] Tests:
  - [x] Full lifecycle: available → locked → running → completed
  - [x] Cancel antes de running: ok. Cancel después: false
  - [x] Task chaining: Task B solo inicia cuando Task A completa
  - [x] Timeout: task timed_out, re-encolada, tomada por otro agente

---

### Sprint 1.6 — CapabilityRouter
**Semana 6, días 2–3**

- [x] Clase `CapabilityRouter`:
  - [x] `route(task: TaskAvailableEvent): Promise<string | null>` — retorna agentId o null
  - [x] Algoritmo 7 pasos (ver `PLAN.md`):
    1. filter domain
    2. filter scope (optional)
    3. filter capabilities ⊇ required
    4. filter accepts_from
    5. filter current_load < max_concurrent
    6. sort priority DESC, load ASC
    7. top candidate
  - [x] Si null → task permanece AVAILABLE para reintento
  - [x] Si agente acepta → `lockManager.acquire()` → `taskQueue.start()` → publicar TaskPayload
- [x] `buildContextSnapshot(task, agentManifest): Promise<Record<string, unknown>>`
  - Lee ContextStore, aplica filtro de `context_access.read` del agente
- [x] Suscripción a `bus:TASK_AVAILABLE` al `start()`
- [x] Tests:
  - [x] 3 agentes candidatos → elige el de mayor prioridad con menor carga
  - [x] Ningún candidato → task permanece AVAILABLE
  - [x] Race condition: 2 routers intentan tomar la misma task → solo uno gana (SET NX)
  - [x] Snapshot correcto: agente stateless no recibe conversation_history

---

### Sprint 1.7 — Dispatcher completo (Node)
**Semana 6, día 4 — Semana 7**

> Ver `PLAN-DISPATCHER.md` para detalles de implementación.

- [x] Clase `NodeDispatcher`:
  - [x] `start()` — inicia todos los workers concurrentemente
  - [x] Worker `speechListener` — SUBSCRIBE bus:SPEECH_FINAL
  - [x] Worker `fallbackPublisher` — publica a bus:DISPATCH_FALLBACK
  - [x] Worker `intentReloader` — SUBSCRIBE bus:INTENT_UPDATED → llama `classifier.reloadIntent()`
  - [x] Worker `lockWatchdog` — interval configurable (callback-based)
- [x] Clase `EmbeddingClassifier` (InMemory: Jaccard similarity; interface ready for `@xenova/transformers`):
  - [x] `init()` — carga intents desde IntentLibrary
  - [x] `classify(text): Promise<ClassifyResult>`
  - [x] `reloadIntent(intentId)` — recarga desde IntentLibrary
  - [x] `IEmbeddingClassifier` interface para swap Node/Rust
- [x] Clase `LLMFallbackAgent` (InMemory: pluggable resolver; interface ready for Anthropic):
  - [x] SUBSCRIBE bus:DISPATCH_FALLBACK
  - [x] Resolución via FallbackResolver function (mock LLM)
  - [x] PUBLISH bus:TASK_AVAILABLE + bus:INTENT_UPDATED
  - [x] Persistir nuevo ejemplo en IntentLibrary
- [x] Clase `IntentLibrary` (InMemory):
  - [x] `createIntent(def: IntentDefinition): Promise<void>` — bootstrap
  - [x] `addExample(intentId, example): Promise<void>`
  - [x] `getExamples(intentId): Promise<string[]>`
  - [x] `hasIntentForCapability(capability): Promise<boolean>`
  - [x] `IIntentLibrary` interface para swap Redis
- [x] `fitalyagents/dispatcher` export:
  ```typescript
  export { NodeDispatcher, InMemoryLLMFallbackAgent, InMemoryIntentLibrary, InMemoryEmbeddingClassifier }
  ```
- [x] Tests (19 tests):
  - [x] Clasificación confident → TASK_AVAILABLE publicada correctamente
  - [x] Clasificación fallback → DISPATCH_FALLBACK publicado
  - [x] LLMFallbackAgent: mock resolver → verifica TASK_AVAILABLE + INTENT_UPDATED
  - [x] Reload: addExample → reloadIntent → próxima clasificación más confident
  - [x] Watchdog tick a intervalo configurado

**Entregable:** Layer 1 + NodeDispatcher operacional ✅

---

## FASE 2 — Agentes Concretos: Interaction + Work
**Semanas:** 8–10

### Estrategia Multi-SDK (Fase 2)

> **Objetivo**: Validar que la arquitectura FitalyAgents es genuinamente SDK-agnóstica
> implementando cada agente con un framework diferente.

| Componente | SDK/Framework | Justificación |
|---|---|---|
| **AudioQueueService** | Puro TypeScript (core) | Es un servicio, no un agente LLM. No necesita SDK externo |
| **InteractionAgent** | **TEN Framework** ([theten.ai](https://theten.ai)) | Multimodal real-time, 50-150ms latency. Audio, gestures, quick responses |
| **WorkAgent** | **LangChain.js** | Tool orchestration paralela. `StructuredTool`, Zod schemas, `AgentExecutor` |

**Integración TEN Framework** (InteractionAgent):
- Approach: Opción C — NexusAgent puro TS con `TENClient` inyectable
- El agente extiende `NexusAgent` y usa un `ITENClient` interface
- En tests: mock del client. En producción: conecta a servicio TEN desplegado
- TEN maneja: STT streaming, TTS ultra-rápido, VAD, turn detection
- FitalyAgents maneja: bus lifecycle, context, locks, task queue

**Integración LangChain.js** (WorkAgent):
- El agente extiende `NexusAgent` pero internamente usa `AgentExecutor` de LangChain
- Tools registradas como `StructuredTool` de LangChain con schemas Zod
- `inject_when_all` de asynctools para paralelismo (`product_search` + `price_check`)
- LLM: Claude Haiku via `@langchain/anthropic`

---

### Sprint 2.1 — AudioQueueService
**Semana 8, días 1–2**

- [x] Clase `AudioQueueService` (no es un agente — es un servicio):
  - [x] Backend: InMemory con Map por session_id (interface `IAudioQueueService` preparada para Redis)
  - [x] `push(sessionId, segment: AudioSegment): Promise<{ position, segmentId }>` — priority-based insertion
  - [x] `interrupt(sessionId): Promise<void>` — pausa playback inmediato
  - [x] `continue(sessionId): Promise<void>` — resume
  - [x] `clear(sessionId): Promise<void>` — limpiar cola completa
  - [x] `modify(sessionId, segmentId, newSegment): Promise<boolean>` — reemplazar filler con respuesta real
  - [x] Worker de reproducción: async loop, procesa segmentos en orden via `onSegmentReady` callback
  - [x] Auto-interrupt al recibir `bus:BARGE_IN`
- [x] Tipo `AudioSegment { text, ttsReadyUrl?, priority, segmentId }`
- [x] Bus events: AUDIO_SEGMENT_QUEUED, AUDIO_SEGMENT_PLAYING, AUDIO_SEGMENT_DONE, AUDIO_INTERRUPTED, AUDIO_RESUMED, AUDIO_CLEARED, AUDIO_SEGMENT_MODIFIED
- [x] Tests (17 tests): push & FIFO, priority, interrupt/continue, clear, modify, BARGE_IN, bus events, session isolation

---

### Sprint 2.2 — Agent 1: InteractionAgent
**Semana 8, día 3 — Semana 9, día 2**

- [x] Clase `InteractionAgent` extends `NexusAgent`:
  - [x] Manifiesto completo: domain: customer_facing, scope: interaction
  - [x] Capacidades: QUICK_RESPONSE, AUDIO_QUEUE, DISPLAY_ORDER, GESTURE
  - [x] `context_mode: 'stateful'` — lee conversación completa
  - [x] SDK: TEN Framework via `ITENClient` interface inyectable
  - [x] `process(task): Promise<TaskResult>` — quick response + gesture + filler audio

- [x] Integraciones implementadas:
  - [x] `ITENClient` interface: `generateQuickResponse`, `displayGesture`, `displayOrder`
  - [x] `MockTENClient` para testing (configurable, records calls)
  - [x] `IAudioQueueService` para gestión de audio (push filler, interrupt, continue)
  - [x] Parallel execution: `generateQuickResponse()` + `displayGesture('thinking')` simultáneos

- [x] Lógica principal:
  - [x] Recibe TASK_PAYLOAD → quick_response + thinking gesture [PARALLEL]
  - [x] Push filler audio con segmentId para tracking
  - [x] Al recibir ACTION_COMPLETED → interrupt filler + push respuesta real + happy gesture
  - [x] Gestión de gestures: neutral, listening, thinking, happy, apologetic, confirming, surprised, waiting
  - [x] `formatResult()` extensible para customizar respuestas por intent

- [x] Suscripción adicional a `bus:ACTION_COMPLETED`
- [x] Tests (9 tests): manifest, process, ACTION_COMPLETED, formatResult variants, lifecycle

---

### Sprint 2.3 — Agent 2: WorkAgent
**Semana 9, días 3–5**

- [x] Clase `WorkAgent` extends `NexusAgent`:
  - [x] Manifiesto: domain: customer_facing, scope: commerce
  - [x] Capacidades: PRODUCT_SEARCH, PRICE_CHECK, ORDER_QUERY, CALC_SIMPLE
  - [x] `context_mode: 'stateless'`
  - [x] SDK: LangChain.js via `IToolExecutor` interface inyectable
  - [x] `MockToolExecutor` para testing (configurable, execution logging)

- [x] Tool execution (inject_when_all para parallel):
  - [x] `product_search` (async) — búsqueda full-text con filtros
  - [x] `price_check` (async) — precio actual + descuentos
  - [x] `order_query` (async) — historial de órdenes
  - [x] `calculate` (sync) — función pura TypeScript

- [x] Intent → Tool mapping configurable (`IntentToolMap`)
  - [x] Single-tool intents: `product_search`, `price_query`, `order_query`, `calculate`
  - [x] Multi-tool intent: `product_search_with_price` → parallel execution
  - [x] Slot merging: task slots se inyectan en cada tool input

- [x] Demo de paralelismo: 2 tools × 50ms = ~62ms (no ~100ms secuencial)
- [x] `aggregateResults()` extensible para customizar por intent
- [x] Partial failure handling: si un tool falla pero otro no, retorna completed con error info
- [x] Publica `bus:ACTION_COMPLETED` para que InteractionAgent reaccione
- [x] Tests (12 tests): single tool, parallel timing, ACTION_COMPLETED, errors, slots, lifecycle

---

### Sprint 2.4 — Integración E2E Fase 2
**Semana 10**

- [x] Integrar source de `bus:SPEECH_FINAL` (mock de Process 1)
- [x] Test completo: speech → Dispatcher → WorkAgent (paralelo) → InteractionAgent (habla)
- [x] Barge-in: `bus:BARGE_IN` → auto `audio_queue_interrupt()`
- [x] Métricas de latencia (vitest + benchmarks):
  - [x] p50 < 800ms end-to-end con tools mock (real: **30ms**)
  - [x] p95 < 1200ms (real: **32ms**)
- [ ] Ejemplo funcional en `examples/node-full/` — pendiente (no crítico para Fase 2)
- [ ] Documentar el flow en `docs/flows/product-search.md` — pendiente (no crítico para Fase 2)

**Entregable:** Pipeline voice → speech completo ✅ (26/26 tests passing)

---

## FASE 3 — Orders + Human Approval
**Semanas:** 11–13

---

### Sprint 3.1 — OrderAgent
**Semana 11**

- [x] Clase `OrderAgent` extends `NexusAgent`
- [x] Manifiesto: scope: order_management, `requires_human_approval: true`
- [x] Capacidades: ORDER_CREATE, ORDER_CANCEL, REFUND_CREATE, ORDER_STATUS
- [x] `IOrderService` interface + `MockOrderService` para testing
- [x] Tools (todas async):
  - [x] `order_create_draft` — crea en sistema externo
  - [x] `order_submit_for_approval` — envía a queue
  - [x] `refund_create_draft`
  - [x] `refund_submit_for_approval`
  - [x] `order_status_query`
- [x] Agent siempre termina rápido: draft → submit → DONE (status: waiting_approval)
- [x] Publica `bus:ORDER_PENDING_APPROVAL` para ApprovalQueue (Sprint 3.2)
- [x] Tests (12 tests): manifest, order_create, refund_create, order_status, order_cancel, errors, lifecycle

---

### Sprint 3.2 — Human Approval Flow
**Semana 12, días 1–3**

- [x] Clase `InMemoryApprovalQueue` (packages/core/src/approval/):
  - [x] `start()` → subscribe a `bus:ORDER_PENDING_APPROVAL`, retorna Unsubscribe
  - [x] `approve(draftId, approverId)` → publica `bus:ORDER_APPROVED` + `bus:ACTION_COMPLETED`
  - [x] `reject(draftId, reason)` → publica `bus:ORDER_APPROVAL_REJECTED` + `bus:ACTION_COMPLETED`
  - [x] Timeout: si no aprobado en `approval_timeout_ms` → `bus:ORDER_APPROVAL_TIMEOUT` + `bus:ACTION_COMPLETED`
  - [x] `ApprovalNotFoundError`, `ApprovalAlreadyResolvedError`
- [x] Webhook handler (`createApprovalWebhookHandler`) — Express/Hono compatible
- [x] `approve()` publica `bus:ORDER_APPROVED` → InteractionAgent reacciona vía `bus:ACTION_COMPLETED`
- [x] Tests ApprovalQueue (10 tests): record, approve, reject, timeout, errors, refund text
- [x] E2E `order-approval.e2e.test.ts` (4 tests): approve, reject, timeout, refund approve

---

### Sprint 3.3 — Task Chaining & Cancel Token
**Semana 12, días 4–5**

- [ ] Task chaining funcional en `TaskQueue`:
  - [ ] Task B con `depends_on: taskA_id` → no se publica hasta que Task A completa
  - [ ] Si Task A falla → Task B cancelada automáticamente
- [ ] Cancel token flow:
  - [ ] Dispatcher incluye `cancel_token` en task chain
  - [ ] `taskQueue.cancel(taskId, cancelToken)` → ok si pre-RUNNING
  - [ ] Test: usuario dice "mejor el rojo" → Task B (ORDER_CREATE) cancelada antes de ejecutarse

---

### Sprint 3.4 — Order Status Query independiente
**Semana 13**

- [ ] Test: `¿cómo va mi pedido?` → NUEVO TASK_AVAILABLE (independiente)
- [ ] Agent 3 lee `order_id` del context snapshot → `order_status_query()`
- [ ] Resultado patcha context → Agent 1 responde
- [ ] Tests E2E del flujo completo: crear → aprobar → status query

**Entregable:** Flujo órdenes completo ✅

---

## FASE 4 — Multi-Sesión, Docs & v1.0.0
**Semanas:** 14–15

---

### Sprint 4.1 — Multi-Sesión Concurrente
**Semana 14, días 1–3**

- [ ] Stress test: 10 sesiones concurrentes con WorkAgent
- [ ] Verificar cero cross-contamination en ContextStore
- [ ] Verificar que ACTION_COMPLETED de sess_ana NO llega a sess_pedro
- [ ] Load test: medir latencia degradación bajo carga
- [ ] Fix de cualquier race condition detectada

---

### Sprint 4.2 — Priority Groups & Employee Interrupt
**Semana 14, días 4–5**

- [ ] Lógica de `priority_group` en SessionManager:
  - [ ] group_0: múltiples clientes (social)
  - [ ] group_1: cliente individual (default)
  - [ ] group_2: empleado/sistema (alta prioridad)
- [ ] Employee interrupt protocol:
  - [ ] `bus:PRIORITY_INTERRUPT` → pausa sesión cliente
  - [ ] Responde al empleado
  - [ ] Retoma sesión cliente
- [ ] Session merge para group_0 multi-cliente

---

### Sprint 4.3 — Docs, Examples & Publicación v1.0.0
**Semana 15**

- [ ] `typedoc` genera docs completas de todos los paquetes
- [ ] Guías en `docs/guides/`:
  - [ ] `getting-started.md` — quickstart en 10 minutos
  - [ ] `asynctools-standalone.md` — usar Layer 2 con LangGraph
  - [ ] `add-new-agent.md` — agregar agente en 10 minutos
  - [ ] `training-the-dispatcher.md` — cómo funciona el training
  - [ ] `rust-dispatcher.md` — cuándo y cómo usar el binario Rust
- [ ] `examples/voice-retail/` completamente funcional con README
- [ ] `CHANGELOG.md` con todos los cambios
- [ ] Matriz de compatibilidad: Node.js 18+, 20+; Redis 6+, 7+
- [ ] `npm publish` para `fitalyagents` v1.0.0
- [ ] Crear GitHub Release con binarios del dispatcher Rust (fase 5)

**Entregable:** SDK publicado v1.0.0 ✅

---

## FASE 5 — Rust Dispatcher (Comercial)
**Semanas:** 16–20 (post v1.0.0)

---

### Sprint 5.1 — Proyecto Rust Base
**Semana 16**

- [ ] `cargo new dispatcher-core-rust --bin`
- [ ] `Cargo.toml` con todas las dependencias (ver `PLAN-DISPATCHER.md`)
- [ ] Estructura de módulos: `classifier/`, `router/`, `registry/`, `session/`, `locks/`
- [ ] Conexión Redis con `redis-rs` + `tokio`
- [ ] Config via env vars (mismas que NodeDispatcher)

### Sprint 5.2 — Rust Classifier (candle)
**Semana 17**

- [ ] Cargar modelo `all-MiniLM-L6-v2` con candle
- [ ] `embed(text: &str) -> Vec<f32>` — ~2-5ms
- [ ] Cosine similarity en memoria — ~0.1ms para 100 intents
- [ ] Cargar intent embeddings desde Redis al iniciar
- [ ] `SUBSCRIBE bus:INTENT_UPDATED` → reload embedding hot

### Sprint 5.3 — Rust Tasks Tokio
**Semanas 18–19**

- [ ] Implementar todos los workers tokio (ver `PLAN-DISPATCHER.md` sección 5.1)
- [ ] Verificar paridad de comportamiento con NodeDispatcher
- [ ] Tests de integración: Rust dispatcher + agentes TypeScript
- [ ] Benchmark: medir latencia real vs NodeDispatcher

### Sprint 5.4 — Build, Release & Documentación
**Semana 20**

- [ ] `cargo build --release` para linux/x86_64, linux/arm64, darwin/arm64
- [ ] GitHub Actions build matrix
- [ ] GitHub Release con binarios
- [ ] Documentación: `docs/guides/rust-dispatcher.md`
- [ ] Pricing/licensing decidido

**Entregable:** `dispatcher-core-rust` v1.0.0 ✅

---

## Matriz de Progreso Global

| Componente | Fase | Sprint | Status |
|---|---|---|---|
| Monorepo & tooling | 0 | 0.1 | ✅ |
| Tipos base asynctools | 0 | 0.1 | ✅ |
| ToolRegistry | 0 | 0.2 | ✅ |
| HttpExecutor | 0 | 0.3 | ✅ |
| FunctionExecutor | 0 | 0.3 | ✅ |
| SubprocessExecutor | 0 | 0.3 | ✅ |
| ExecutorPool (concurrencia, retry) | 0 | 0.3 | ✅ |
| PendingStateTracker (in-memory) | 0 | 0.4 | ✅ |
| PendingStateTracker (Redis) | 0 | 0.4 | ⏳ |
| InjectionManager | 0 | 0.5 | ✅ |
| AsyncAgent wrapper | 0 | 0.5 | ✅ |
| Adaptadores OpenAI/Anthropic | 0 | 0.5 | ⬜ |
| `fitalyagents/asynctools` publicado | 0 | 0.6 | ✅ |
| IEventBus + RedisBus | 1 | 1.1 | ✅ |
| NexusAgent base class | 1 | 1.1 | ✅ |
| AgentManifest schema | 1 | 1.1 | ✅ |
| AgentRegistry | 1 | 1.2 | ✅ |
| ContextStore (InMemory + RedisJSON-ready) | 1 | 1.3 | ✅ |
| LockManager | 1 | 1.4 | ✅ |
| SessionManager | 1 | 1.4 | ✅ |
| TaskQueue + lifecycle completo | 1 | 1.5 | ✅ |
| CapabilityRouter (7 pasos) | 1 | 1.6 | ✅ |
| EmbeddingClassifier (Node/WASM) | 1 | 1.7 | ✅ |
| LLMFallbackAgent | 1 | 1.7 | ✅ |
| IntentLibrary | 1 | 1.7 | ✅ |
| NodeDispatcher completo | 1 | 1.7 | ✅ |
| AudioQueueService | 2 | 2.1 | ✅ |
| Agent 1 — InteractionAgent | 2 | 2.2 | ✅ |
| Agent 2 — WorkAgent (paralelo) | 2 | 2.3 | ✅ |
| E2E pipeline voice→speech | 2 | 2.4 | ✅ |
| Agent 3 — OrderAgent | 3 | 3.1 | ✅ |
| ApprovalQueue + webhook | 3 | 3.2 | ✅ |
| Task chaining + cancel token | 3 | 3.3 | ⬜ |
| Order status query | 3 | 3.4 | ⬜ |
| Multi-sesión concurrente | 4 | 4.1 | ⬜ |
| Priority groups + employee interrupt | 4 | 4.2 | ⬜ |
| Docs + v1.0.0 publicado | 4 | 4.3 | ⬜ |
| dispatcher-core-rust | 5 | 5.x | ⬜ |
