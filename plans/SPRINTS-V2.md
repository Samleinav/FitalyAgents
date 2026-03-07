# FitalyAgents v2 — Sprint Execution Plan

> **Principio:** Todo lo no necesario se borra primero. Luego se construye v2.
> Este documento es la guía de ejecución. La visión completa está en `PLANV2.md`.
> Fecha: 2026-03-05

---

## Estado de partida

```
EXISTE (v1, mantener):
  packages/asynctools/     ← ToolRegistry, ExecutorPool, AsyncAgent — 325 tests ✅
  packages/core/bus/       ← RedisBus, InMemoryBus ✅
  packages/core/session/   ← SessionManager, PriorityGroups ✅
  packages/core/context/   ← InMemoryContextStore ✅
  packages/core/audio/     ← AudioQueueService, barge-in ✅
  packages/core/approval/  ← InMemoryApprovalQueue (migrar, no borrar aún)

EXISTE (v1, BORRAR):
  packages/core/routing/   ← CapabilityRouter, SimpleRouter
  packages/core/registry/  ← AgentRegistry
  packages/core/locks/     ← LockManager
  packages/core/tasks/     ← TaskQueue
  packages/core/agent/     ← NexusAgent (deprecar, borrar en Sprint 4.1)
  packages/dispatcher/node/fallback/    ← LLMFallbackAgent
  packages/dispatcher/node/bootstrapper/ ← DispatcherBootstrapper

EXISTE (prototipo en examples, MIGRAR a packages):
  examples/agent-comparison/src/intent-teacher.ts     → packages/dispatcher/
  examples/agent-comparison/src/intent-score-store.ts → packages/dispatcher/
  examples/agent-comparison/src/speculative cache     → packages/dispatcher/

NO EXISTE, CREAR:
  packages/core/safety/    ← SafetyGuard, DraftStore, ApprovalOrchestrator, Channels
  packages/core/agent/interaction-agent.ts
  packages/core/agent/stream-agent.ts
  packages/dispatcher/src/speculative-cache.ts
  docs/                    ← ARCHITECTURE-V2, SAFETY-MODEL, etc. (ya creados)
```

---

## Fase 1 — Simplificación de Core

### Sprint 1.1 — BORRAR código v1 (`packages/core`) ✅ COMPLETADO 2026-03-05

**Objetivo:** Eliminar toda la orquestación manual que el LLM reemplaza.
**Resultado:** 12 test files, 118 tests passing. routing/, registry/, locks/, tasks/ eliminados.

```
BORRAR archivos:
[x] packages/core/src/routing/capability-router.ts
[x] packages/core/src/routing/simple-router.ts
[x] packages/core/src/routing/types.ts
[x] packages/core/src/routing/  (directorio vacío)
[x] packages/core/src/registry/agent-registry.ts
[x] packages/core/src/registry/  (directorio vacío)
[x] packages/core/src/locks/lock-manager.ts
[x] packages/core/src/locks/types.ts
[x] packages/core/src/locks/  (directorio vacío)
[x] packages/core/src/tasks/task-queue.ts
[x] packages/core/src/tasks/types.ts
[x] packages/core/src/tasks/  (directorio vacío)

DEPRECAR (marcar @deprecated, NO borrar — se borra en Sprint 4.1):
[x] packages/core/src/agent/nexus-agent.ts
    → Agregar JSDoc: @deprecated Use StreamAgent instead. Will be removed in v2.0.0

CREAR (stub para que Sprint 3+ lo use):
[x] packages/core/src/agent/stream-agent.ts
    → Exporta clase StreamAgent vacía con lifecycle: start(), stop(), dispose()

ACTUALIZAR:
[x] packages/core/src/index.ts
    → Remover exports: CapabilityRouter, SimpleRouter, AgentRegistry, LockManager,
      TaskQueue, InMemoryTaskQueue + todos sus types
    → Agregar export: StreamAgent
[x] packages/core/src/types/index.ts
    → Eliminar: TaskPayloadEvent, TaskResultEvent, HeartbeatEvent (si solo lo usa routing)
    → Mantener: ActionCompletedEvent, BusEvents base

TESTS:
[x] Eliminar tests de módulos borrados:
    capability-router.test.ts, agent-registry.test.ts,
    lock-manager.test.ts, task-queue.test.ts
[x] Actualizar tests que importaban los módulos eliminados
[x] Verificar examples/voice-retail — ajustar imports rotos

CRITERIO DE DONE:
[x] pnpm -r build  → sin errores TypeScript
[x] pnpm -r test   → solo tests de módulos existentes pasan
[x] docs/ARCHITECTURE-V2.md creado ✅ (ya existe)
```

---

### Sprint 1.2 — Safety Module + Multi-Channel Approval ✅ COMPLETADO 2026-03-05

**Objetivo:** Construir el corazón del nuevo modelo de seguridad.
**Resultado:** 17 test files, 280 tests passing. SafetyGuard, DraftStore, 3 channels, ApprovalOrchestrator, bus events, ToolDefinition safety fields.

```
CREAR packages/core/src/safety/channels/types.ts:
[x] type SafetyLevel = 'safe' | 'staged' | 'protected' | 'restricted'
[x] type HumanRole = 'customer' | 'staff' | 'cashier' | 'manager' | 'owner'
[x] interface HumanProfile { id, name, role, store_id, voice_embedding?, approval_limits, is_present? }
[x] interface ApprovalLimits { payment_max?, discount_max_pct?, refund_max?, can_override_price?, can_adjust_inventory? }
[x] interface IApprovalChannel { id, type, notify(request, approver), waitForResponse(request, timeoutMs), cancel(requestId) }
[x] interface ApprovalRequest { id, draft_id, action, amount?, session_id, required_role, context, timeout_ms }
[x] interface ApprovalResponse { approved, approver_id, channel_used, reason?, timestamp }
[x] type ApprovalStrategy = 'parallel' | 'sequential'

CREAR packages/core/src/safety/safety-guard.ts:
[x] class SafetyGuard
[x] evaluate(action, params, speaker, context): SafetyDecision
[x] roleHasPermission(speaker, toolName, params): boolean
    → verifica payment_max, discount_max_pct, refund_max contra params.amount/percentage
[x] findNearbyApprover(requiredRole, storeId): Promise<HumanProfile | null>
    → consulta bus o in-memory registry de perfiles presentes
[x] const defaultLimits: Record<HumanRole, ApprovalLimits>

CREAR packages/core/src/safety/draft-store.ts:
[x] interface Draft { id, session_id, intent_id, status, items, total?, ttl_seconds, history[], created_at }
[x] class InMemoryDraftStore (para tests)
[x] class RedisDraftStore (para producción)
[x] create(sessionId, input): Promise<string>          → draftId
[x] update(draftId, changes): Promise<Draft>           → guarda historial, renueva TTL
[x] confirm(draftId): Promise<void>                    → status='confirmed'
[x] cancel(draftId): Promise<void>                     → eliminar
[x] rollback(draftId): Promise<Draft>                  → restaurar historial[-1]
[x] get(draftId): Promise<Draft | null>
[x] getBySession(sessionId): Promise<Draft | null>
[x] TTL: auto-expira → publica bus:DRAFT_CANCELLED

CREAR packages/core/src/safety/channels/voice-channel.ts:
[x] class VoiceApprovalChannel implements IApprovalChannel
[x] notify(): publica bus:APPROVAL_VOICE_REQUEST con prompt_text generado
[x] waitForResponse(): suscribe bus:SPEECH_FINAL
    → verifica speaker_id === approver esperado
    → NLU simple: detecta afirmativo/negativo en texto
    → resuelve ApprovalResponse o null (timeout)
[x] cancel(): unsuscribe + cleanup

CREAR packages/core/src/safety/channels/webhook-channel.ts:
[x] class WebhookApprovalChannel implements IApprovalChannel
[x] Migrar lógica timer/timeout de InMemoryApprovalQueue
[x] notify(): publica bus:APPROVAL_WEBHOOK_REQUEST
[x] waitForResponse(): espera bus:APPROVAL_WEBHOOK_RESPONSE donde payload.request_id matches
[x] cancel(): unsuscribe

CREAR packages/core/src/safety/channels/external-tool-channel.ts:
[x] class ExternalToolChannel implements IApprovalChannel
[x] Config: { url: string, method: 'POST' | 'GET', auth?: string }
[x] notify(): HTTP fetch al endpoint externo con ApprovalRequest serializado
[x] waitForResponse(): suscribe bus:APPROVAL_EXTERNAL_RESPONSE donde request_id matches
[x] cancel(): unsuscribe

CREAR packages/core/src/safety/approval-orchestrator.ts:
[x] class ApprovalOrchestrator
[x] start(): suscribe bus:ORDER_PENDING_APPROVAL → llama orchestrate()
[x] orchestrate(request): Promise<ApprovalResponse>
    → parallel: Promise.race() de todos los channels
    → sequential: await en orden, fallback si null
    → on resolve → cancela los demás channels
    → on all null → publica bus:ORDER_APPROVAL_TIMEOUT
[x] Publica bus:APPROVAL_RESOLVED + bus:ORDER_APPROVED on success
[x] dispose()

MANTENER packages/core/src/approval/types.ts:
[x] Re-exportar IApprovalChannel as IApprovalQueue (backwards compat)
[x] Re-exportar ApprovalRecord, ApprovalStatus (backwards compat)

ACTUALIZAR packages/core/src/types/index.ts — AGREGAR:
[x] bus:APPROVAL_VOICE_REQUEST
[x] bus:APPROVAL_WEBHOOK_REQUEST
[x] bus:APPROVAL_EXTERNAL_REQUEST
[x] bus:APPROVAL_EXTERNAL_RESPONSE
[x] bus:APPROVAL_RESOLVED
[x] bus:DRAFT_CREATED
[x] bus:DRAFT_CONFIRMED
[x] bus:DRAFT_CANCELLED

ACTUALIZAR packages/core/src/index.ts:
[x] Agregar exports de safety/: SafetyGuard, DraftStore, ApprovalOrchestrator,
    IApprovalChannel, VoiceApprovalChannel, WebhookApprovalChannel, ExternalToolChannel,
    HumanRole, HumanProfile, ApprovalLimits, SafetyLevel

ACTUALIZAR packages/asynctools ToolRegistry:
[x] Aceptar campos safety, required_role, approval_channels, approval_strategy en ToolDefinition

TESTS:
[x] safety-guard.test.ts
    → roleHasPermission: cashier puede pagar ≤50k, no puede reembolsar
    → roleHasPermission: manager puede reembolsar ≤100k, no puede hacerlo owner
    → evaluate: retorna allowed=true para SAFE independiente del rol
[x] draft-store.test.ts
    → create → update → confirm lifecycle
    → create → rollback → state anterior restaurado
    → TTL expiry → bus:DRAFT_CANCELLED publicado
[x] voice-channel.test.ts (mock bus:SPEECH_FINAL)
    → notify publica APPROVAL_VOICE_REQUEST
    → waitForResponse resuelve cuando speaker correcto dice "sí"
    → waitForResponse retorna null en timeout
[x] webhook-channel.test.ts
    → waitForResponse resuelve en bus:APPROVAL_WEBHOOK_RESPONSE
[x] external-tool-channel.test.ts (mock fetch)
    → notify llama HTTP con payload correcto
    → waitForResponse resuelve en bus:APPROVAL_EXTERNAL_RESPONSE
[x] approval-orchestrator.test.ts
    → parallel: primer canal en resolver gana, segundo se cancela
    → sequential: primer canal timeout → segundo canal responde
    → all timeout → APPROVAL_TIMEOUT publicado
[x] Regression: examples/voice-retail E2E tests sin cambios

CRITERIO DE DONE:
[x] pnpm -r build && pnpm -r test
[x] docs/SAFETY-MODEL.md ✅ (ya existe + casos expandidos)
[x] docs/APPROVAL-CHANNELS.md ✅ (ya existe)
[x] docs/HUMAN-ROLES.md ✅ (ya existe)
```

---

### Sprint 1.3 — Session + Context v2 ✅ COMPLETADO 2026-03-05

**Objetivo:** Soporte para múltiples hablantes y contexto ambient.
**Resultado:** 14 test files, 217 tests passing. TargetGroupStateMachine, AmbientContext, 6 bus event schemas.

```
CREAR packages/core/src/session/target-group.ts:
[x] type TargetState = 'idle' | 'targeted' | 'responding' | 'queued' | 'ambient'
[x] class TargetGroupStateMachine
[x] transition(speakerId, event): TargetState
[x] getTarget(): string | null
[x] getQueued(): string[]
[x] setAmbient(speakerId): void

EXTENDER packages/core/src/context/in-memory-context-store.ts:
[x] getAmbient(sessionId): Promise<AmbientContext | null>
[x] setAmbient(sessionId, data: AmbientContext): Promise<void>
[x] AmbientContext: { last_product_mentioned?, conversation_snippets[], timestamp }

ACTUALIZAR packages/core/src/types/index.ts — AGREGAR:
[x] bus:SPEECH_PARTIAL   { session_id, text, confidence, speaker_id? }
[x] bus:AMBIENT_CONTEXT  { session_id, speaker_id, text, timestamp }
[x] bus:TARGET_DETECTED  { session_id, speaker_id, store_id }
[x] bus:TARGET_QUEUED    { session_id, speaker_id, position }
[x] bus:TARGET_GROUP     { session_id, speaker_ids[], primary }
[x] bus:PROACTIVE_TRIGGER { session_id, reason, context }

TESTS:
[x] target-group.test.ts → transitions idle→targeted, targeted→queued (segundo cliente), etc.
[x] context-store ambient tests → setAmbient / getAmbient / persist across turns

CRITERIO DE DONE:
[x] pnpm -r build && pnpm -r test
```

---

## Fase 2 — Dispatcher v2

### Sprint 2.1 — Speculative Cache ✅ COMPLETADO 2026-03-05

**Objetivo:** El dispatcher pre-ejecuta SAFE tools antes de que el LLM los pida.
**Resultado:** SpeculativeCache con LRU eviction, TTL, 3 entry types. 22 tests passing.

```
CREAR packages/dispatcher/src/speculative-cache.ts:
[x] class SpeculativeCache
[x] set(sessionId, intentId, result, ttlMs): void      → SAFE tool result
[x] setDraft(sessionId, draftId, intentId): void       → STAGED draft ref
[x] setHint(sessionId, intentId, confidence): void     → PROTECTED/RESTRICTED hint
[x] get(sessionId, intentId): ToolResult | DraftRef | Hint | null
[x] getAny(sessionId): SpeculativeResult | null        → busca cualquier resultado
[x] invalidate(sessionId): void                        → limpiar al final de turno
[x] LRU con capacidad configurable (default 256 entries)
[x] TTL por entrada (SAFE: 30s, STAGED: TTL del draft)

ACTUALIZAR packages/dispatcher/src/node-dispatcher.ts:
[x] Inyectar: SafetyGuard, SpeculativeCache, DraftStore
[x] onSpeechPartial(event):
    → classify(text) → si conf > 0.90 Y margin > 0.15:
        SAFE      → executorPool.execute(tool, params) → cache.set()
        STAGED    → draftStore.create() → cache.setDraft()
        PROTECTED → cache.setHint()
        RESTRICTED → cache.setHint()
[x] getSpeculativeResult(sessionId, intentId?): SpeculativeResult | null

TESTS:
[x] speculative-cache.test.ts → LRU eviction, TTL expiry, get/set/invalidate
[x] dispatcher integration: SPEECH_PARTIAL → SAFE → cache populated
[x] dispatcher integration: SPEECH_PARTIAL → STAGED → draft created
[x] dispatcher integration: SPEECH_PARTIAL → RESTRICTED → hint only (no execution)

CRITERIO DE DONE:
[x] pnpm -r build && pnpm -r test
[x] docs/DISPATCHER-SPECULATIVE.md creado
```

---

### Sprint 2.2 — Migrar Teacher + ScoreStore ✅ COMPLETADO 2026-03-05

**Objetivo:** Sacar los prototipos de examples/ a packages/ como código de producción.
**Resultado:** IntentTeacher (injectable LLM, generic intents), IntentScoreStore (EMA, injectable backend). 41 tests passing.

```
MIGRAR examples/agent-comparison/src/intent-teacher.ts
     → packages/dispatcher/src/intent-teacher.ts:
[x] Eliminar hardcoded business logic (tienda de zapatos)
[x] instructionPrompt: string inyectable por negocio
[x] Redis backend para persistir correcciones entre reinicios
[x] InMemory fallback para tests
[x] evaluate(query, wrong, correct): 'add' | 'skip' | 'flag'
[x] addExample(intentId, example): void → actualiza vector store en vivo

MIGRAR examples/agent-comparison/src/intent-score-store.ts
     → packages/dispatcher/src/intent-score-store.ts:
[x] EMA (α=0.1) por intent_id
[x] Redis backend (production) + InMemory (tests)
[x] recordHit(intentId): void
[x] recordCorrection(intentId): void
[x] getScore(intentId): number (0-1)
[x] isProduction(intentId): boolean   → score ≥ 0.70
[x] suggestProductionSwitch(): string[] → intents con hit rate ≥ 90%

ACTUALIZAR packages/dispatcher/src/index.ts:
[x] Exportar: IntentTeacher, IntentScoreStore, SpeculativeCache

TESTS:
[x] intent-teacher.test.ts (mock LLM provider)
    → evaluate returns 'add' cuando la query pertenece al intent correcto
    → addExample actualiza classifier
[x] intent-score-store.test.ts
    → EMA converge correctamente con hits sucesivos
    → isProduction = false cuando score < 0.70

CRITERIO DE DONE:
[x] pnpm -r build && pnpm -r test
```

---

### Sprint 2.3 — BORRAR código viejo del Dispatcher ✅ COMPLETADO 2026-03-05

**Objetivo:** Limpiar el dispatcher de v1.
**Resultado:** Borrados fallback/ y bootstrapper/. node-dispatcher.test.ts migrado a MockFallbackAgent. 7 test files, 95 tests passing.

```
BORRAR:
[x] packages/dispatcher/src/node/fallback/  (LLMFallbackAgent)
[x] packages/dispatcher/src/node/bootstrapper/dispatcher-bootstrapper.ts
[x] packages/dispatcher/src/node/bootstrapper/  (directorio)

ACTUALIZAR packages/dispatcher/src/index.ts:
[x] Remover exports eliminados

ACTUALIZAR tests:
[x] Eliminar tests de DispatcherBootstrapper, LLMFallbackAgent
[x] Actualizar node-dispatcher.test.ts si tiene referencias eliminadas

CRITERIO DE DONE:
[x] pnpm -r build && pnpm -r test
```

---

## Fase 3 — Interaction Agent

### Sprint 3.1 — Interaction Agent (base) ✅ COMPLETADO 2026-03-05

**Objetivo:** El LLM streaming con tool calling — el cerebro del sistema.
**Resultado:** InteractionAgent con IStreamingLLM, safety pipeline (4 niveles), speculative cache, context building, TTS streaming. 15 test files, 235 tests passing. Build DTS clean.

```
CREAR packages/core/src/agent/interaction-agent.ts:
[x] class InteractionAgent
[x] constructor({ toolRegistry, executorPool, llm, contextStore, dispatcher, ttsCallback, safetyGuard })
[x] handleSpeechFinal(event: SpeechFinalEvent): Promise<void>
    → buildContext(sessionId) → [system, conversation_history, tool_results]
    → llm.stream({ tools, messages })
    → for await chunk:
        type='text'      → ttsCallback(chunk.text) (streaming inmediato)
        type='tool_call' → handleToolCall(chunk, sessionId, speculative)
[x] handleToolCall(call, sessionId, speculative): Promise<ToolResult>
    → safety = toolRegistry.get(call.name).safety
    → SAFE:      cache hit? → return cached : executorPool.execute()
    → STAGED:    return {type:'draft_ready', draft, needs_confirmation:true}
    → PROTECTED: return {type:'needs_confirmation', prompt}
    → RESTRICTED: approvalOrchestrator.orchestrate() → await result
[x] Registra HIT/CORRECTION en teacher después de cada tool_call

TESTS:
[x] interaction-agent.test.ts (mock LLM, mock executorPool):
    → SAFE tool → llama executorPool, retorna resultado
    → SAFE con cache → retorna cached sin llamar executor
    → STAGED → retorna draft_ready, no ejecuta
    → PROTECTED → retorna needs_confirmation, no ejecuta
    → RESTRICTED → llama approvalOrchestrator, espera resultado

CRITERIO DE DONE:
[x] pnpm -r build && pnpm -r test
```

---

### Sprint 3.2 — Draft Flow multi-turno ✅ COMPLETADO 2026-03-05

**Objetivo:** El cliente puede modificar su orden N veces antes de confirmar.
**Resultado:** handleDraftFlow con parseDraftIntent (regex ES/EN), extractDraftChanges vía LLM, subscribeDraftExpiry TTL. 16 test files, 248 tests. Build DTS clean.

```
EXTENDER interaction-agent.ts:
[x] handleDraftFlow(sessionId, draftId): void
    → Escucha siguiente turno del cliente:
        "sí/dale/confirma" → DraftStore.confirm()  → ejecutar acción real
        "no/mejor/cambia"  → DraftStore.update()   → re-presentar
        "cancela/olvídalo" → DraftStore.cancel()
[x] TTL expiry handler: bus:DRAFT_CANCELLED → notificar cliente por TTS
[x] Manejar ambigüedad: "mejor en azul" → detectar campo modificado + llamar update()

TESTS:
[x] crear → confirmar
[x] crear → modificar color → confirmar
[x] crear → modificar N veces → cancelar
[x] TTL expiry → notificación al cliente
[x] multi-turno con barge-in durante presentación del draft

CRITERIO DE DONE:
[x] pnpm -r build && pnpm -r test
```

---

### Sprint 3.3 — PROTECTED + RESTRICTED con ApprovalOrchestrator ✅ COMPLETADO 2026-03-05

**Objetivo:** Cerrar el loop de aprobación humana.
**Resultado:** handleProtectedConfirm (confirm/deny/re-prompt), subscribeApprovalEvents (APPROVAL_RESOLVED + ORDER_APPROVAL_TIMEOUT), hasPendingConfirmation. 17 test files, 258 tests. Build DTS clean.

```
EXTENDER interaction-agent.ts:
[x] PROTECTED flow:
    → LLM detecta needs_confirmation → genera confirmation_prompt vía TTS
    → Espera siguiente turno: afirmativo → ejecutar tool : negativo → cancelar
[x] RESTRICTED flow:
    → LLM llama tool → SafetyGuard → ApprovalOrchestrator.orchestrate()
    → Mientras espera: TTS "un momento, esperando aprobación"
    → bus:APPROVAL_RESOLVED → LLM reanuda con resultado
    → bus:ORDER_APPROVAL_TIMEOUT → LLM informa al cliente
[x] Suscribir bus:APPROVAL_RESOLVED por session_id

ACTUALIZAR examples/voice-retail:
[x] Migrar ejemplos existentes a usar InteractionAgent + ApprovalOrchestrator

TESTS:
[x] PROTECTED: cliente confirma → tool se ejecuta
[x] PROTECTED: cliente niega → tool no se ejecuta, respuesta amigable
[x] RESTRICTED: VoiceChannel mock → aprueba → tool ejecuta
[x] RESTRICTED: timeout (todos los canales) → cliente informado
[x] RESTRICTED: sequential → voz timeout → webhook responde
[x] Regression: E2E voice-retail completo sin regresiones

CRITERIO DE DONE:
[x] pnpm -r build && pnpm -r test
[x] examples/voice-retail E2E 73 tests pasando
```

---

## Fase 4 — Agentes Autónomos

### Sprint 4.1 — StreamAgent + eliminar NexusAgent ✅ COMPLETADO 2026-03-05

**Objetivo:** Base class limpia para agentes que viven en el bus.
**Resultado:** StreamAgent con tests (11 tests), AgentBundle migrado a IAgent genérica (stop/shutdown), NexusAgent eliminado. 0 referencias residuales en core. 17 test files, 257 tests. Build DTS clean.

```
COMPLETAR packages/core/src/agent/stream-agent.ts:
[x] abstract class StreamAgent
[x] subscribe(channel: string, handler: BusHandler): void
[x] unsubscribe(channel: string): void
[x] start(): Promise<void>    → subscribe a channels configurados
[x] stop(): Promise<void>     → unsubscribe todo
[x] dispose(): void           → stop() + cleanup
[x] Heartbeat configurable: publishHeartbeat(intervalMs)
[x] abstract onEvent(channel, payload): Promise<void>

BORRAR:
[x] packages/core/src/agent/nexus-agent.ts (deprecado en Sprint 1.1)

ACTUALIZAR packages/core/src/index.ts:
[x] Remover NexusAgent export
[x] StreamAgent ya exportado

ACTUALIZAR examples/voice-retail:
[x] Reemplazar NexusAgent con StreamAgent en todos los agentes del ejemplo

TESTS:
[x] stream-agent.test.ts
    → start() → suscripción activa
    → stop() → suscripción cancelada
    → evento en bus → onEvent() invocado

CRITERIO DE DONE:
[x] pnpm -r build && pnpm -r test
[x] No quedan referencias a NexusAgent en el codebase
```

---

### Sprint 4.2 — ContextBuilderAgent ✅ COMPLETADO 2026-03-05

**Resultado:** ContextBuilderAgent extends StreamAgent, suscribe 6 canales del bus, mantiene conversation_history, ambient_context, pending_draft, action_history, last_product_mentioned por sesión. 15 tests nuevos. 18 test files, 272 tests. Build DTS clean.

```
CREAR packages/core/src/agent/context-builder-agent.ts:
[x] class ContextBuilderAgent extends StreamAgent
[x] Suscribe: SPEECH_FINAL, AMBIENT_CONTEXT, ACTION_COMPLETED, DRAFT_CREATED, DRAFT_CONFIRMED, DRAFT_CANCELLED
[x] Mantiene por sesión:
    → conversation_history (últimos N turnos)
    → last_product_mentioned
    → pending_draft (si hay draft activo)
    → action_history (últimas N acciones completadas)
[x] getEnrichedContext(sessionId): ConversationContext para InteractionAgent

TESTS:
[x] context acumulado correctamente en multi-turno
[x] AMBIENT_CONTEXT enriquece contexto sin generar respuesta
[x] draft states reflejados en contexto

CRITERIO DE DONE:
[x] pnpm -r build && pnpm -r test
```

---

### Sprint 4.3 — ProactiveAgent ✅ COMPLETADO 2026-03-05

**Resultado:** ProactiveAgent extends StreamAgent. Detecta idle_customer (configurable timer con reset), out_of_stock (stock=0, empty products, in_stock=false), draft_expired (ttl_expired). 11 tests. 19 test files, 283 tests total. Build DTS clean.

```
CREAR packages/core/src/agent/proactive-agent.ts:
[x] class ProactiveAgent extends StreamAgent
[x] Detecta situaciones:
    → cliente sin respuesta > N segundos → PROACTIVE_TRIGGER (reason: 'idle_customer')
    → producto mencionado sin stock → PROACTIVE_TRIGGER (reason: 'out_of_stock')
    → draft expirado → PROACTIVE_TRIGGER (reason: 'draft_expired')
[x] Emite bus:PROACTIVE_TRIGGER { session_id, reason, context }
[x] InteractionAgent escucha y decide si hablar (evita ser intrusivo)

TESTS:
[x] idle_customer → trigger después de timeout configurado
[x] out_of_stock → trigger cuando tool retorna stock=0

CRITERIO DE DONE:
[x] pnpm -r build && pnpm -r test
```

---

## Fase 5 — FitalyVoice Integration

### Sprint 5.1 — SPEECH_PARTIAL support ✅ COMPLETADO 2026-03-06

**Objetivo:** Dispatcher pre-ejecuta SAFE tools durante habla parcial.
**Resultado:** NodeDispatcher suscribe `bus:SPEECH_PARTIAL` cuando tiene SpeculativeCache inyectado. Thresholds estrictos (0.90 confianza, 0.15 margen). SAFE→pre-ejecuta+cachea, STAGED/PROTECTED/RESTRICTED→cachea hint. SpeechPartialEvent type agregado. 12 tests nuevos (19 total en node-dispatcher). 7 test files, 107 tests. Build DTS clean. También se corrigió error pre-existente de DTS con `setInterval`/`clearInterval` y `process.env`.

```
[x] Dispatcher suscribe bus:SPEECH_PARTIAL
[x] onSpeechPartial(event): classify → speculate (ya implementado en Sprint 2.1)
[x] Tests: PARTIAL → speculative hit → FINAL usa cache (0ms tool wait)
[x] pnpm -r build && pnpm -r test
```


### Sprint 5.2 — Target Group State Machine ✅ COMPLETADO 2026-03-06

**Resultado:** TargetGroupBridge extends StreamAgent. Listens to SPEAKER_DETECTED/LOST/AMBIENT + RESPONSE_START/END. Creates sessions on target, sets priority 0 on queue, upgrades to 1 on promotion. Publishes bus:TARGET_GROUP_CHANGED snapshot after every transition. TargetGroupChangedEvent type+schema added. 14 tests. 20 test files, 297 tests. Build DTS clean.

```
[x] Completar TargetGroupStateMachine (placeholder de Sprint 1.3)
[x] Integrar con SessionManager:
    → SPEAKER_DETECTED → SessionManager.createSession() si no existe
    → queued           → SessionManager.setPriorityGroup(0)
    → promoted         → SessionManager.setPriorityGroup(1)
[x] TargetGroupChangedEvent schema en types/index.ts
[x] TargetGroupBridge exportado desde index.ts
[x] Tests: multi-speaker transitions (14 tests)
[x] pnpm -r build && pnpm -r test
```

### Sprint 5.3 — Ambient Context Pipeline ✅ COMPLETADO 2026-03-06

**Resultado:** `handleAmbientContext()` en ContextBuilderAgent ahora detecta eventos con `text` → extrae product mention → llama `contextStore.setAmbient()` con snippets + `last_product_mentioned`. `getEnrichedContext()` usa ambient como fallback para `last_product_mentioned` y mergea snippets en `ambient_context`. 6 tests nuevos. 20 test files, 303 tests. Build DTS clean.

```
[x] bus:AMBIENT_CONTEXT con text → contextStore.setAmbient() con AmbientContext estructurado
[x] Extrae product mention de texto ambient via extractProductMention()
[x] getEnrichedContext: ambient last_product_mentioned como fallback
[x] ambient.conversation_snippets visible en ambient_context del LLM
[x] Test: "¿los tienen en azul?" después de "me gustan los tenis Nike" → contexto resuelve product
[x] pnpm -r build && pnpm -r test
```

---

## Fase 6 — Production & Observability

### Sprint 6.1 — Langfuse Integration ✅ COMPLETADO 2026-03-06

**Resultado:** `ITracer`/`ITrace`/`ISpan` + `NoopTracer` (default, zero deps) + `LangfuseTracer` (duck-type adapter, sin importar `langfuse` — usuario pasa su instancia). `InteractionAgent` instrumentado: trace por turno con span LLM + span por tool call + `generation()` con latencia + `traceId` en el resultado. `NodeDispatcher` instrumentado: `classifier_confidence` + `classifier_hit` (1=hit, 0=fallback) per-classification. 17 tests. core: 21 files, 320 tests; dispatcher: 7 files, 107 tests. Build DTS clean.

```
[x] ITracer / ITrace / ISpan interfaces en packages/core/src/tracing/types.ts
[x] NoopTracer — zero overhead, default si no se configura tracer
[x] LangfuseTracer — duck-type adapter (sin dep langfuse, usuario pasa instancia)
[x] InteractionAgent: tracer? en deps, startTrace/span/generation/end en handleSpeechFinal
[x] NodeDispatcher: tracer? en deps, classifier_confidence + classifier_hit scores
[x] Export desde packages/core/src/index.ts
[x] tracer.test.ts — 17 tests (NoopTracer, LangfuseTracer, integration flows)
[x] pnpm -r build && pnpm -r test
```

### Sprint 6.2 — FitalyInsights Dashboard

```
[ ] Frontend sobre Langfuse API:
    → Preguntas frecuentes (top intents)
    → Gaps: preguntas sin respuesta (CORRECTION con flag)
    → Tasa de conversión: order_create → DraftStore.confirm
    → Comparación entre locales (Enterprise)
```

### Sprint 6.3 — Hardening

```
[ ] Rate limiting por tool (máx N req/seg por store_id)
[ ] Circuit breaker por tool: si falla N veces → auto-disable + notificación
[ ] Retry configurado en ExecutorPool (ya existe, revisar config)
[ ] pnpm -r build && pnpm -r test
```

---

## Orden de Ejecución Recomendado

```
1.1 → borrar v1                    (prerequisito de todo)
1.2 → safety module                (prerequisito de InteractionAgent)
1.3 → session + context v2         (puede ir en paralelo con 2.x)
2.1 → speculative cache            (prerequisito de dispatcher v2)
2.2 → migrar teacher + score       (puede ir en paralelo con 2.3)
2.3 → borrar dispatcher viejo      (después de 2.1 + 2.2)
3.1 → interaction agent base       (prerequisito de 3.2 + 3.3)
3.2 → draft flow                   (prerequisito de 3.3)
3.3 → protected + restricted flows (cierra el loop de approval)
4.1 → streamagent + borrar nexus   (puede ir después de 3.3)
4.2 → context builder agent        (requiere stream-agent)
4.3 → proactive agent              (requiere stream-agent)
5.x → fitalyvoice integration      (requiere 2.1 + 4.2)
6.x → production & observability   (último)
```

---

## Verificación por Sprint

Cada sprint termina con:
```bash
pnpm -r build    # sin errores TypeScript
pnpm -r test     # todos los tests pasan
pnpm -r lint     # sin lint errors
```

Y para sprints que tocan examples/voice-retail:
```bash
pnpm --filter examples/voice-retail test  # 73 tests, sin regresiones
```

---

## Docs a crear por sprint

| Sprint | Doc |
|---|---|
| 1.1 | `docs/ARCHITECTURE-V2.md` ✅ |
| 1.2 | `docs/SAFETY-MODEL.md` ✅, `docs/APPROVAL-CHANNELS.md` ✅, `docs/HUMAN-ROLES.md` ✅ |
| 2.1 | `docs/DISPATCHER-SPECULATIVE.md` |
| 6.x | `docs/FITALYSTORE-PRODUCT.md` ✅ |
