# FitalyAgents v2 — Plan Maestro

> **El LLM es el cerebro. El dispatcher es un acelerador especulativo. Los agentes son tools con safety levels.**
> Fecha: 2026-03-05

---

## 1. Cambio de Visión

### Antes (v1)
FitalyAgents era un "framework genérico de agentes asincrónicos" con NexusAgent, CapabilityRouter, AgentRegistry, TaskQueue, LockManager — orquestación compleja donde el dispatcher era el cerebro que decidía qué agente ejecutar.

### Ahora (v2)
FitalyAgents es un **framework para agentes de atención al cliente y retail con LLM streaming, tools seguros, y dispatcher especulativo**. El LLM rápido (Groq/Llama) es el cerebro. El dispatcher solo acelera pre-cargando tools SAFE antes de que el LLM los pida.

```
v1: Dispatcher → CapabilityRouter → AgentRegistry → NexusAgent → TaskQueue → LockManager
v2: Dispatcher speculate → LLM tool_call → ExecutorPool → resultado
```

La simplificación no es un recorte — es un rediseño. El SDK se vuelve más potente y más vendible.

---

## 2. Principio Arquitectónico: Tool, no Agent

### La regla
**Si el LLM lo invoca con parámetros, es un tool. Si vive solo y reacciona a eventos, es un agente autónomo.**

```
TOOLS (el LLM los llama directamente via tool_call):
├── product_search      → HTTP GET /api/products
├── product_detail      → HTTP GET /api/products/:id
├── price_check         → HTTP GET /api/prices
├── inventory_check     → HTTP GET /api/inventory
├── order_create        → HTTP POST /api/orders (draft)
├── order_confirm       → HTTP POST /api/orders/confirm
├── payment_process     → HTTP POST /api/payments
└── refund_request      → HTTP POST /api/refunds

AGENTES AUTÓNOMOS (viven en el bus, actúan solos):
├── ContextBuilderAgent → Consume TODOS los eventos, mantiene contexto
│   No es un tool. Nadie lo "llama". Siempre está escuchando.
│
├── VoiceIdentifierAgent → Detecta y registra speakers
│   No es un tool. Corre siempre en local.
│
├── VisionDetectorAgent → YOLO + depth, detecta personas
│   No es un tool. Corre siempre en local.
│
├── ProactiveAgent → Detecta situaciones y ofrece ayuda
│   No es un tool. Decide solo cuándo hablar.
│
└── ApprovalWatcher → Escucha aprobaciones de empleados
    No es un tool. Reacciona a eventos externos.
```

### Antes vs Ahora: OrderAgent

```
ANTES:
  LLM → dispatcher → bus:TASK_AVAILABLE → CapabilityRouter
  → queue:order_agent:inbox → OrderAgent.process()
  → queue:order_agent:outbox → resultCollector
  → bus:ACTION_COMPLETED → InteractionAgent

AHORA:
  LLM tool_call: order_create({items, customer})
  → ExecutorPool → POST /api/orders (OrderService)
  → resultado → LLM continúa streaming respuesta
```

OrderAgent pasa de ser un "agente autónomo con inbox" a un "servicio HTTP con API".

---

## 3. Safety Model: Clasificación de Tools por Riesgo

> Ver `DISPATCHER-V2-SAFETY.md` para flujos detallados, diagramas, y DraftStore.

Cada tool declara su nivel de riesgo. La seguridad no depende del dispatcher — depende del tool.

```
SAFE (dispatcher puede disparar speculativamente)
  → Solo lectura. Sin efectos secundarios. Cancelable sin costo.
  → Ejemplos: product_search, price_check, inventory_check, store_hours

STAGED (dispatcher puede preparar draft, NO ejecutar)
  → Crea un draft/preview. No ejecuta hasta confirmación del cliente.
  → Ejemplos: order_create → order_draft, cart_add → cart_preview

PROTECTED (solo el Interaction Agent con confirmación del cliente)
  → Modifica estado real. Requiere aprobación explícita.
  → Ejemplos: payment_process, order_confirm, account_update

RESTRICTED (requiere aprobación de empleado/sistema)
  → Alto impacto. Doble confirmación.
  → Ejemplos: bulk_discount, price_override, refund_create
```

### Manifiesto simplificado

```typescript
const tools: ToolDefinition[] = [
  {
    name: 'product_search',
    description: 'Busca productos por marca, talla, color, categoría',
    safety: 'safe',
    parameters: { brand: 'string?', size: 'number?', color: 'string?' },
    executor: { type: 'http', url: '/api/products/search' },
    timeout_ms: 5000,
  },
  {
    name: 'order_create',
    description: 'Crea una orden de compra',
    safety: 'staged',
    staged_action: 'draft',
    confirm_action: 'confirm',
    rollback_action: 'cancel',
    ttl_seconds: 300,
    parameters: { items: 'array', customer_id: 'string' },
    executor: { type: 'http', url: '/api/orders' },
    timeout_ms: 8000,
  },
  {
    name: 'payment_process',
    description: 'Procesa un pago',
    safety: 'restricted',
    approval_required: true,
    approval_channel: 'bus:ORDER_PENDING_APPROVAL',
    parameters: { order_id: 'string', amount: 'number' },
    executor: { type: 'http', url: '/api/payments' },
    timeout_ms: 30000,
  }
]
```

### Matriz de Decisión del Dispatcher

```
┌─────────────────┬──────────┬──────────┬──────────┬──────────────┐
│                 │   SAFE   │  STAGED  │ PROTECTED│  RESTRICTED  │
├─────────────────┼──────────┼──────────┼──────────┼──────────────┤
│ SPEECH_PARTIAL  │ Ejecutar │ Draft    │ NO       │ NO           │
│ conf > 0.90     │          │ only     │          │              │
├─────────────────┼──────────┼──────────┼──────────┼──────────────┤
│ SPEECH_PARTIAL  │ NO       │ NO       │ NO       │ NO           │
│ conf < 0.90     │          │          │          │              │
├─────────────────┼──────────┼──────────┼──────────┼──────────────┤
│ SPEECH_FINAL    │ Ejecutar │ Draft    │ Pedir    │ Pedir doble  │
│ via LLM tools   │ (o cache)│ (o cache)│ confirm  │ confirm      │
├─────────────────┼──────────┼──────────┼──────────┼──────────────┤
│ LLM tool_call   │ Ejecutar │ Confirmar│ Confirmar│ Approval     │
│ con confirmación│          │ draft    │ cliente  │ empleado     │
└─────────────────┴──────────┴──────────┴──────────┴──────────────┘
```

---

## 4. Roles Humanos y Aprobación Multi-Canal

> Los roles estaban en los agentes (v1). Ahora están en los **humanos**.
> El rol define **quién** puede aprobar. El canal define **cómo** llega la aprobación.

### Modelo de roles

```typescript
type HumanRole = 'customer' | 'staff' | 'cashier' | 'manager' | 'owner'

interface HumanProfile {
  id: string
  name: string
  role: HumanRole
  voice_embedding?: Float32Array   // Registrado por VoiceIdentifierAgent
  approval_limits: ApprovalLimits
}

interface ApprovalLimits {
  payment_max?: number             // cashier: 50_000 | manager: sin límite
  discount_max_pct?: number        // manager: 30 | owner: 100
  refund_max?: number              // manager: 100_000 | owner: sin límite
}

const defaultLimits: Record<HumanRole, ApprovalLimits> = {
  customer: {},
  staff:    {},
  cashier:  { payment_max: 50_000 },
  manager:  { payment_max: Infinity, discount_max_pct: 30, refund_max: 100_000 },
  owner:    { payment_max: Infinity, discount_max_pct: 100, refund_max: Infinity },
}
```

### Canales de aprobación configurables

Cada tool RESTRICTED declara qué canales usar y en qué estrategia:

```typescript
const paymentTool: ToolDefinition = {
  name: 'payment_process',
  safety: 'restricted',
  required_role: 'cashier',
  approval_channels: [
    { type: 'voice',   timeout_ms: 15_000 },  // pregunta al cajero presente
    { type: 'webhook', timeout_ms: 90_000 },  // notificación app si no está
  ],
  approval_strategy: 'parallel',  // primero que responde gana
  approval_timeout_ms: 120_000,
}
```

**Estrategias:**
- `parallel` — todos los canales a la vez, el primero en responder cancela los demás
- `sequential` — intenta voz primero; si timeout, cae al webhook/app

**Canales disponibles:**

| Canal | Notify | Listen | Caso de uso |
|---|---|---|---|
| `voice` | Fitaly habla al aprobador identificado | `bus:SPEECH_FINAL` con VoiceIdentifier | Cajero presente en tienda |
| `webhook` | Push notification a app | HTTP POST `/webhook/approval` | Gerente fuera del piso |
| `external_tool` | HTTP call a herramienta externa | `bus:APPROVAL_EXTERNAL_RESPONSE` | Integración con POS, WhatsApp |
| `vision` | Señal visual en pantalla | Gesto vía VisionDetectorAgent | Futuro Sprint |

### Escalación automática por rol

```
Cliente pide acción RESTRICTED
  → SafetyGuard: ¿el speaker tiene rol suficiente?
    → SÍ (ej: cajero pide cobro ≤ ₡50k): ejecutar directo
    → NO: ApprovalOrchestrator.orchestrate(request)
          → lanza canales configurados
          → voice: "María, ¿apruebas el cobro de ₡15,000?"
          → webhook: push a app del gerente (en paralelo)
          → primer response gana → bus:APPROVAL_RESOLVED
```

---

## 5. Pipeline Completo: Speculative Dispatch + LLM

```
SPEECH_PARTIAL llega:
    │
    └── Dispatcher speculative classify (1-10ms embedding)
        │
        ├── intent=product_search, safety=SAFE
        │   → DISPARA tools inmediatamente
        │   → Resultado va al cache speculative
        │
        ├── intent=order_create, safety=STAGED
        │   → DISPARA solo el draft (order_draft)
        │   → Draft va al cache con TTL
        │   → NO ejecuta la orden real
        │
        ├── intent=payment_process, safety=RESTRICTED
        │   → NO DISPARA NADA
        │   → Solo marca en cache: "posible payment intent"
        │   → Espera a que Interaction Agent confirme
        │
        └── confidence baja
            → NO DISPARA NADA
            → Espera SPEECH_FINAL


SPEECH_FINAL llega:
    │
    └── Interaction Agent (LLM rápido, streaming)
        │
        ├── Consulta dispatcher cache
        │   │
        │   ├── SAFE tool result en cache → usa directo (0ms tool wait)
        │   │   "Sí, tenemos Nike Air en talla 42"
        │   │
        │   ├── STAGED draft en cache → presenta al cliente
        │   │   "Tengo su orden lista: Nike Air 42, ₡15,000. ¿La confirmo?"
        │   │
        │   ├── PROTECTED/RESTRICTED intent detectado → pide confirmación
        │   │   "Para procesar el pago necesito que confirme..."
        │   │
        │   └── No hay cache → LLM llama tools normalmente
        │
        └── Tool calls del LLM alimentan al Teacher como HIT/CORRECTION
```

### Tiempos reales (medidos en agent-comparison)

```
Sin dispatcher:
  STT(150ms) → LLM Turn 1(~1800ms) → tools(300ms) → LLM Turn 2(~1800ms) → TTS(250ms)
  Total: ~4300ms, First feedback: ~4300ms

Con dispatcher (HIT):
  STT(150ms) → Dispatcher(10ms) → LLM Turn 1(~1800ms) → Tool(0ms cached) → LLM Turn 2(~1800ms) → TTS(250ms)
  Total: ~4000ms, First feedback: ~160ms (filler after dispatcher)

Con fast stack (Groq + ElevenLabs Flash):
  STT(50ms) → Dispatcher(5ms) → LLM(~100ms TTFT) → Tool(0ms) → TTS(~75ms)
  Total: ~250-450ms
```

---

## 6. Dispatcher: Acelerador Especulativo

### Cascade de Clasificación (3 niveles)

```
L1 — Keyword (1ms): regex + patrones directos
  → "P001" → product_detail | "precio" → price_check

L2 — Embedding (3-8ms): all-MiniLM-L6-v2, cosine similarity
  → "quiero ver zapatillas nike" → product_search (0.91)
  → Si L2 confiado en "none" (margin ≥ 0.08) → skip L3, ahorro 700ms

L3 — LLM Classifier (700-900ms): solo si L1+L2 no alcanzan umbral
  → "¿me puedes dar info de ese modelo?" → necesita contexto → LLM decide
```

### Self-Improving con Teacher + Score Store

```
Cada tool_call del LLM genera un outcome:

  HIT        → dispatcher y LLM eligieron el mismo tool → EMA sube
  CORRECTION → dispatcher eligió X, LLM eligió Y → EMA baja + Teacher evalúa
  MISS       → dispatcher no especuló, LLM usó tool → solo registra

Teacher (Haiku/GPT-4o-mini) evalúa CORRECTIONs:
  → Recibe: query, wrong_intent, correct_intent, existing_examples
  → Decide: add (nuevo ejemplo al embedding), skip, flag
  → Si add → embDispatcher.addExample() → vector store se actualiza en vivo

Score Store (EMA α=0.1) por tool_name:
  → Training mode: siempre especula (acumula datos)
  → Production mode: solo especula si score ≥ 0.70
  → Auto-suggest switch a production cuando hit rate ≥ 90%
```

### Teacher LLM — Configurable por Negocio

El developer provee un prompt de instrucción en lenguaje natural que describe su negocio y sus intents. **Sin nombres de tools, IDs, ni detalles técnicos.** El teacher nunca adivina por nombre.

```typescript
const teacher = new IntentTeacher({
  instructionPrompt: `
    Eres un evaluador de un asistente de tienda de zapatos/ropa.
    El sistema clasifica frases del cliente en estas categorías:
    - Buscar productos: cuando el cliente quiere ver catálogo...
    - Ver detalle de producto: cuando menciona un código o modelo...
    - Consultar precio: cuando pregunta cuánto cuesta algo...
    ...
  `,
  model: 'anthropic/claude-3.5-haiku'  // barato, rápido
})
```

---

## 7. Interaction Agent: El Cerebro LLM

El Interaction Agent es el componente central — un LLM streaming que:

1. **Recibe texto** del STT (via FitalyVoice o directo)
2. **Consulta cache** del dispatcher para tool results pre-computados
3. **Llama tools** via ExecutorPool cuando no hay cache
4. **Maneja safety**: presenta drafts, pide confirmaciones, envía approvals
5. **Streaming response** → TTS para respuesta inmediata
6. **Contexto persistente** por sesión (ContextStore)

```typescript
class InteractionAgent {
  private toolRegistry: ToolRegistry     // Registro con safety levels
  private executorPool: ExecutorPool     // Ejecución paralela, retry, timeout
  private llm: StreamingLLMClient        // Groq/OpenRouter streaming
  private contextStore: ContextStore     // Estado por sesión
  private dispatcher: DispatcherV2       // Cache speculative

  async handleSpeechFinal(event: SpeechFinalEvent) {
    // Consultar cache del dispatcher
    const cached = await this.dispatcher.getSpeculativeResult(event.session_id)

    // LLM streaming con tool calling
    const stream = await this.llm.stream({
      tools: this.toolRegistry.listForLLM(),
      messages: [...context, { role: 'user', content: event.text }],
    })

    for await (const chunk of stream) {
      if (chunk.type === 'tool_call') {
        // Interceptar: ¿ya lo tiene el dispatcher?
        const result = cached?.intent === chunk.tool_name
          ? cached.result        // 0ms — cache hit
          : await this.executorPool.execute(chunk.tool_name, chunk.arguments)

        stream.submitToolResult(chunk.call_id, result)
      }

      if (chunk.type === 'text') {
        await this.tts.feed(chunk.text)  // Streaming a TTS
      }
    }
  }
}
```

---

## 8. SDK: Estructura de Paquetes

```
packages/core/                     ← SE SIMPLIFICA
├── bus/                           # IEventBus, RedisBus, InMemoryBus
│                                  # ← SE MANTIENE, columna vertebral
│
├── session/                       # SessionManager
│   ├── session.ts                 # Multi-session, priority groups
│   ├── target-group.ts            # NUEVO: TargetGroup multi-speaker
│   └── context-store.ts           # Contexto por sesión
│                                  # ← SE MANTIENE + se extiende
│
├── safety/                        # NUEVO: Safety model
│   ├── safety-guard.ts            # Clasifica tools por riesgo (SAFE/STAGED/PROTECTED/RESTRICTED)
│   ├── draft-store.ts             # Drafts mutables con TTL y rollback
│   ├── approval-orchestrator.ts   # NUEVO: Multi-canal (reemplaza InMemoryApprovalQueue)
│   └── channels/                  # Canales de aprobación configurables
│       ├── types.ts               # IApprovalChannel, HumanRole, ApprovalStrategy
│       ├── voice-channel.ts       # Aprobación por voz (VoiceIdentifierAgent)
│       ├── webhook-channel.ts     # HTTP webhook (migra InMemoryApprovalQueue)
│       └── external-tool-channel.ts # Herramienta externa vía HTTP/bus
│                                  # ← NUEVO módulo central
│
├── audio/                         # AudioQueueService
│   ├── audio-queue.ts             # Queue + barge-in
│   └── filler-manager.ts          # Fillers pre-generados
│                                  # ← SE MANTIENE
│
├── agent/                         # Base classes simplificadas
│   ├── stream-agent.ts            # NUEVO: para servicios siempre activos (reemplaza NexusAgent)
│   └── types.ts                   # AgentManifest simplificado
│                                  # ← NexusAgent se reemplaza
│
└── types/                         # Schemas Zod de todos los eventos
                                   # ← SE MANTIENE + nuevos eventos


packages/asynctools/               ← SE MANTIENE 100%, más relevante que nunca
├── tool-registry.ts               # Registro de tools con safety level
├── executor-pool.ts               # Ejecución paralela, retry, timeout
├── injection-manager.ts           # Para tools async que necesitan re-inyección
└── async-agent.ts                 # Wrapper LLM con tool calling


packages/dispatcher/               ← SE SIMPLIFICA, se convierte en acelerador
├── embedding-classifier.ts        # Clasificación speculative (all-MiniLM-L6-v2)
├── speculative-cache.ts           # Cache de resultados pre-computados
├── intent-teacher.ts              # Auto-mejora con correcciones via LLM
├── score-store.ts                 # Tracking accuracy con EMA
└── intent-library.ts              # Ejemplos en Redis / JSON (crece con teacher)
```

### Qué se elimina

```
ELIMINADOS de core:
├── routing/capability-router.ts   # LLM hace el routing via tool_call
├── routing/simple-router.ts       # Ya no hay routing manual
├── registry/agent-registry.ts     # Tools se registran en ToolRegistry
├── locks/lock-manager.ts          # Simplificado a DraftStore locks
├── tasks/task-queue.ts            # LLM maneja secuencia de tools
└── agent/nexus-agent.ts           # Reemplazado por stream-agent.ts

ELIMINADOS de dispatcher:
├── node/fallback/                 # Interaction Agent = fallback
└── node/bootstrapper/             # Simplificado a init directa
```

---

## 9. Bus Redis: Canales v2

El bus se expande con nuevos eventos, pero se simplifican los canales de routing.

```
ELIMINADOS (el LLM reemplaza el routing):
  bus:TASK_AVAILABLE
  bus:DISPATCH_FALLBACK
  bus:INTENT_UPDATED
  queue:*:inbox / queue:*:outbox

SE MANTIENEN:
  bus:SPEECH_FINAL          → Interaction Agent
  bus:ACTION_COMPLETED      → ContextBuilderAgent, UI

NUEVOS:
  bus:SPEECH_PARTIAL        → Dispatcher speculative (desde FitalyVoice)
  bus:AMBIENT_CONTEXT       → ContextBuilderAgent (conversación no dirigida al agente)
  bus:TARGET_DETECTED       → SessionManager (nuevo cliente detectado)
  bus:TARGET_QUEUED         → SessionManager (cliente en espera)
  bus:TARGET_GROUP          → SessionManager (grupo de clientes juntos)
  bus:PROACTIVE_TRIGGER     → ProactiveAgent (ofrece ayuda proactiva)
  bus:DRAFT_CREATED         → ContextBuilderAgent, UI (draft visible)
  bus:DRAFT_CONFIRMED       → OrderService (ejecutar orden real)
  bus:DRAFT_CANCELLED       → Limpieza
  bus:ORDER_PENDING_APPROVAL → ApprovalWatcher (empleado debe aprobar)
  bus:ORDER_APPROVED        → Interaction Agent (informar al cliente)
```

---

## 10. FitalyVoice: Pipeline de Audio

> Ver `PLAN-FITALYVOICE.md` para especificación completa.

FitalyVoice es un pipeline Python que resuelve el problema de audio ruidoso en tiendas con múltiples personas hablando.

```
Micrófono → FitalyCloud (pyannote + Deepgram)
         → speaker_identified → TargetGroupStateMachine
         → TARGET → bus:SPEECH_FINAL (Interaction Agent)
         → AMBIENT → bus:AMBIENT_CONTEXT (solo contexto, no procesa)
```

**Integración con v2:**
- SPEECH_PARTIAL → dispatcher speculative (comienza antes de que el cliente termine de hablar)
- SPEECH_FINAL → Interaction Agent (LLM streaming)
- AMBIENT_CONTEXT → ContextBuilderAgent (enriquece contexto sin generar respuesta)

---

## 11. Modos: Training → Production

### Training Mode
- **Dispatcher**: especula siempre (acumula datos)
- **LLM**: modelo pesado (Sonnet/Opus) para máxima calidad de clasificación
- **Teacher**: evalúa cada CORRECTION, agrega ejemplos al embedding
- **Score Store**: acumula EMA scores por tool

### Production Mode
- **Dispatcher**: solo especula tools con score ≥ 0.70
- **LLM**: modelo rápido (Groq Llama 3.1 8B, ~80ms TTFT)
- **Teacher**: sigue evaluando pero con menor frecuencia
- **Auto-switch**: cuando hit rate ≥ 90%, el sistema sugiere cambiar a production

```
Training:   Sonnet + always speculate → datos de calidad → teacher aprende
Production: Groq + selective speculate → velocidad máxima → 250-450ms total
```

---

## 12. Sprints de Implementación

### Fase 0 — Lo que ya existe (COMPLETO)
- [x] `packages/asynctools` — ToolRegistry, ExecutorPool, InjectionManager, AsyncAgent (325 tests)
- [x] `packages/core` — Bus, Session, Context, Approval, Audio, NexusAgent
- [x] `packages/dispatcher` — EmbeddingClassifier, IntentLibrary, LLMFallbackAgent
- [x] `examples/agent-comparison` — benchmark de 3 pipelines, dispatcher speculative con teacher

### Fase 1 — Simplificación de Core
**Objetivo:** Eliminar código v1 obsoleto, agregar módulos v2.

- [ ] **Sprint 1.1 — Limpieza**
  - [ ] Eliminar `packages/core/src/routing/capability-router.ts`
  - [ ] Eliminar `packages/core/src/routing/simple-router.ts`
  - [ ] Eliminar `packages/core/src/routing/types.ts`
  - [ ] Eliminar `packages/core/src/registry/agent-registry.ts`
  - [ ] Eliminar `packages/core/src/locks/lock-manager.ts`
  - [ ] Eliminar `packages/core/src/locks/types.ts`
  - [ ] Eliminar `packages/core/src/tasks/task-queue.ts`
  - [ ] Eliminar `packages/core/src/tasks/types.ts`
  - [ ] Crear `packages/core/src/agent/stream-agent.ts` (reemplaza nexus-agent: subscribe a bus channels, no inbox/outbox)
  - [ ] Deprecar `packages/core/src/agent/nexus-agent.ts` (marcar, no eliminar hasta Sprint 4.1)
  - [ ] Actualizar `packages/core/src/index.ts` — remover exports eliminados
  - [ ] Eliminar/actualizar tests afectados en `packages/core/src/**/*.test.ts`
  - [ ] `pnpm -r build` sin errores
  - [ ] `pnpm -r test` sin fallos en tests restantes
  - [ ] Crear `docs/ARCHITECTURE-V2.md` — visión v2 con diagrama de capas

- [ ] **Sprint 1.2 — Safety Module + Multi-Channel Approval**
  - [ ] Crear `packages/core/src/safety/safety-guard.ts`
    - `SafetyLevel: 'safe' | 'staged' | 'protected' | 'restricted'`
    - `SafetyGuard.evaluate(action, params, speaker, context): SafetyDecision`
    - `roleHasPermission(role, action, params): boolean`
    - `findNearbyApprover(requiredRole, storeId): Promise<HumanProfile | null>`
  - [ ] Crear `packages/core/src/safety/draft-store.ts`
    - `create(sessionId, draft): Promise<string>`
    - `update(draftId, changes): Promise<Draft>`
    - `confirm(draftId): Promise<Order>`
    - `cancel(draftId): Promise<void>`
    - `rollback(draftId): Promise<Draft>`
    - TTL automático en Redis, fallback InMemory para tests
  - [ ] Crear `packages/core/src/safety/channels/types.ts`
    - `IApprovalChannel` interface: `notify`, `waitForResponse`, `cancel`
    - `ApprovalRequest`, `ApprovalResponse` types
    - `HumanRole`, `HumanProfile`, `ApprovalLimits` types
    - `ApprovalStrategy: 'parallel' | 'sequential'`
  - [ ] Crear `packages/core/src/safety/channels/voice-channel.ts`
    - `notify()`: publica `bus:APPROVAL_VOICE_REQUEST` → AudioQueueService
    - `waitForResponse()`: suscribe `bus:SPEECH_FINAL`, verifica speaker + NLU yes/no
    - `cancel()`: unsuscribe + cleanup
  - [ ] Crear `packages/core/src/safety/channels/webhook-channel.ts`
    - Migrar lógica de `approval/in-memory-approval-queue.ts`
    - `notify()`: publica `bus:APPROVAL_WEBHOOK_REQUEST`
    - `waitForResponse()`: espera `bus:APPROVAL_WEBHOOK_RESPONSE`
  - [ ] Crear `packages/core/src/safety/channels/external-tool-channel.ts`
    - Config: `{ url: string, method: 'POST' | 'GET', auth?: string }`
    - `notify()`: HTTP call a herramienta externa
    - `waitForResponse()`: suscribe `bus:APPROVAL_EXTERNAL_RESPONSE`
  - [ ] Crear `packages/core/src/safety/approval-orchestrator.ts`
    - `start()`: suscribe `bus:ORDER_PENDING_APPROVAL`
    - `orchestrate(request)`: parallel o sequential según config
    - Primer canal en responder → cancela los demás → publica `bus:ORDER_APPROVED`
    - Timeout global → `bus:ORDER_APPROVAL_TIMEOUT`
  - [ ] Mantener `packages/core/src/approval/types.ts` como re-export (backwards compat)
  - [ ] Agregar nuevos bus events a `packages/core/src/types/index.ts`:
    - `bus:APPROVAL_VOICE_REQUEST`, `bus:APPROVAL_WEBHOOK_REQUEST`
    - `bus:APPROVAL_EXTERNAL_REQUEST`, `bus:APPROVAL_EXTERNAL_RESPONSE`
    - `bus:APPROVAL_RESOLVED` (incluye `channel_used`)
  - [ ] Actualizar `packages/core/src/index.ts` con nuevos exports de `safety/`
  - [ ] Extender `ToolRegistry` en asynctools: aceptar `safety`, `required_role`, `approval_channels`
  - [ ] Tests: `safety-guard.test.ts`
  - [ ] Tests: `draft-store.test.ts`
  - [ ] Tests: `voice-channel.test.ts` (mock `bus:SPEECH_FINAL`)
  - [ ] Tests: `webhook-channel.test.ts`
  - [ ] Tests: `external-tool-channel.test.ts` (mock HTTP)
  - [ ] Tests: `approval-orchestrator.test.ts` (parallel + sequential strategies)
  - [ ] Regression: `examples/voice-retail` E2E tests siguen pasando
  - [ ] `pnpm -r build && pnpm -r test`
  - [ ] Crear `docs/SAFETY-MODEL.md`
  - [ ] Crear `docs/APPROVAL-CHANNELS.md`
  - [ ] Crear `docs/HUMAN-ROLES.md`

- [ ] **Sprint 1.3 — Session + Context v2**
  - [ ] Crear `packages/core/src/session/target-group.ts`
    - `TargetGroup`: multi-speaker state machine (TARGET / AMBIENT / QUEUED)
    - Events: `TARGET_DETECTED`, `TARGET_QUEUED`, `TARGET_GROUP`
  - [ ] Extender `packages/core/src/context/in-memory-context-store.ts` con ambient context
    - `getAmbient(sessionId): Promise<AmbientContext>`
    - `setAmbient(sessionId, data): Promise<void>`
  - [ ] Agregar tipos para nuevos bus events en `packages/core/src/types/index.ts`:
    - `bus:SPEECH_PARTIAL`, `bus:AMBIENT_CONTEXT`
    - `bus:TARGET_DETECTED`, `bus:TARGET_QUEUED`, `bus:TARGET_GROUP`
    - `bus:DRAFT_CREATED`, `bus:DRAFT_CONFIRMED`, `bus:DRAFT_CANCELLED`
  - [ ] Tests para TargetGroup state machine
  - [ ] `pnpm -r build && pnpm -r test`

### Fase 2 — Dispatcher v2
**Objetivo:** Convertir dispatcher de "cerebro" a "acelerador especulativo".

- [ ] **Sprint 2.1 — Speculative Cache**
  - [ ] Crear `packages/dispatcher/src/speculative-cache.ts`
    - `set(sessionId, intentId, result, ttlMs)` para SAFE tool results
    - `setDraft(sessionId, draftRef)` para STAGED
    - `setHint(sessionId, intent, confidence)` para PROTECTED/RESTRICTED
    - `get(sessionId, intentId): ToolResult | DraftRef | Hint | null`
    - LRU con capacidad configurable (default 256 entries)
  - [ ] Integrar SafetyGuard en `packages/dispatcher/src/node-dispatcher.ts`
    - `safe` → ejecuta tool y guarda en SpeculativeCache
    - `staged` → crea draft en DraftStore + referencia en cache
    - `protected` / `restricted` → solo `setHint`
  - [ ] Agregar método `getSpeculativeResult(sessionId): SpeculativeResult | null`
  - [ ] Tests: `speculative-cache.test.ts`
  - [ ] Tests: dispatcher integration con safety levels (mock SafetyGuard)
  - [ ] `pnpm -r build && pnpm -r test`
  - [ ] Crear `docs/DISPATCHER-SPECULATIVE.md`

- [ ] **Sprint 2.2 — Migrar Teacher + ScoreStore**
  - [ ] Migrar `examples/agent-comparison/src/intent-teacher.ts`
    → `packages/dispatcher/src/intent-teacher.ts`
    - Hacer `instructionPrompt` inyectable (sin business logic hardcoded)
    - Redis backend para persistencia de correcciones
  - [ ] Migrar `examples/agent-comparison/src/intent-score-store.ts`
    → `packages/dispatcher/src/intent-score-store.ts`
    - Redis backend (production) + InMemory fallback (tests)
  - [ ] Actualizar `packages/dispatcher/src/index.ts` con nuevos exports
  - [ ] Tests: `intent-teacher.test.ts` (mock LLM)
  - [ ] Tests: `intent-score-store.test.ts`
  - [ ] `pnpm -r build && pnpm -r test`

- [ ] **Sprint 2.3 — Eliminar Código Viejo del Dispatcher**
  - [ ] Eliminar `packages/dispatcher/src/node/fallback/` (llm-fallback-agent)
  - [ ] Eliminar `packages/dispatcher/src/node/bootstrapper/dispatcher-bootstrapper.ts`
  - [ ] Actualizar `packages/dispatcher/src/node-dispatcher.ts` con API speculative
  - [ ] Actualizar `packages/dispatcher/src/index.ts` — remover exports eliminados
  - [ ] Actualizar tests afectados
  - [ ] `pnpm -r build && pnpm -r test`

### Fase 3 — Interaction Agent
**Objetivo:** El componente cerebro — LLM streaming con tool calling.

- [ ] **Sprint 3.1 — Interaction Agent Base**
  - [ ] Crear `packages/core/src/agent/interaction-agent.ts`
    - Constructor: `{ toolRegistry, executorPool, llm, contextStore, dispatcher, ttsCallback }`
    - `handleSpeechFinal(event: SpeechFinalEvent): Promise<void>`
    - Consultar `dispatcher.getSpeculativeResult()` antes de llamar tools
    - Interceptar `tool_call` del LLM: verificar SafetyGuard antes de ejecutar
    - Streaming response → `ttsCallback(chunk)` para respuesta inmediata
    - Contexto persistente via `ContextStore`
  - [ ] Tests: `interaction-agent.test.ts` con mock LLM + mock tools
  - [ ] `pnpm -r build && pnpm -r test`

- [ ] **Sprint 3.2 — Draft Flow multi-turno**
  - [ ] Implementar STAGED flow completo en InteractionAgent:
    - `draft_ready` → presentar resumen al cliente
    - Cliente confirma → `DraftStore.confirm(draftId)` → ejecutar acción real
    - Cliente modifica → `DraftStore.update(draftId, changes)` → re-presentar
    - Cliente cancela → `DraftStore.cancel(draftId)`
  - [ ] TTL auto-cleanup: draft expira → InteractionAgent notifica al cliente
  - [ ] Tests multi-turno: crear → modificar → confirmar
  - [ ] Tests multi-turno: crear → modificar × N → cancelar
  - [ ] Tests: TTL expiry notification
  - [ ] `pnpm -r build && pnpm -r test`

- [ ] **Sprint 3.3 — PROTECTED + RESTRICTED Flows con ApprovalOrchestrator**
  - [ ] PROTECTED: InteractionAgent genera confirmation prompt antes de ejecutar
    - Tool result `needs_confirmation` → LLM pregunta al cliente
    - Cliente confirma → ejecutar tool directamente
  - [ ] RESTRICTED: InteractionAgent llama `ApprovalOrchestrator.orchestrate()`
    - Canales configurados (voice + webhook en parallel)
    - Mientras espera: InteractionAgent informa al cliente que está procesando
    - `bus:APPROVAL_RESOLVED` → InteractionAgent notifica resultado
  - [ ] Tests: PROTECTED confirmation flow (mock client response)
  - [ ] Tests: RESTRICTED con VoiceChannel mock (resolve inmediato)
  - [ ] Tests: RESTRICTED con timeout → fallback webhook
  - [ ] Regression: E2E voice-retail tests
  - [ ] `pnpm -r build && pnpm -r test`

### Fase 4 — Agentes Autónomos
**Objetivo:** Servicios que viven en el bus sin ser invocados por el LLM.

- [ ] **Sprint 4.1 — StreamAgent Base Class**
  - [ ] Crear `packages/core/src/agent/stream-agent.ts` (finalizar placeholder de Sprint 1.1)
    - `subscribe(channel, handler)` — sin inbox/outbox, reacciona a bus events
    - Lifecycle: `start()`, `stop()`, `dispose()`
    - Health monitoring: heartbeat configurable
    - `StreamAgent` reemplaza completamente `NexusAgent`
  - [ ] Eliminar `packages/core/src/agent/nexus-agent.ts` (deprecado en Sprint 1.1)
  - [ ] Actualizar `examples/voice-retail` para usar `StreamAgent`
  - [ ] Tests: `stream-agent.test.ts`
  - [ ] `pnpm -r build && pnpm -r test`

- [ ] **Sprint 4.2 — ContextBuilderAgent**
  - [ ] Crear `ContextBuilderAgent extends StreamAgent`
    - Suscribe: `SPEECH_FINAL`, `AMBIENT_CONTEXT`, `ACTION_COMPLETED`, `DRAFT_*`
    - Mantiene resumen de conversación + historial por sesión en `ContextStore`
    - Sirve contexto enriquecido al `InteractionAgent`
  - [ ] Tests: `context-builder-agent.test.ts`
  - [ ] `pnpm -r build && pnpm -r test`

- [ ] **Sprint 4.3 — ProactiveAgent**
  - [ ] Crear `ProactiveAgent extends StreamAgent`
    - Detecta: cliente esperando > N segundos, producto agotado, oferta relevante
    - Emite `bus:PROACTIVE_TRIGGER` → InteractionAgent decide si hablar
  - [ ] Tests: `proactive-agent.test.ts`
  - [ ] `pnpm -r build && pnpm -r test`

### Fase 5 — FitalyVoice Integration
**Objetivo:** Pipeline de audio con speaker identification.

> Ver `PLAN-FITALYVOICE.md` para especificación completa del pipeline Python.

- [ ] **Sprint 5.1 — SPEECH_PARTIAL Support**
  - [ ] Dispatcher suscribe `bus:SPEECH_PARTIAL`
  - [ ] `onSpeechPartial(event)` → classify → si conf > 0.90 → `SpeculativeCache`
  - [ ] Tests: partial → cache hit en SPEECH_FINAL
  - [ ] `pnpm -r build && pnpm -r test`

- [ ] **Sprint 5.2 — Target Group State Machine**
  - [ ] Finalizar `packages/core/src/session/target-group.ts` (placeholder de Sprint 1.3)
    - `TargetGroupStateMachine`: TARGET / AMBIENT / QUEUED states
    - Priority queue para múltiples clientes simultáneos
  - [ ] Integrar con `SessionManager`
  - [ ] Tests: state machine transitions
  - [ ] `pnpm -r build && pnpm -r test`

- [ ] **Sprint 5.3 — Ambient Context Pipeline**
  - [ ] `bus:AMBIENT_CONTEXT` → `ContextBuilderAgent` actualiza contexto sin responder
  - [ ] Verificar: "¿los tienen en azul?" resuelve correctamente el producto anterior del TARGET
  - [ ] Tests: ambient enrichment
  - [ ] `pnpm -r build && pnpm -r test`

### Fase 6 — Production & Observability
- [ ] **Sprint 6.1 — Langfuse Integration**
  - [ ] Agregar `LangfuseTracer` al `InteractionAgent` y `DispatcherV2`
  - [ ] Trace por sesión: STT → dispatch → LLM → tools → TTS con latencias
  - [ ] Score de teacher (HIT / CORRECTION) como Langfuse score
- [ ] **Sprint 6.2 — FitalyInsights Dashboard**
  - [ ] Frontend propio sobre Langfuse API (lenguaje de negocio, no técnico)
  - [ ] Métricas: preguntas frecuentes, gaps de training, tasa de conversión
  - [ ] Comparación entre locales (cadenas)
- [ ] **Sprint 6.3 — Hardening**
  - [ ] Rate limiting para APIs externas
  - [ ] Circuit breakers por tool (auto-disable si falla N veces)
  - [ ] `pnpm -r build && pnpm -r test`
- [ ] Crear `docs/FITALYSTORE-PRODUCT.md` con tiers, FitalyCloud, FitalyInsights

---

## 13. Lo que YA NO Necesitas (el LLM lo reemplazó)

| Componente v1 | Por qué sobra | Reemplazado por |
|---|---|---|
| `CapabilityRouter` (7 pasos) | LLM decide qué tool llamar via tool_call nativo | LLM + ToolRegistry |
| `AgentManifest` complejo (domain, scope, capabilities, context_access) | Solo necesario para CapabilityRouter automático | `ToolDefinition` con nombre, descripción, safety |
| `AgentRegistry` | Registraba NexusAgents por manifiesto | `ToolRegistry` (ya existe en asynctools) |
| `LLMFallbackAgent` como proceso separado | Interaction Agent con LLM streaming = fallback | Interaction Agent |
| `TaskQueue` con `depends_on` chains | LLM maneja secuencia de tools naturalmente | LLM tool calling |
| `LockManager` | LLM no tiene race conditions consigo mismo | DraftStore (solo para drafts concurrentes) |
| `NexusAgent` con inbox/outbox pattern | Los agentes de negocio son tools HTTP | StreamAgent para autónomos, HTTP para tools |
| `queue:*:inbox` / `queue:*:outbox` | El LLM llama tools directamente | ExecutorPool |

## 14. Lo que SÍ Necesitas (más que antes)

| Componente | Estado | Prioridad |
|---|---|---|
| `ExecutorPool` + `ToolRegistry` | ✅ Existe en asynctools | Expandir con safety levels |
| `Bus Redis` (pub/sub cross-language) | ✅ Existe en core | Expandir con nuevos canales |
| `SessionManager` (multi-target, priority) | ✅ Existe en core | Expandir con TargetGroup |
| `ContextStore` | ✅ Existe en core | Expandir con ambient context |
| `ApprovalQueue` | ✅ Existe en core | Mover a safety/ |
| `AudioQueueService` (fillers, barge-in) | ✅ Existe en core | Mantener |
| `SafetyGuard` | ❌ Nuevo | Sprint 1.2 |
| `DraftStore` (mutables, TTL, rollback) | ❌ Nuevo | Sprint 1.2 |
| `ApprovalOrchestrator` (multi-canal) | ❌ Nuevo | Sprint 1.2 |
| `IApprovalChannel` (voice/webhook/external) | ❌ Nuevo | Sprint 1.2 |
| `HumanRole` / `HumanProfile` | ❌ Nuevo | Sprint 1.2 |
| `SpeculativeCache` | ❌ Nuevo (prototype en example) | Sprint 2.1 |
| `IntentTeacher` | ✅ Prototype en example | Sprint 2.2 — migrar a package |
| `IntentScoreStore` | ✅ Prototype en example | Sprint 2.2 — migrar a package |
| `StreamAgent` base class | ❌ Nuevo | Sprint 4.1 |
| `InteractionAgent` | ❌ Nuevo (prototype pattern en example) | Sprint 3.1 |

---

## 15. Ventaja Competitiva

```
El SDK resuelve los problemas difíciles que nadie más integra en un solo framework:

1. Speculative dispatch      — pre-ejecuta tools antes de que el LLM los pida
2. Safety model              — SAFE/STAGED/PROTECTED/RESTRICTED en tools
3. Self-improving            — Teacher LLM + Score Store mejoran con cada query
4. Multi-speaker awareness   — sabe quién habla y solo responde al TARGET
5. Ambient context           — escucha todo, entiende más, responde solo cuando toca
6. Streaming E2E             — STT partial → dispatch → LLM stream → TTS stream
7. Draft lifecycle           — crear/modificar/confirmar/cancelar sin efectos secundarios
8. Human-in-the-loop         — multi-canal configurable: voz, webhook, herramienta externa
9. Human role model          — staff/cashier/manager/owner con límites de aprobación
10. Approval orchestration   — parallel/sequential channels, primero en responder gana
```

---

## Archivos de Referencia

- `plans/DISPATCHER-V2-SAFETY.md` — Safety model detallado, flujos, DraftStore, código
- `plans/PLAN-FITALYVOICE.md` — Pipeline de audio, speaker identification, TargetGroup
- `examples/agent-comparison/` — Prototype funcional de dispatcher speculative + teacher
- `docs/ARCHITECTURE-V2.md` — Visión v2 con diagramas de capas (crear en Sprint 1.1)
- `docs/SAFETY-MODEL.md` — Safety levels + DraftStore + ApprovalOrchestrator (crear en Sprint 1.2)
- `docs/APPROVAL-CHANNELS.md` — Multi-canal configurable (crear en Sprint 1.2)
- `docs/HUMAN-ROLES.md` — Modelo de roles humanos (crear en Sprint 1.2)
- `docs/FITALYSTORE-PRODUCT.md` — Visión de producto, tiers, FitalyCloud (crear en Sprint 6.x)
