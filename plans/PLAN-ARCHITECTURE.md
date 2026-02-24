# FitalyAgents — Arquitectura & Contratos del Bus
> **Esta es la Constitución del sistema. Los schemas aquí definidos son el único contrato entre procesos.**
> Rust serializa con `serde_json`. TypeScript valida con Zod. Ambos deben mantenerse sincronizados.

---

## Principio Fundamental

```
NINGÚN proceso llama directamente a otro proceso.
NINGÚN proceso conoce el host, puerto o lenguaje del otro.
SOLO conocen los nombres de canales y los JSON schemas.

Node  ──PUBLISH──► Redis ──SUBSCRIBE──► Rust
Rust  ──PUBLISH──► Redis ──SUBSCRIBE──► Node

Si Rust se reemplaza por Go → TypeScript no cambia nada.
Si un agente migra de Node a Python → Rust no cambia nada.
```

---

## Mapa Completo de Canales Redis

| Canal | Publisher | Subscriber(s) | Payload |
|---|---|---|---|
| `bus:SPEECH_FINAL` | Process 1 (audio) | Dispatcher (speech_listener) | `SpeechFinalEvent` |
| `bus:DISPATCH_FALLBACK` | Dispatcher | TS `LLMFallbackAgent` | `FallbackRequestEvent` |
| `bus:TASK_AVAILABLE` | Dispatcher OR TS Fallback | Dispatcher (capability_router) | `TaskAvailableEvent` |
| `bus:INTENT_UPDATED` | TS `LLMFallbackAgent` | Dispatcher (intent_reload) | `IntentUpdatedEvent` |
| `queue:{agent_id}:inbox` | Dispatcher (router) | Agent TS process | `TaskPayloadEvent` |
| `queue:{agent_id}:outbox` | Agent TS process | Dispatcher (result_collector) | `TaskResultEvent` |
| `bus:ACTION_COMPLETED` | Dispatcher (result_collector) | Agent 1 (Interaction) | `ActionCompletedEvent` |
| `bus:CONTEXT_UPDATED` | Dispatcher (result_collector) | Agent 1 (Interaction) | `ContextUpdatedEvent` |
| `bus:HEARTBEAT` | Cada agente TS (cada 3s) | Dispatcher (registry_monitor) | `HeartbeatEvent` |
| `bus:AGENT_REGISTERED` | Agente TS (on startup) | Dispatcher (registry) | `AgentManifestEvent` |
| `bus:AGENT_DEREGISTERED` | Agente TS (on shutdown) | Dispatcher (registry + classifier) | `AgentIdEvent` |
| `bus:BARGE_IN` | Process 1 (audio) | Dispatcher → Agent 1 | `BargeInEvent` |
| `bus:PRIORITY_INTERRUPT` | Process 1 (audio) | Dispatcher (session_manager) | `InterruptEvent` |
| `bus:ORDER_APPROVED` | Sistema externo (webhook) | Dispatcher → Agent 1 | `ApprovalEvent` |

---

## JSON Schemas — Contrato Completo

### `SpeechFinalEvent` → `bus:SPEECH_FINAL`

```typescript
// Zod schema
const SpeechFinalEventSchema = z.object({
  event:      z.literal('SPEECH_FINAL'),
  session_id: z.string(),          // "sess_ana_001"
  speaker_id: z.string(),          // "spk_ana"
  group:      z.enum(['group_0', 'group_1', 'group_2']),
  text:       z.string(),          // "¿hay Nike talla 42 azul?"
  confidence: z.number().min(0).max(1),  // ASR confidence: 0.92
  timestamp:  z.number()           // Unix ms
})
```

```json
{
  "event": "SPEECH_FINAL",
  "session_id": "sess_ana_001",
  "speaker_id": "spk_ana",
  "group": "group_1",
  "text": "¿hay Nike talla 42 azul?",
  "confidence": 0.92,
  "timestamp": 1709123456789
}
```

---

### `TaskAvailableEvent` → `bus:TASK_AVAILABLE`

```typescript
const TaskAvailableEventSchema = z.object({
  event:                   z.literal('TASK_AVAILABLE'),
  task_id:                 z.string(),
  session_id:              z.string(),
  intent_id:               z.string(),           // "product_availability"
  domain_required:         z.string(),           // "customer_facing"
  scope_hint:              z.string().optional(), // "commerce"
  capabilities_required:   z.array(z.string()),  // ["PRODUCT_SEARCH"]
  slots:                   z.record(z.unknown()), // { brand, size, color }
  priority:                z.number().int().min(0).max(10),
  source:                  z.enum(['classifier', 'llm_fallback']),
  classifier_confidence:   z.number(),
  depends_on:              z.string().nullable(), // task_id o null
  cancel_token:            z.string().nullable(),
  context_mode_hint:       z.enum(['stateless', 'stateful']).optional(),
  timeout_ms:              z.number().int(),
  created_at:              z.number()
})
```

```json
{
  "event": "TASK_AVAILABLE",
  "task_id": "task_a7f3c",
  "session_id": "sess_ana_001",
  "intent_id": "product_availability",
  "domain_required": "customer_facing",
  "scope_hint": "commerce",
  "capabilities_required": ["PRODUCT_SEARCH"],
  "slots": { "brand": "nike", "size": 42, "color": "blue" },
  "priority": 5,
  "source": "classifier",
  "classifier_confidence": 0.94,
  "depends_on": null,
  "cancel_token": "tok_8f2a",
  "context_mode_hint": "stateless",
  "timeout_ms": 8000,
  "created_at": 1709123456800
}
```

---

### `TaskPayloadEvent` → `queue:{agent_id}:inbox`

Lo que el agente recibe en su inbox. El router construye esto combinando la tarea + el snapshot de contexto (solo los campos que el agente tiene permiso de leer según su manifiesto).

```typescript
const TaskPayloadEventSchema = z.object({
  event:            z.literal('TASK_PAYLOAD'),
  task_id:          z.string(),
  session_id:       z.string(),
  intent_id:        z.string(),
  slots:            z.record(z.unknown()),
  context_snapshot: z.record(z.unknown()), // solo campos permitidos por manifest.context_access.read
  cancel_token:     z.string().nullable(),
  timeout_ms:       z.number().int(),
  reply_to:         z.string()             // "queue:agent_work_v1:outbox"
})
```

```json
{
  "event": "TASK_PAYLOAD",
  "task_id": "task_a7f3c",
  "session_id": "sess_ana_001",
  "intent_id": "product_availability",
  "slots": { "brand": "nike", "size": 42, "color": "blue" },
  "context_snapshot": {
    "client_profile": { "name": "Ana", "preferences": {} },
    "session_id": "sess_ana_001"
  },
  "cancel_token": "tok_8f2a",
  "timeout_ms": 8000,
  "reply_to": "queue:agent_work_v1:outbox"
}
```

> ⚠️ El agente stateless NO recibe `conversation_history` ni `audio_queue`. El router aplica el filtro de `context_access.read` del manifiesto antes de construir el snapshot.

---

### `TaskResultEvent` → `queue:{agent_id}:outbox`

Lo que el agente TS publica cuando termina. El router lee esto, aplica el `context_patch`, y publica `ACTION_COMPLETED`.

```typescript
const TaskResultEventSchema = z.object({
  event:         z.literal('TASK_RESULT'),
  task_id:       z.string(),
  session_id:    z.string(),
  status:        z.enum(['completed', 'failed', 'waiting_approval', 'cancelled']),
  result:        z.unknown().optional(),
  context_patch: z.record(z.unknown()), // qué campos escribir en context:{session_id}
  error:         z.string().optional(),
  completed_at:  z.number()
})
```

```json
{
  "event": "TASK_RESULT",
  "task_id": "task_a7f3c",
  "session_id": "sess_ana_001",
  "status": "completed",
  "result": {
    "stock": 3,
    "sku": "NK-AZ-42",
    "locations": ["depósito A"]
  },
  "context_patch": {
    "action_status": "completed",
    "last_action": {
      "type": "PRODUCT_SEARCH",
      "result": { "stock": 3, "sku": "NK-AZ-42" }
    }
  },
  "completed_at": 1709123457600
}
```

---

### `FallbackRequestEvent` → `bus:DISPATCH_FALLBACK`

El dispatcher envía esto cuando la confianza del clasificador está por debajo del umbral. El `LLMFallbackAgent` lo lee.

```typescript
const FallbackRequestEventSchema = z.object({
  event:                  z.literal('DISPATCH_FALLBACK'),
  fallback_id:            z.string(),
  session_id:             z.string(),
  text:                   z.string(),
  classifier_confidence:  z.number(),
  top_candidates:         z.array(z.object({
    intent_id: z.string(),
    score:     z.number()
  })),
  available_intents:      z.array(z.object({
    intent_id:   z.string(),
    examples:    z.array(z.string()),
    capabilities_required: z.array(z.string())
  })),
  timestamp: z.number()
})
```

```json
{
  "event": "DISPATCH_FALLBACK",
  "fallback_id": "fb_3d9a",
  "session_id": "sess_ana_001",
  "text": "no sé, esos de allá",
  "classifier_confidence": 0.41,
  "top_candidates": [
    { "intent_id": "product_availability", "score": 0.41 },
    { "intent_id": "price_query", "score": 0.38 }
  ],
  "available_intents": [
    {
      "intent_id": "product_availability",
      "examples": ["¿hay Nike?", "¿tienen talla 42?"],
      "capabilities_required": ["PRODUCT_SEARCH"]
    },
    {
      "intent_id": "price_query",
      "examples": ["¿cuánto cuesta?", "¿qué precio tiene?"],
      "capabilities_required": ["PRICE_CHECK"]
    }
  ],
  "timestamp": 1709123456900
}
```

---

### `IntentUpdatedEvent` → `bus:INTENT_UPDATED`

El LLM Fallback publica esto después de resolver un caso ambiguo. El clasificador recarga el embedding de ese intent.

```json
{
  "event": "INTENT_UPDATED",
  "intent_id": "product_availability",
  "new_example": "esos de allá",
  "source": "llm_fallback",
  "timestamp": 1709123457200
}
```

---

### `AgentManifestEvent` → `bus:AGENT_REGISTERED`

```typescript
const AgentManifestEventSchema = z.object({
  event:          z.literal('AGENT_REGISTERED'),
  agent_id:       z.string(),
  display_name:   z.string().optional(),
  description:    z.string(),
  version:        z.string(),
  domain:         z.enum(['customer_facing', 'internal_ops', 'inter_agent', 'system']),
  scope:          z.string(),
  capabilities:   z.array(z.string()),
  context_mode:   z.enum(['stateless', 'stateful']),
  context_access: z.object({
    read:      z.array(z.string()),
    write:     z.array(z.string()),
    forbidden: z.array(z.string())
  }),
  async_tools:          z.array(z.string()),
  input_channel:        z.string(),
  output_channel:       z.string(),
  priority:             z.number().int(),
  max_concurrent:       z.number().int(),
  timeout_ms:           z.number().int(),
  heartbeat_interval_ms:z.number().int().default(3000),
  role:                 z.enum(['DISPATCHER', 'SYSTEM']).nullable(),
  accepts_from:         z.array(z.string()),
  requires_human_approval: z.boolean()
})
```

---

### `HeartbeatEvent` → `bus:HEARTBEAT`

```json
{
  "event": "HEARTBEAT",
  "agent_id": "agent_work_v1",
  "status": "idle",
  "current_tasks": 2,
  "max_tasks": 5,
  "timestamp": 1709123456000
}
```

---

### `ActionCompletedEvent` → `bus:ACTION_COMPLETED`

```json
{
  "event": "ACTION_COMPLETED",
  "task_id": "task_a7f3c",
  "session_id": "sess_ana_001",
  "intent_id": "product_availability",
  "agent_id": "agent_work_v1",
  "result": { "stock": 3, "sku": "NK-AZ-42" },
  "timestamp": 1709123457650
}
```

---

### `ApprovalEvent` → `bus:ORDER_APPROVED`

```json
{
  "event": "ORDER_APPROVED",
  "approval_id": "appr_992",
  "draft_id": "draft_4521",
  "order_id": "order_4521",
  "session_id": "sess_ana_001",
  "approver_id": "staff_007",
  "timestamp": 1709123502000
}
```

---

## Estructuras de Datos en Redis

| Key pattern | Tipo Redis | Owner | Contenido |
|---|---|---|---|
| `context:{session_id}` | JSON (RedisJSON) | Dispatcher result_collector | Contexto completo de sesión |
| `lock:{task_id}` | String + TTL | Dispatcher lock_manager | `{ agent_id, keys_locked, expires_at }` |
| `registry:agents:{agent_id}` | JSON | Dispatcher registry_monitor | Manifiesto completo del agente |
| `intents:{intent_id}:examples` | List | LLMFallbackAgent + AI gen | Ejemplos de training del clasificador |
| `intents:{intent_id}:embedding` | String (bytes) | Dispatcher classifier | Embedding centroide pre-computado |
| `intents:{intent_id}:meta` | JSON | Dispatcher + TS | `{ agent_id, capabilities_required, slots_required }` |
| `tasks:pending` | Sorted Set | Dispatcher task_queue | task_ids sorted por priority + created_at |
| `heartbeat:{agent_id}` | String + TTL 9s | Dispatcher registry | Último heartbeat timestamp |
| `queue:{agent_id}:inbox` | List (LPUSH/BRPOP) | Dispatcher router | TaskPayloadEvent pendientes |
| `sessions:{session_id}` | JSON | Dispatcher session_manager | Metadata de sesión, group, estado |

---

## Estructura del Contexto de Sesión

```typescript
// context:{session_id} — RedisJSON
interface SessionContext {
  session_id:     string
  current_state:  'listening' | 'processing' | 'speaking' | 'waiting'
  priority_group: 'group_0' | 'group_1' | 'group_2'

  // Conversación
  client_profile: {
    name: string
    voice_id: string
    preferences: Record<string, unknown>
  }
  conversation_history: Array<{
    role: 'user' | 'system'
    text: string
    timestamp: number
  }>

  // Estado de tarea actual
  intent_detected: string
  slots:           Record<string, unknown>
  action_status:   'idle' | 'in_progress' | 'completed' | 'waiting_approval' | 'failed'
  last_action:     { type: string; result: unknown } | null
  active_tasks:    string[]
  task_locks:      Record<string, string>  // context_key → agent_id

  // Estado UI / output (propiedad de Agent 1)
  audio_queue:   unknown[]
  display_state: { gesture: string; order_visible: boolean }

  // Aprobaciones pendientes
  pending_approvals: Array<{
    draft_id: string
    type: 'ORDER_CREATE' | 'REFUND_CREATE'
    submitted_at: number
    expires_at: number
  }>
}
```

---

## Flujo Completo — Solo Eventos Redis

### Path de Alta Confianza (Dispatcher solo, ~10ms total)

```
Process 1              Dispatcher                    Agent TS           Agent 1 (TS)
─────────              ──────────                    ────────           ────────────
PUBLISH
bus:SPEECH_FINAL ──►  speech_listener
                           │
                       classify() ~5ms
                       conf: 0.94 ✓
                           │
                       build TaskAvailable
                       PUBLISH
                       bus:TASK_AVAILABLE ──► capability_router
                                                    │
                                               match agent
                                               write lock Redis
                                               PUBLISH
                                         queue:inbox ──────────► process()
                                                                       │
                                                                  LLM + tools
                                                                  ~600-800ms
                                                                       │
                                                                  PUBLISH
                                         result_collector ◄── queue:outbox
                                                │
                                          apply context_patch
                                          release lock
                                          PUBLISH
                       bus:ACTION_COMPLETED ──────────────────────────► read result
                       bus:CONTEXT_UPDATED ──────────────────────────► speak
```

### Path de Baja Confianza (Dispatcher + LLM Fallback, ~300ms total)

```
Dispatcher             LLMFallbackAgent              Dispatcher
──────────             ────────────────              ──────────
classify()
conf: 0.41 ✗
PUBLISH
bus:DISPATCH_FALLBACK ──────────► resolve()
                                       │
                                  LLM call ~250ms
                                       │
                                  PUBLISH
                       bus:TASK_AVAILABLE ──────────► capability_router (continúa normal)
                       bus:INTENT_UPDATED ──────────► intent_reload
                                                           │
                                                      reload embedding
                                                      próxima vez: conf ✓
```

---

## NexusAgent Base Class (TypeScript)

Todos los agentes TypeScript heredan de esta clase. Solo necesitan implementar `process()`.

```typescript
import Redis from 'ioredis'
import { z } from 'zod'
import type { AgentManifest, TaskPayload, TaskResult } from 'fitalyagents'

export abstract class NexusAgent {
  protected redis: Redis
  protected sub:   Redis  // conexión separada para subscriptions

  constructor(protected manifest: AgentManifest) {
    this.redis = new Redis(process.env.REDIS_URL!)
    this.sub   = new Redis(process.env.REDIS_URL!)
  }

  async start(): Promise<void> {
    // 1. Publicar manifiesto al bus
    await this.redis.publish('bus:AGENT_REGISTERED',
      JSON.stringify({ event: 'AGENT_REGISTERED', ...this.manifest })
    )

    // 2. Iniciar heartbeat cada 3s
    setInterval(() => this.heartbeat(), 3000)

    // 3. Escuchar inbox con BRPOP (blocking pop, más eficiente que subscribe)
    this.listenInbox()

    // 4. Graceful shutdown
    process.on('SIGTERM', () => this.shutdown())
  }

  private async listenInbox(): Promise<void> {
    while (true) {
      const res = await this.sub.brpop(this.manifest.input_channel, 0)
      if (!res) continue
      const [, raw] = res
      const task = TaskPayloadSchema.parse(JSON.parse(raw))
      try {
        const result = await this.process(task)
        await this.redis.publish(this.manifest.output_channel, JSON.stringify(result))
      } catch (err) {
        await this.redis.publish(this.manifest.output_channel, JSON.stringify({
          event: 'TASK_RESULT',
          task_id: task.task_id,
          session_id: task.session_id,
          status: 'failed',
          error: err instanceof Error ? err.message : String(err),
          context_patch: {},
          completed_at: Date.now()
        }))
      }
    }
  }

  // Solo esto implementan las subclases
  abstract process(task: TaskPayload): Promise<TaskResult>

  private async heartbeat(): Promise<void> {
    await this.redis.publish('bus:HEARTBEAT', JSON.stringify({
      event: 'HEARTBEAT',
      agent_id: this.manifest.agent_id,
      status: 'idle',
      current_tasks: 0,
      max_tasks: this.manifest.max_concurrent,
      timestamp: Date.now()
    }))
  }

  private async shutdown(): Promise<void> {
    await this.redis.publish('bus:AGENT_DEREGISTERED', JSON.stringify({
      event: 'AGENT_DEREGISTERED',
      agent_id: this.manifest.agent_id
    }))
    await this.redis.quit()
    await this.sub.quit()
  }
}
```
