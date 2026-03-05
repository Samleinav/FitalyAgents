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

### Sprint 1.1 — BORRAR código v1 (`packages/core`)

**Objetivo:** Eliminar toda la orquestación manual que el LLM reemplaza.

```
BORRAR archivos:
[ ] packages/core/src/routing/capability-router.ts
[ ] packages/core/src/routing/simple-router.ts
[ ] packages/core/src/routing/types.ts
[ ] packages/core/src/routing/  (directorio vacío)
[ ] packages/core/src/registry/agent-registry.ts
[ ] packages/core/src/registry/  (directorio vacío)
[ ] packages/core/src/locks/lock-manager.ts
[ ] packages/core/src/locks/types.ts
[ ] packages/core/src/locks/  (directorio vacío)
[ ] packages/core/src/tasks/task-queue.ts
[ ] packages/core/src/tasks/types.ts
[ ] packages/core/src/tasks/  (directorio vacío)

DEPRECAR (marcar @deprecated, NO borrar — se borra en Sprint 4.1):
[ ] packages/core/src/agent/nexus-agent.ts
    → Agregar JSDoc: @deprecated Use StreamAgent instead. Will be removed in v2.0.0

CREAR (stub para que Sprint 3+ lo use):
[ ] packages/core/src/agent/stream-agent.ts
    → Exporta clase StreamAgent vacía con lifecycle: start(), stop(), dispose()

ACTUALIZAR:
[ ] packages/core/src/index.ts
    → Remover exports: CapabilityRouter, SimpleRouter, AgentRegistry, LockManager,
      TaskQueue, InMemoryTaskQueue + todos sus types
    → Agregar export: StreamAgent
[ ] packages/core/src/types/index.ts
    → Eliminar: TaskPayloadEvent, TaskResultEvent, HeartbeatEvent (si solo lo usa routing)
    → Mantener: ActionCompletedEvent, BusEvents base

TESTS:
[ ] Eliminar tests de módulos borrados:
    capability-router.test.ts, agent-registry.test.ts,
    lock-manager.test.ts, task-queue.test.ts
[ ] Actualizar tests que importaban los módulos eliminados
[ ] Verificar examples/voice-retail — ajustar imports rotos

CRITERIO DE DONE:
[ ] pnpm -r build  → sin errores TypeScript
[ ] pnpm -r test   → solo tests de módulos existentes pasan
[ ] docs/ARCHITECTURE-V2.md creado ✅ (ya existe)
```

---

### Sprint 1.2 — Safety Module + Multi-Channel Approval

**Objetivo:** Construir el corazón del nuevo modelo de seguridad.

```
CREAR packages/core/src/safety/channels/types.ts:
[ ] type SafetyLevel = 'safe' | 'staged' | 'protected' | 'restricted'
[ ] type HumanRole = 'customer' | 'staff' | 'cashier' | 'manager' | 'owner'
[ ] interface HumanProfile { id, name, role, store_id, voice_embedding?, approval_limits, is_present? }
[ ] interface ApprovalLimits { payment_max?, discount_max_pct?, refund_max?, can_override_price?, can_adjust_inventory? }
[ ] interface IApprovalChannel { id, type, notify(request, approver), waitForResponse(request, timeoutMs), cancel(requestId) }
[ ] interface ApprovalRequest { id, draft_id, action, amount?, session_id, required_role, context, timeout_ms }
[ ] interface ApprovalResponse { approved, approver_id, channel_used, reason?, timestamp }
[ ] type ApprovalStrategy = 'parallel' | 'sequential'

CREAR packages/core/src/safety/safety-guard.ts:
[ ] class SafetyGuard
[ ] evaluate(action, params, speaker, context): SafetyDecision
[ ] roleHasPermission(speaker, toolName, params): boolean
    → verifica payment_max, discount_max_pct, refund_max contra params.amount/percentage
[ ] findNearbyApprover(requiredRole, storeId): Promise<HumanProfile | null>
    → consulta bus o in-memory registry de perfiles presentes
[ ] const defaultLimits: Record<HumanRole, ApprovalLimits>

CREAR packages/core/src/safety/draft-store.ts:
[ ] interface Draft { id, session_id, intent_id, status, items, total?, ttl_seconds, history[], created_at }
[ ] class InMemoryDraftStore (para tests)
[ ] class RedisDraftStore (para producción)
[ ] create(sessionId, input): Promise<string>          → draftId
[ ] update(draftId, changes): Promise<Draft>           → guarda historial, renueva TTL
[ ] confirm(draftId): Promise<void>                    → status='confirmed'
[ ] cancel(draftId): Promise<void>                     → eliminar
[ ] rollback(draftId): Promise<Draft>                  → restaurar historial[-1]
[ ] get(draftId): Promise<Draft | null>
[ ] getBySession(sessionId): Promise<Draft | null>
[ ] TTL: auto-expira → publica bus:DRAFT_CANCELLED

CREAR packages/core/src/safety/channels/voice-channel.ts:
[ ] class VoiceApprovalChannel implements IApprovalChannel
[ ] notify(): publica bus:APPROVAL_VOICE_REQUEST con prompt_text generado
[ ] waitForResponse(): suscribe bus:SPEECH_FINAL
    → verifica speaker_id === approver esperado
    → NLU simple: detecta afirmativo/negativo en texto
    → resuelve ApprovalResponse o null (timeout)
[ ] cancel(): unsuscribe + cleanup

CREAR packages/core/src/safety/channels/webhook-channel.ts:
[ ] class WebhookApprovalChannel implements IApprovalChannel
[ ] Migrar lógica timer/timeout de InMemoryApprovalQueue
[ ] notify(): publica bus:APPROVAL_WEBHOOK_REQUEST
[ ] waitForResponse(): espera bus:APPROVAL_WEBHOOK_RESPONSE donde payload.request_id matches
[ ] cancel(): unsuscribe

CREAR packages/core/src/safety/channels/external-tool-channel.ts:
[ ] class ExternalToolChannel implements IApprovalChannel
[ ] Config: { url: string, method: 'POST' | 'GET', auth?: string }
[ ] notify(): HTTP fetch al endpoint externo con ApprovalRequest serializado
[ ] waitForResponse(): suscribe bus:APPROVAL_EXTERNAL_RESPONSE donde request_id matches
[ ] cancel(): unsuscribe

CREAR packages/core/src/safety/approval-orchestrator.ts:
[ ] class ApprovalOrchestrator
[ ] start(): suscribe bus:ORDER_PENDING_APPROVAL → llama orchestrate()
[ ] orchestrate(request): Promise<ApprovalResponse>
    → parallel: Promise.race() de todos los channels
    → sequential: await en orden, fallback si null
    → on resolve → cancela los demás channels
    → on all null → publica bus:ORDER_APPROVAL_TIMEOUT
[ ] Publica bus:APPROVAL_RESOLVED + bus:ORDER_APPROVED on success
[ ] dispose()

MANTENER packages/core/src/approval/types.ts:
[ ] Re-exportar IApprovalChannel as IApprovalQueue (backwards compat)
[ ] Re-exportar ApprovalRecord, ApprovalStatus (backwards compat)

ACTUALIZAR packages/core/src/types/index.ts — AGREGAR:
[ ] bus:APPROVAL_VOICE_REQUEST
[ ] bus:APPROVAL_WEBHOOK_REQUEST
[ ] bus:APPROVAL_EXTERNAL_REQUEST
[ ] bus:APPROVAL_EXTERNAL_RESPONSE
[ ] bus:APPROVAL_RESOLVED
[ ] bus:DRAFT_CREATED
[ ] bus:DRAFT_CONFIRMED
[ ] bus:DRAFT_CANCELLED

ACTUALIZAR packages/core/src/index.ts:
[ ] Agregar exports de safety/: SafetyGuard, DraftStore, ApprovalOrchestrator,
    IApprovalChannel, VoiceApprovalChannel, WebhookApprovalChannel, ExternalToolChannel,
    HumanRole, HumanProfile, ApprovalLimits, SafetyLevel

ACTUALIZAR packages/asynctools ToolRegistry:
[ ] Aceptar campos safety, required_role, approval_channels, approval_strategy en ToolDefinition

TESTS:
[ ] safety-guard.test.ts
    → roleHasPermission: cashier puede pagar ≤50k, no puede reembolsar
    → roleHasPermission: manager puede reembolsar ≤100k, no puede hacerlo owner
    → evaluate: retorna allowed=true para SAFE independiente del rol
[ ] draft-store.test.ts
    → create → update → confirm lifecycle
    → create → rollback → state anterior restaurado
    → TTL expiry → bus:DRAFT_CANCELLED publicado
[ ] voice-channel.test.ts (mock bus:SPEECH_FINAL)
    → notify publica APPROVAL_VOICE_REQUEST
    → waitForResponse resuelve cuando speaker correcto dice "sí"
    → waitForResponse retorna null en timeout
[ ] webhook-channel.test.ts
    → waitForResponse resuelve en bus:APPROVAL_WEBHOOK_RESPONSE
[ ] external-tool-channel.test.ts (mock fetch)
    → notify llama HTTP con payload correcto
    → waitForResponse resuelve en bus:APPROVAL_EXTERNAL_RESPONSE
[ ] approval-orchestrator.test.ts
    → parallel: primer canal en resolver gana, segundo se cancela
    → sequential: primer canal timeout → segundo canal responde
    → all timeout → APPROVAL_TIMEOUT publicado
[ ] Regression: examples/voice-retail E2E tests sin cambios

CRITERIO DE DONE:
[ ] pnpm -r build && pnpm -r test
[ ] docs/SAFETY-MODEL.md ✅ (ya existe + casos expandidos)
[ ] docs/APPROVAL-CHANNELS.md ✅ (ya existe)
[ ] docs/HUMAN-ROLES.md ✅ (ya existe)
```

---

### Sprint 1.3 — Session + Context v2

**Objetivo:** Soporte para múltiples hablantes y contexto ambient.

```
CREAR packages/core/src/session/target-group.ts:
[ ] type TargetState = 'idle' | 'targeted' | 'responding' | 'queued' | 'ambient'
[ ] class TargetGroupStateMachine
[ ] transition(speakerId, event): TargetState
[ ] getTarget(): string | null
[ ] getQueued(): string[]
[ ] setAmbient(speakerId): void

EXTENDER packages/core/src/context/in-memory-context-store.ts:
[ ] getAmbient(sessionId): Promise<AmbientContext | null>
[ ] setAmbient(sessionId, data: AmbientContext): Promise<void>
[ ] AmbientContext: { last_product_mentioned?, conversation_snippets[], timestamp }

ACTUALIZAR packages/core/src/types/index.ts — AGREGAR:
[ ] bus:SPEECH_PARTIAL   { session_id, text, confidence, speaker_id? }
[ ] bus:AMBIENT_CONTEXT  { session_id, speaker_id, text, timestamp }
[ ] bus:TARGET_DETECTED  { session_id, speaker_id, store_id }
[ ] bus:TARGET_QUEUED    { session_id, speaker_id, position }
[ ] bus:TARGET_GROUP     { session_id, speaker_ids[], primary }
[ ] bus:PROACTIVE_TRIGGER { session_id, reason, context }

TESTS:
[ ] target-group.test.ts → transitions idle→targeted, targeted→queued (segundo cliente), etc.
[ ] context-store ambient tests → setAmbient / getAmbient / persist across turns

CRITERIO DE DONE:
[ ] pnpm -r build && pnpm -r test
```

---

## Fase 2 — Dispatcher v2

### Sprint 2.1 — Speculative Cache

**Objetivo:** El dispatcher pre-ejecuta SAFE tools antes de que el LLM los pida.

```
CREAR packages/dispatcher/src/speculative-cache.ts:
[ ] class SpeculativeCache
[ ] set(sessionId, intentId, result, ttlMs): void      → SAFE tool result
[ ] setDraft(sessionId, draftId, intentId): void       → STAGED draft ref
[ ] setHint(sessionId, intentId, confidence): void     → PROTECTED/RESTRICTED hint
[ ] get(sessionId, intentId): ToolResult | DraftRef | Hint | null
[ ] getAny(sessionId): SpeculativeResult | null        → busca cualquier resultado
[ ] invalidate(sessionId): void                        → limpiar al final de turno
[ ] LRU con capacidad configurable (default 256 entries)
[ ] TTL por entrada (SAFE: 30s, STAGED: TTL del draft)

ACTUALIZAR packages/dispatcher/src/node-dispatcher.ts:
[ ] Inyectar: SafetyGuard, SpeculativeCache, DraftStore
[ ] onSpeechPartial(event):
    → classify(text) → si conf > 0.90 Y margin > 0.15:
        SAFE      → executorPool.execute(tool, params) → cache.set()
        STAGED    → draftStore.create() → cache.setDraft()
        PROTECTED → cache.setHint()
        RESTRICTED → cache.setHint()
[ ] getSpeculativeResult(sessionId, intentId?): SpeculativeResult | null

TESTS:
[ ] speculative-cache.test.ts → LRU eviction, TTL expiry, get/set/invalidate
[ ] dispatcher integration: SPEECH_PARTIAL → SAFE → cache populated
[ ] dispatcher integration: SPEECH_PARTIAL → STAGED → draft created
[ ] dispatcher integration: SPEECH_PARTIAL → RESTRICTED → hint only (no execution)

CRITERIO DE DONE:
[ ] pnpm -r build && pnpm -r test
[ ] docs/DISPATCHER-SPECULATIVE.md creado
```

---

### Sprint 2.2 — Migrar Teacher + ScoreStore

**Objetivo:** Sacar los prototipos de examples/ a packages/ como código de producción.

```
MIGRAR examples/agent-comparison/src/intent-teacher.ts
     → packages/dispatcher/src/intent-teacher.ts:
[ ] Eliminar hardcoded business logic (tienda de zapatos)
[ ] instructionPrompt: string inyectable por negocio
[ ] Redis backend para persistir correcciones entre reinicios
[ ] InMemory fallback para tests
[ ] evaluate(query, wrong, correct): 'add' | 'skip' | 'flag'
[ ] addExample(intentId, example): void → actualiza vector store en vivo

MIGRAR examples/agent-comparison/src/intent-score-store.ts
     → packages/dispatcher/src/intent-score-store.ts:
[ ] EMA (α=0.1) por intent_id
[ ] Redis backend (production) + InMemory (tests)
[ ] recordHit(intentId): void
[ ] recordCorrection(intentId): void
[ ] getScore(intentId): number (0-1)
[ ] isProduction(intentId): boolean   → score ≥ 0.70
[ ] suggestProductionSwitch(): string[] → intents con hit rate ≥ 90%

ACTUALIZAR packages/dispatcher/src/index.ts:
[ ] Exportar: IntentTeacher, IntentScoreStore, SpeculativeCache

TESTS:
[ ] intent-teacher.test.ts (mock LLM provider)
    → evaluate returns 'add' cuando la query pertenece al intent correcto
    → addExample actualiza classifier
[ ] intent-score-store.test.ts
    → EMA converge correctamente con hits sucesivos
    → isProduction = false cuando score < 0.70

CRITERIO DE DONE:
[ ] pnpm -r build && pnpm -r test
```

---

### Sprint 2.3 — BORRAR código viejo del Dispatcher

**Objetivo:** Limpiar el dispatcher de v1.

```
BORRAR:
[ ] packages/dispatcher/src/node/fallback/  (LLMFallbackAgent)
[ ] packages/dispatcher/src/node/bootstrapper/dispatcher-bootstrapper.ts
[ ] packages/dispatcher/src/node/bootstrapper/  (directorio)

ACTUALIZAR packages/dispatcher/src/index.ts:
[ ] Remover exports eliminados

ACTUALIZAR tests:
[ ] Eliminar tests de DispatcherBootstrapper, LLMFallbackAgent
[ ] Actualizar node-dispatcher.test.ts si tiene referencias eliminadas

CRITERIO DE DONE:
[ ] pnpm -r build && pnpm -r test
```

---

## Fase 3 — Interaction Agent

### Sprint 3.1 — Interaction Agent (base)

**Objetivo:** El LLM streaming con tool calling — el cerebro del sistema.

```
CREAR packages/core/src/agent/interaction-agent.ts:
[ ] class InteractionAgent
[ ] constructor({ toolRegistry, executorPool, llm, contextStore, dispatcher, ttsCallback, safetyGuard })
[ ] handleSpeechFinal(event: SpeechFinalEvent): Promise<void>
    → buildContext(sessionId) → [system, conversation_history, tool_results]
    → llm.stream({ tools, messages })
    → for await chunk:
        type='text'      → ttsCallback(chunk.text) (streaming inmediato)
        type='tool_call' → handleToolCall(chunk, sessionId, speculative)
[ ] handleToolCall(call, sessionId, speculative): Promise<ToolResult>
    → safety = toolRegistry.get(call.name).safety
    → SAFE:      cache hit? → return cached : executorPool.execute()
    → STAGED:    return {type:'draft_ready', draft, needs_confirmation:true}
    → PROTECTED: return {type:'needs_confirmation', prompt}
    → RESTRICTED: approvalOrchestrator.orchestrate() → await result
[ ] Registra HIT/CORRECTION en teacher después de cada tool_call

TESTS:
[ ] interaction-agent.test.ts (mock LLM, mock executorPool):
    → SAFE tool → llama executorPool, retorna resultado
    → SAFE con cache → retorna cached sin llamar executor
    → STAGED → retorna draft_ready, no ejecuta
    → PROTECTED → retorna needs_confirmation, no ejecuta
    → RESTRICTED → llama approvalOrchestrator, espera resultado

CRITERIO DE DONE:
[ ] pnpm -r build && pnpm -r test
```

---

### Sprint 3.2 — Draft Flow multi-turno

**Objetivo:** El cliente puede modificar su orden N veces antes de confirmar.

```
EXTENDER interaction-agent.ts:
[ ] handleDraftFlow(sessionId, draftId): void
    → Escucha siguiente turno del cliente:
        "sí/dale/confirma" → DraftStore.confirm()  → ejecutar acción real
        "no/mejor/cambia"  → DraftStore.update()   → re-presentar
        "cancela/olvídalo" → DraftStore.cancel()
[ ] TTL expiry handler: bus:DRAFT_CANCELLED → notificar cliente por TTS
[ ] Manejar ambigüedad: "mejor en azul" → detectar campo modificado + llamar update()

TESTS:
[ ] crear → confirmar
[ ] crear → modificar color → confirmar
[ ] crear → modificar N veces → cancelar
[ ] TTL expiry → notificación al cliente
[ ] multi-turno con barge-in durante presentación del draft

CRITERIO DE DONE:
[ ] pnpm -r build && pnpm -r test
```

---

### Sprint 3.3 — PROTECTED + RESTRICTED con ApprovalOrchestrator

**Objetivo:** Cerrar el loop de aprobación humana.

```
EXTENDER interaction-agent.ts:
[ ] PROTECTED flow:
    → LLM detecta needs_confirmation → genera confirmation_prompt vía TTS
    → Espera siguiente turno: afirmativo → ejecutar tool : negativo → cancelar
[ ] RESTRICTED flow:
    → LLM llama tool → SafetyGuard → ApprovalOrchestrator.orchestrate()
    → Mientras espera: TTS "un momento, esperando aprobación"
    → bus:APPROVAL_RESOLVED → LLM reanuda con resultado
    → bus:ORDER_APPROVAL_TIMEOUT → LLM informa al cliente
[ ] Suscribir bus:APPROVAL_RESOLVED por session_id

ACTUALIZAR examples/voice-retail:
[ ] Migrar ejemplos existentes a usar InteractionAgent + ApprovalOrchestrator

TESTS:
[ ] PROTECTED: cliente confirma → tool se ejecuta
[ ] PROTECTED: cliente niega → tool no se ejecuta, respuesta amigable
[ ] RESTRICTED: VoiceChannel mock → aprueba → tool ejecuta
[ ] RESTRICTED: timeout (todos los canales) → cliente informado
[ ] RESTRICTED: sequential → voz timeout → webhook responde
[ ] Regression: E2E voice-retail completo sin regresiones

CRITERIO DE DONE:
[ ] pnpm -r build && pnpm -r test
[ ] examples/voice-retail E2E 73 tests pasando
```

---

## Fase 4 — Agentes Autónomos

### Sprint 4.1 — StreamAgent + eliminar NexusAgent

**Objetivo:** Base class limpia para agentes que viven en el bus.

```
COMPLETAR packages/core/src/agent/stream-agent.ts:
[ ] abstract class StreamAgent
[ ] subscribe(channel: string, handler: BusHandler): void
[ ] unsubscribe(channel: string): void
[ ] start(): Promise<void>    → subscribe a channels configurados
[ ] stop(): Promise<void>     → unsubscribe todo
[ ] dispose(): void           → stop() + cleanup
[ ] Heartbeat configurable: publishHeartbeat(intervalMs)
[ ] abstract onEvent(channel, payload): Promise<void>

BORRAR:
[ ] packages/core/src/agent/nexus-agent.ts (deprecado en Sprint 1.1)

ACTUALIZAR packages/core/src/index.ts:
[ ] Remover NexusAgent export
[ ] StreamAgent ya exportado

ACTUALIZAR examples/voice-retail:
[ ] Reemplazar NexusAgent con StreamAgent en todos los agentes del ejemplo

TESTS:
[ ] stream-agent.test.ts
    → start() → suscripción activa
    → stop() → suscripción cancelada
    → evento en bus → onEvent() invocado

CRITERIO DE DONE:
[ ] pnpm -r build && pnpm -r test
[ ] No quedan referencias a NexusAgent en el codebase
```

---

### Sprint 4.2 — ContextBuilderAgent

```
CREAR packages/core/src/agent/context-builder-agent.ts:
[ ] class ContextBuilderAgent extends StreamAgent
[ ] Suscribe: SPEECH_FINAL, AMBIENT_CONTEXT, ACTION_COMPLETED, DRAFT_CREATED, DRAFT_CONFIRMED, DRAFT_CANCELLED
[ ] Mantiene por sesión:
    → conversation_history (últimos N turnos)
    → last_product_mentioned
    → pending_draft (si hay draft activo)
    → action_history (últimas N acciones completadas)
[ ] getEnrichedContext(sessionId): ConversationContext para InteractionAgent

TESTS:
[ ] context acumulado correctamente en multi-turno
[ ] AMBIENT_CONTEXT enriquece contexto sin generar respuesta
[ ] draft states reflejados en contexto

CRITERIO DE DONE:
[ ] pnpm -r build && pnpm -r test
```

---

### Sprint 4.3 — ProactiveAgent

```
CREAR packages/core/src/agent/proactive-agent.ts:
[ ] class ProactiveAgent extends StreamAgent
[ ] Detecta situaciones:
    → cliente sin respuesta > N segundos → PROACTIVE_TRIGGER (reason: 'idle_customer')
    → producto mencionado sin stock → PROACTIVE_TRIGGER (reason: 'out_of_stock')
    → draft expirado → PROACTIVE_TRIGGER (reason: 'draft_expired')
[ ] Emite bus:PROACTIVE_TRIGGER { session_id, reason, context }
[ ] InteractionAgent escucha y decide si hablar (evita ser intrusivo)

TESTS:
[ ] idle_customer → trigger después de timeout configurado
[ ] out_of_stock → trigger cuando tool retorna stock=0

CRITERIO DE DONE:
[ ] pnpm -r build && pnpm -r test
```

---

## Fase 5 — FitalyVoice Integration

### Sprint 5.1 — SPEECH_PARTIAL support

```
[ ] Dispatcher suscribe bus:SPEECH_PARTIAL
[ ] onSpeechPartial(event): classify → speculate (ya implementado en Sprint 2.1)
[ ] Tests: PARTIAL → speculative hit → FINAL usa cache (0ms tool wait)
[ ] pnpm -r build && pnpm -r test
```

### Sprint 5.2 — Target Group State Machine

```
[ ] Completar TargetGroupStateMachine (placeholder de Sprint 1.3)
[ ] Integrar con SessionManager:
    → TARGET_DETECTED → SessionManager.createSession() si no existe
    → TARGET_QUEUED   → SessionManager.setPriorityGroup(1)
[ ] Tests: multi-speaker transitions
[ ] pnpm -r build && pnpm -r test
```

### Sprint 5.3 — Ambient Context Pipeline

```
[ ] bus:AMBIENT_CONTEXT → ContextBuilderAgent.setAmbient()
[ ] Test: "¿los tienen en azul?" después de hablar de Nike → contexto resuelve product='Nike'
[ ] pnpm -r build && pnpm -r test
```

---

## Fase 6 — Production & Observability

### Sprint 6.1 — Langfuse Integration

```
[ ] LangfuseTracer inyectable en InteractionAgent y DispatcherV2
[ ] Trace por turno: SPEECH_FINAL → tools → LLM → TTS con latencias
[ ] Score de teacher como Langfuse score (HIT/CORRECTION)
[ ] pnpm -r build && pnpm -r test
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
