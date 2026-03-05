# FitalyAgents v2 — Arquitectura

> Fecha: 2026-03-05
> El LLM es el cerebro. El dispatcher es un acelerador especulativo. Los agentes son servicios en el bus.

---

## Principio Central

```
v1: Dispatcher → CapabilityRouter → AgentRegistry → NexusAgent → TaskQueue → LockManager
v2: Dispatcher speculate → LLM tool_call → ExecutorPool → resultado
```

La simplificación no es un recorte — es un rediseño. El LLM moderno (Groq Llama 3.1 8B, ~80ms TTFT) hace mejor el routing que cualquier grafo de agentes manual.

---

## Diagrama de Capas

```
┌─────────────────────────────────────────────────────────────────┐
│  CAPA DE AUDIO (FitalyVoice — Python, proceso separado)          │
│  Micrófono → Deepgram STT → pyannote diarización                 │
│  → TargetGroupStateMachine → bus:SPEECH_PARTIAL / SPEECH_FINAL  │
└───────────────────────────────────┬─────────────────────────────┘
                                    │ Redis Bus
┌───────────────────────────────────▼─────────────────────────────┐
│  CAPA DE DISPATCH (packages/dispatcher)                          │
│                                                                  │
│  SPEECH_PARTIAL → EmbeddingClassifier (3-8ms)                   │
│    → conf > 0.90 + safety=SAFE  → ExecutorPool → SpeculativeCache│
│    → conf > 0.90 + safety=STAGED → DraftStore  → SpeculativeCache│
│    → conf > 0.90 + safety=PROTECTED/RESTRICTED → hint solo       │
│    → conf < 0.90 → esperar SPEECH_FINAL                         │
│                                                                  │
│  Teacher + ScoreStore: cada tool_call del LLM mejora el modelo  │
└───────────────────────────────────┬─────────────────────────────┘
                                    │
┌───────────────────────────────────▼─────────────────────────────┐
│  CAPA DE INTERACCIÓN (packages/core/src/agent/interaction-agent) │
│                                                                  │
│  SPEECH_FINAL → InteractionAgent                                 │
│    1. Consultar SpeculativeCache (tool results pre-computados)   │
│    2. LLM streaming con tool calling                             │
│    3. tool_call interceptado por SafetyGuard:                    │
│       SAFE      → ExecutorPool (o cache HIT → 0ms)              │
│       STAGED    → DraftStore → presentar al cliente             │
│       PROTECTED → confirmation prompt → cliente confirma → exec  │
│       RESTRICTED → ApprovalOrchestrator → canal(es) configurados│
│    4. Streaming text → ttsCallback → TTS → audio                │
└───────────────────────────────────┬─────────────────────────────┘
                                    │
┌───────────────────────────────────▼─────────────────────────────┐
│  CAPA DE SAFETY (packages/core/src/safety/)                      │
│                                                                  │
│  SafetyGuard     → clasifica tools, verifica roles humanos       │
│  DraftStore      → drafts mutables con TTL, historial, rollback  │
│  ApprovalOrchestrator → coordina canales en parallel/sequential  │
│    VoiceApprovalChannel   → pregunta al empleado por voz         │
│    WebhookApprovalChannel → push notification a app             │
│    ExternalToolChannel    → herramienta externa vía HTTP/bus     │
└───────────────────────────────────┬─────────────────────────────┘
                                    │
┌───────────────────────────────────▼─────────────────────────────┐
│  CAPA DE TOOLS (packages/asynctools)                             │
│                                                                  │
│  ToolRegistry   → registra tools con safety level y rol requerido│
│  ExecutorPool   → ejecución paralela, retry, timeout             │
│  HTTP executors → product_search, price_check, order_create...   │
└───────────────────────────────────┬─────────────────────────────┘
                                    │
┌───────────────────────────────────▼─────────────────────────────┐
│  CAPA DE INFRAESTRUCTURA (packages/core)                         │
│                                                                  │
│  Bus (Redis/InMemory)  → pub/sub cross-language, cross-process   │
│  SessionManager        → multi-sesión, priority groups, TARGET   │
│  ContextStore          → estado por sesión + ambient context     │
│  AudioQueueService     → cola de audio, barge-in, fillers        │
└─────────────────────────────────────────────────────────────────┘
```

---

## Tools vs Agentes Autónomos

**Regla:** Si el LLM lo invoca con parámetros → es un tool. Si vive solo y reacciona a eventos → es un agente autónomo.

### Tools (el LLM los llama via tool_call)

```
SAFE (dispatcher puede pre-ejecutar):
  product_search    → HTTP GET /api/products
  price_check       → HTTP GET /api/prices
  inventory_check   → HTTP GET /api/inventory
  store_hours       → HTTP GET /api/hours

STAGED (dispatcher puede crear draft):
  order_create      → HTTP POST /api/orders/draft
  cart_add          → HTTP POST /api/cart/preview

PROTECTED (solo con confirmación explícita del cliente):
  payment_process   → HTTP POST /api/payments
  order_confirm     → HTTP POST /api/orders/confirm

RESTRICTED (requiere aprobación de empleado con rol suficiente):
  refund_create     → HTTP POST /api/refunds
  price_override    → HTTP PATCH /api/products/:id/price
  bulk_discount     → HTTP POST /api/discounts
```

### Agentes Autónomos (StreamAgent, viven en el bus)

```
ContextBuilderAgent   → consume SPEECH_FINAL + AMBIENT_CONTEXT + ACTION_COMPLETED
                        mantiene contexto rico por sesión para el InteractionAgent

VoiceIdentifierAgent  → detecta y registra speakers
                        publica speaker_id + role en cada SPEECH_FINAL

VisionDetectorAgent   → YOLO + depth, detecta presencia de personas
                        publica TARGET_DETECTED cuando alguien se acerca

ProactiveAgent        → detecta situaciones (espera, producto agotado)
                        emite PROACTIVE_TRIGGER → InteractionAgent decide cuándo hablar

ApprovalWatcher       → escucha APPROVAL_RESOLVED
                        informa a InteractionAgent el resultado de cada aprobación
```

---

## Flujo E2E completo

```
t=0ms    Cliente: "quiero ver zapatos nike talla 42"
         └── FitalyVoice detecta TARGET, STT parcial → bus:SPEECH_PARTIAL

t=10ms   Dispatcher: EmbeddingClassifier → product_search (0.91, margin 0.18)
         └── safety=SAFE → ExecutorPool.execute('product_search', {brand:'nike', size:42})

t=310ms  Tool retorna: [{Nike Air Max, ₡15k, talla 42}, ...]
         └── SpeculativeCache.set(session, 'product_search', result, ttl=30s)

t=500ms  STT final → bus:SPEECH_FINAL
         └── InteractionAgent recibe evento

t=510ms  InteractionAgent: consulta cache → HIT
         └── LLM recibe: user_text + tool_result_preloaded
         └── LLM: "¡Claro! Tenemos Nike Air Max en talla 42, ₡15,000. ¿Le interesa?"
         └── Streaming → TTS → audio

t=560ms  Primera sílaba de respuesta al cliente
         Total: 560ms (sin dispatcher hubiera sido ~1900ms)
```

---

## Paquetes y Responsabilidades

| Paquete | Responsabilidad | Estado v2 |
|---|---|---|
| `packages/asynctools` | ToolRegistry, ExecutorPool, InjectionManager, AsyncAgent | Mantener + extender safety |
| `packages/core/bus` | IEventBus, RedisBus, InMemoryBus | Mantener + nuevos eventos |
| `packages/core/session` | SessionManager, TargetGroup | Extender con multi-speaker |
| `packages/core/context` | ContextStore con ambient | Extender |
| `packages/core/safety` | SafetyGuard, DraftStore, ApprovalOrchestrator, Channels | NUEVO |
| `packages/core/agent` | StreamAgent, InteractionAgent | NUEVO (NexusAgent eliminado) |
| `packages/core/audio` | AudioQueueService, fillers | Mantener |
| `packages/dispatcher` | EmbeddingClassifier, SpeculativeCache, Teacher, ScoreStore | Simplificar + migrar |

---

## Modelo de Latencias

```
Sin dispatcher (baseline):
  STT(150ms) → LLM turn1(1800ms) → tools(300ms) → LLM turn2(1800ms) → TTS(250ms)
  Total: ~4300ms | First audio: ~4300ms

Con dispatcher (SAFE cache hit):
  STT(150ms) → Dispatcher(10ms) → LLM(1800ms) → Tool(0ms) → LLM(1800ms) → TTS(250ms)
  Total: ~4000ms | First audio: ~160ms (filler)

Con fast stack (Groq + ElevenLabs Flash):
  STT(50ms) → Dispatcher(5ms) → LLM(100ms TTFT) → Tool(0ms) → TTS(75ms)
  Total: ~250-450ms | First audio: ~155ms
```

---

## Convención de Documentación

Los docs de arquitectura y diseño van en `/docs/` (raíz, sin subdirectorio):

| Archivo | Contenido |
|---|---|
| `docs/ARCHITECTURE-V2.md` | Este archivo — visión general y diagramas |
| `docs/SAFETY-MODEL.md` | Safety levels, DraftStore, flujos detallados |
| `docs/APPROVAL-CHANNELS.md` | Multi-canal configurable, estrategias |
| `docs/HUMAN-ROLES.md` | Roles humanos, permisos, escalación |
| `docs/DISPATCHER-SPECULATIVE.md` | Cache especulativa, Teacher, ScoreStore |
| `docs/FITALYSTORE-PRODUCT.md` | Visión de producto retail |

**NO modificar:**
- `docs/api/` — generado automáticamente por TypeDoc
- `docs/guides/` — guías de usuario del framework (actualizadas por separado)
