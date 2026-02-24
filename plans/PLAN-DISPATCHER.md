# FitalyAgents — Task Dispatcher
> **El único agente especial del sistema. Dos implementaciones, un solo contrato Redis.**

---

## Concepto Central: El Dispatcher se Entrena

El Task Dispatcher NO es un LLM corriendo en cada mensaje. Es un sistema híbrido que mejora con el tiempo:

```
                        ┌─────────────────────────────────────────────────┐
                        │           TASK DISPATCHER                       │
                        │                                                 │
  bus:SPEECH_FINAL ───► │  EmbeddingClassifier                           │
                        │    │                                            │
                        │    ├── conf ≥ 0.85 ──► CapabilityRouter ──────►│ bus:TASK_AVAILABLE
                        │    │                                            │
                        │    └── conf < 0.85 ──► bus:DISPATCH_FALLBACK   │
                        │                              │                  │
                        │                        LLMFallbackAgent         │
                        │                              │                  │
                        │                              ├──────────────────►│ bus:TASK_AVAILABLE
                        │                              │                  │
                        │                              └──► IntentLibrary │
                        │                                     (aprende)   │
                        │                                       │         │
                        │                             EmbeddingClassifier │
                        │                              recarga embedding  │
                        └─────────────────────────────────────────────────┘

→ Día 1:  80% clasificados con confianza, 20% van a LLM fallback
→ Mes 1:  95% clasificados, 5% fallback
→ Mes 6:  99%+ clasificados, LLM es rarísimo
```

---

## Dos Versiones, Mismo Contrato

### Versión Node.js (`fitalyagents/dispatcher`)
- **Incluida en el SDK, gratis**
- Latencia: ~50-200ms por clasificación
- Embeddings via `@xenova/transformers` (WASM, sin servidor)
- Ideal para: desarrollo, staging, producción con carga moderada

### Versión Rust (`dispatcher-core-rust`)
- **Binario separado, futuro comercial**
- Latencia: ~5-20ms por clasificación  
- Embeddings via `candle` (Hugging Face), modelo en memoria
- Ideal para: producción de alta carga, latencia crítica
- **Drop-in replacement**: mismos canales Redis, no tocar agentes TypeScript

---

## NodeDispatcher — Arquitectura Interna

```typescript
// Un proceso Node.js, múltiples workers concurrentes via AsyncGenerator + Promise.all

class NodeDispatcher {
  // Tasks concurrentes internas (no Redis, en memoria)
  private workers = {
    speechListener:    // SUBSCRIBE bus:SPEECH_FINAL
    fallbackPublisher: // PUBLISH bus:DISPATCH_FALLBACK
    capabilityRouter:  // SUBSCRIBE bus:TASK_AVAILABLE → route
    resultCollector:   // SUBSCRIBE queue:*:outbox pattern
    registryMonitor:   // SUBSCRIBE bus:AGENT_REGISTERED + HEARTBEAT
    intentReloader:    // SUBSCRIBE bus:INTENT_UPDATED
    lockWatchdog:      // setInterval 1000ms
  }
}
```

### Worker: `speechListener`

```typescript
async speechListener(): Promise<void> {
  await this.sub.subscribe('bus:SPEECH_FINAL')
  this.sub.on('message', async (_, raw) => {
    const event = SpeechFinalEventSchema.parse(JSON.parse(raw))
    const result = await this.classifier.classify(event.text)

    if (result.confidence >= CONFIDENCE_THRESHOLD) {
      await this.fastDispatch(event, result)
    } else {
      await this.publishFallback(event, result)
    }
  })
}
```

### Worker: `capabilityRouter`

```typescript
async routeTask(task: TaskAvailableEvent): Promise<void> {
  const agent = this.registry.findBest({
    domain:                 task.domain_required,
    scope:                  task.scope_hint,
    capabilities_required:  task.capabilities_required,
    accepts_from:           task.origin_domain,
  })

  if (!agent) {
    // Re-encolar con delay
    await this.taskQueue.requeueWithDelay(task, 500)
    return
  }

  // Adquirir lock
  const locked = await this.lockManager.acquire(task.task_id, agent.agent_id, task.timeout_ms)
  if (!locked) return // otro router lo tomó primero (race condition safe)

  // Construir context_snapshot según permisos del agente
  const snapshot = await this.contextStore.getSnapshot(
    task.session_id,
    agent.context_access.read
  )

  // Publicar al inbox del agente
  const payload: TaskPayloadEvent = {
    event:            'TASK_PAYLOAD',
    task_id:          task.task_id,
    session_id:       task.session_id,
    intent_id:        task.intent_id,
    slots:            task.slots,
    context_snapshot: snapshot,
    cancel_token:     task.cancel_token,
    timeout_ms:       task.timeout_ms,
    reply_to:         agent.output_channel
  }

  await this.redis.lpush(agent.input_channel, JSON.stringify(payload))
}
```

### Worker: `resultCollector`

```typescript
async resultCollector(): Promise<void> {
  // Pattern subscription: todos los outboxes
  await this.sub.psubscribe('queue:*:outbox')
  this.sub.on('pmessage', async (_, channel, raw) => {
    const result = TaskResultEventSchema.parse(JSON.parse(raw))

    // 1. Verificar que el task_id y session_id coincidan con el lock
    const lock = await this.lockManager.get(result.task_id)
    if (!lock || lock.session_id !== result.session_id) return

    // 2. Aplicar context_patch en Redis JSON
    await this.contextStore.patch(result.session_id, result.context_patch)

    // 3. Liberar lock
    await this.lockManager.release(result.task_id)

    // 4. Si tiene depends_on → desbloquear siguiente tarea
    await this.taskQueue.unlockDependents(result.task_id)

    // 5. Publicar ACTION_COMPLETED
    await this.redis.publish('bus:ACTION_COMPLETED', JSON.stringify({
      event:      'ACTION_COMPLETED',
      task_id:    result.task_id,
      session_id: result.session_id,
      result:     result.result,
      timestamp:  Date.now()
    }))

    // 6. Publicar CONTEXT_UPDATED
    await this.redis.publish('bus:CONTEXT_UPDATED', JSON.stringify({
      event:      'CONTEXT_UPDATED',
      session_id: result.session_id,
      fields:     Object.keys(result.context_patch),
      timestamp:  Date.now()
    }))
  })
}
```

---

## EmbeddingClassifier — Node.js

```typescript
import { pipeline, cos_sim } from '@xenova/transformers'

class EmbeddingClassifier {
  private model:   FeatureExtractionPipeline | null = null
  private intents: Map<string, IntentEntry> = new Map()
  // intents: intent_id → { embedding: Float32Array, meta: IntentMeta }

  async init(): Promise<void> {
    // Modelo pequeño y rápido, corre en WASM sin servidor externo
    this.model = await pipeline('feature-extraction', 'Xenova/all-MiniLM-L6-v2')
    await this.loadIntentsFromRedis()
  }

  async classify(text: string): Promise<ClassifyResult> {
    if (!this.model) throw new Error('Classifier not initialized')

    // 1. Generar embedding del texto entrante
    const queryEmbedding = await this.embed(text)  // ~20-50ms en WASM

    // 2. Cosine similarity contra todos los intents en memoria
    let bestIntent:     string | null = null
    let bestScore:      number = 0
    const candidates:   Array<{ intent_id: string; score: number }> = []

    for (const [intentId, entry] of this.intents) {
      const score = cos_sim(queryEmbedding, entry.embedding)
      candidates.push({ intent_id: intentId, score })
      if (score > bestScore) {
        bestScore  = score
        bestIntent = intentId
      }
    }

    candidates.sort((a, b) => b.score - a.score)

    if (bestScore >= CONFIDENCE_THRESHOLD && bestIntent) {
      const meta = this.intents.get(bestIntent)!.meta
      return {
        type:       'confident',
        intent_id:  bestIntent,
        confidence: bestScore,
        domain_required:       meta.domain_required,
        scope_hint:            meta.scope_hint,
        capabilities_required: meta.capabilities_required,
        candidates:            candidates.slice(0, 3)
      }
    }

    return {
      type:                  'fallback',
      confidence:            bestScore,
      top_candidates:        candidates.slice(0, 3)
    }
  }

  async reloadIntent(intentId: string): Promise<void> {
    // Llamado cuando bus:INTENT_UPDATED llega
    const examples = await this.redis.lrange(`intents:${intentId}:examples`, 0, -1)
    if (examples.length === 0) return

    // Calcular centroide de todos los ejemplos
    const embeddings = await Promise.all(examples.map(e => this.embed(e)))
    const centroid   = this.computeCentroid(embeddings)

    // Actualizar en memoria
    const meta = await this.redis.json.get(`intents:${intentId}:meta`) as IntentMeta
    this.intents.set(intentId, { embedding: centroid, meta })

    // Persistir en Redis para el Rust dispatcher (si está corriendo)
    await this.redis.set(`intents:${intentId}:embedding`, Buffer.from(centroid.buffer))
  }
}
```

---

## LLMFallbackAgent — TypeScript

Proceso TypeScript separado. Lee `bus:DISPATCH_FALLBACK`, resuelve con LLM, publica `bus:TASK_AVAILABLE` + entrena la Intent Library.

```typescript
import Anthropic from '@anthropic-ai/sdk'

class LLMFallbackAgent {
  private redis  = new Redis(process.env.REDIS_URL!)
  private sub    = new Redis(process.env.REDIS_URL!)
  private llm    = new Anthropic()

  async start(): Promise<void> {
    await this.sub.subscribe('bus:DISPATCH_FALLBACK')
    this.sub.on('message', async (_, raw) => {
      const req = FallbackRequestSchema.parse(JSON.parse(raw))
      await this.resolve(req)
    })
  }

  private buildSystemPrompt(intents: AvailableIntent[]): string {
    const intentList = intents.map(i =>
      `- ${i.intent_id}: ejemplos: [${i.examples.join(', ')}] → capabilities: [${i.capabilities_required.join(', ')}]`
    ).join('\n')

    return `Eres un clasificador de intents. Dado un texto, responde SOLO JSON válido.
Intents disponibles:
${intentList}

Responde con este schema exacto:
{
  "intent_id": "string",
  "domain_required": "customer_facing | internal_ops | inter_agent | system",
  "scope_hint": "string",
  "capabilities_required": ["string"],
  "slots": { "key": "value" },
  "confidence": 0.0-1.0
}`
  }

  private async resolve(req: FallbackRequest): Promise<void> {
    const response = await this.llm.messages.create({
      model:     'claude-haiku-4-5-20251001',
      max_tokens: 500,
      system:    this.buildSystemPrompt(req.available_intents),
      messages:  [{ role: 'user', content: req.text }]
    })

    const classified = JSON.parse(response.content[0].text)

    // 1. Publicar tarea al bus (mismo formato que clasificador rápido)
    await this.redis.publish('bus:TASK_AVAILABLE', JSON.stringify({
      event:                 'TASK_AVAILABLE',
      task_id:               crypto.randomUUID(),
      session_id:            req.session_id,
      intent_id:             classified.intent_id,
      domain_required:       classified.domain_required,
      scope_hint:            classified.scope_hint,
      capabilities_required: classified.capabilities_required,
      slots:                 classified.slots,
      priority:              5,
      source:                'llm_fallback',
      classifier_confidence: req.classifier_confidence,
      depends_on:            null,
      cancel_token:          null,
      timeout_ms:            8000,
      created_at:            Date.now()
    }))

    // 2. Alimentar Intent Library — esto es el "entrenamiento"
    await this.redis.rpush(`intents:${classified.intent_id}:examples`, req.text)

    // 3. Notificar al clasificador para recargar este intent
    await this.redis.publish('bus:INTENT_UPDATED', JSON.stringify({
      event:       'INTENT_UPDATED',
      intent_id:   classified.intent_id,
      new_example: req.text,
      source:      'llm_fallback',
      timestamp:   Date.now()
    }))
  }
}
```

---

## Intent Library — Estructura y Bootstrap

### Dónde viven los intents

```
Redis:
  intents:{intent_id}:examples   → List de strings (frases de ejemplo)
  intents:{intent_id}:embedding  → bytes del centroid embedding (Float32Array)
  intents:{intent_id}:meta       → JSON con agent_id, capabilities, etc.
```

### Bootstrap inicial

Los intents se definen con ejemplos iniciales al arrancar el sistema. Con el tiempo, `LLMFallbackAgent` agrega nuevos ejemplos automáticamente.

```typescript
// intents/bootstrap.ts — ejecutar una vez al desplegar
const initialIntents: IntentDefinition[] = [
  {
    intent_id:             'product_availability',
    domain_required:       'customer_facing',
    scope_hint:            'commerce',
    capabilities_required: ['PRODUCT_SEARCH'],
    initial_examples: [
      '¿hay Nike talla 42 azul?',
      '¿tienen zapatillas talla 40?',
      '¿hay stock del producto X?',
      'quiero ver si hay disponibilidad'
    ]
  },
  {
    intent_id:             'price_query',
    domain_required:       'customer_facing',
    scope_hint:            'commerce',
    capabilities_required: ['PRICE_CHECK'],
    initial_examples: [
      '¿cuánto cuesta?',
      '¿qué precio tiene?',
      '¿me puede decir el precio de eso?',
      '¿cuánto vale?'
    ]
  },
  // ...más intents
]

// Al registrar un nuevo agente con nuevas capabilities,
// el sistema genera intents automáticamente via LLM
```

### Generación automática de intents al registrar agente nuevo

```typescript
// Cuando bus:AGENT_REGISTERED detecta capabilities desconocidas:
async generateIntentsForNewCapabilities(manifest: AgentManifest): Promise<void> {
  for (const capability of manifest.capabilities) {
    if (await this.intentLibrary.hasIntentForCapability(capability)) continue

    // Generar ejemplos con LLM una sola vez
    const examples = await this.llm.generateExamples({
      capability,
      description: manifest.description,
      count: 10
    })

    await this.intentLibrary.createIntent({
      intent_id:             `${manifest.scope}_${capability.toLowerCase()}`,
      domain_required:       manifest.domain,
      scope_hint:            manifest.scope,
      capabilities_required: [capability],
      initial_examples:      examples
    })
  }
}
```

---

## RustDispatcher — Plan Futuro

> **Fase 5, post v1.0.0. Binario Rust standalone, replace drop-in del NodeDispatcher.**

### Por qué es un binario separado y no parte del SDK npm

- Requiere compilación (`cargo build --release`)
- Distribuido como binario precompilado por plataforma (x86_64, arm64)
- No hay npm install, el usuario ejecuta `./dispatcher-core --redis-url redis://...`
- Los agentes TypeScript no cambian absolutamente nada

### Stack Rust

```toml
# Cargo.toml
[dependencies]
tokio           = { version = "1", features = ["full"] }
redis           = { version = "0.24", features = ["tokio-comp", "json"] }
candle-core     = "0.6"
candle-transformers = "0.6"
serde           = { version = "1", features = ["derive"] }
serde_json      = "1.0"
uuid            = "1.6"
tracing         = "0.1"
```

### Tasks Tokio concurrentes

```
tokio::main
  ├── speech_listener     SUBSCRIBE bus:SPEECH_FINAL
  ├── fast_dispatcher     internal channel (no Redis)
  ├── fallback_publisher  PUBLISH bus:DISPATCH_FALLBACK
  ├── capability_router   SUBSCRIBE bus:TASK_AVAILABLE
  ├── result_collector    PSUBSCRIBE queue:*:outbox
  ├── registry_monitor    SUBSCRIBE bus:AGENT_REGISTERED + HEARTBEAT
  ├── intent_reloader     SUBSCRIBE bus:INTENT_UPDATED
  └── lock_watchdog       interval 1000ms
```

### Diferencia de latencia

| Operación | Node.js | Rust |
|---|---|---|
| Embedding (WASM) | ~30-50ms | ~2-5ms (candle) |
| Cosine similarity (100 intents) | ~1ms | ~0.1ms |
| JSON parse | ~0.5ms | ~0.1ms |
| Total clasificación confident | ~50ms | ~5ms |
| Total con fallback LLM | ~300ms | ~260ms (LLM domina) |

---

## Métricas de Éxito del Dispatcher

| Métrica | Target Node.js | Target Rust |
|---|---|---|
| Latencia p50 (confident) | < 100ms | < 10ms |
| Latencia p95 (confident) | < 200ms | < 20ms |
| Latencia p50 (fallback) | < 400ms | < 350ms |
| % clasificaciones confident (mes 1) | > 90% | > 90% |
| % clasificaciones confident (mes 6) | > 99% | > 99% |
| Throughput (mensajes/seg) | > 50/s | > 500/s |
