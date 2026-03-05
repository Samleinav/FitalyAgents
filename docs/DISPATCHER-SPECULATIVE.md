# Dispatcher Especulativo — FitalyAgents v2

> El dispatcher no decide qué herramienta usar. Eso lo hace el LLM.
> El dispatcher *pre-ejecuta* herramientas antes de que el LLM las pida.
> Cuando el LLM llega, el resultado ya está listo.

---

## El Problema que Resuelve

En un flujo normal sin dispatcher:

```
Cliente habla → STT(150ms) → LLM Turn 1(1800ms) → tool_call → tool exec(300ms) → LLM Turn 2(1800ms) → TTS(250ms)
Total: ~4300ms. El cliente espera más de 4 segundos antes de escuchar algo.
```

Con dispatcher especulativo:

```
Cliente habla → Dispatcher clasifica en SPEECH_PARTIAL(10ms) → pre-ejecuta SAFE tools
              → STT(150ms) → LLM Turn 1(1800ms) → tool result ya en cache(0ms) → LLM Turn 2(1800ms) → TTS(250ms)
Total: ~4000ms. Primera respuesta: ~160ms (filler de audio mientras dispatcher trabaja).

Con fast stack (Groq + ElevenLabs Flash):
Total: ~250-450ms. Respuesta conversacional real.
```

El dispatcher compra tiempo. En el peor caso (MISS), el LLM sigue funcionando normal. En el mejor caso (HIT), el tool ya ejecutó.

---

## Cascade de Clasificación: 3 Niveles

El dispatcher clasifica el intent del cliente con la menor latencia posible.

```
L1 — Keyword (1ms)
  Regex + patrones directos, sin ML.
  Ejemplos: "P001" → product_detail | "precio" → price_check | "horario" → store_hours

L2 — Embedding (3-8ms)
  Modelo local: all-MiniLM-L6-v2, cosine similarity contra IntentLibrary.
  Ejemplos: "quiero ver zapatillas nike" → product_search (0.91)
  Si L2 está confiado en "none" (margin ≥ 0.08) → skip L3, ahorra 700ms.

L3 — LLM Classifier (700-900ms)
  Solo si L1+L2 no alcanzan umbral de confianza.
  Necesario cuando el contexto cambia el significado de la frase.
  Ejemplo: "¿ese modelo está disponible?" depende de qué "modelo" mencionó antes.
```

**Regla:** L3 debe usarse cada vez menos a medida que IntentLibrary crece con el Teacher.

---

## SpeculativeCache

```typescript
interface SpeculativeCache {
  // Resultado de tool SAFE pre-ejecutado
  set(sessionId: string, intentId: string, result: ToolResult, ttlMs: number): void
  get(sessionId: string, intentId: string): ToolResult | null

  // Draft creado especulativamente para STAGED tools
  setDraft(sessionId: string, draft: Draft): void
  getDraft(sessionId: string): Draft | null

  // Hint de que hay intent PROTECTED/RESTRICTED — no ejecuta nada, solo avisa
  setHint(sessionId: string, intent: string, confidence: number): void
  getHint(sessionId: string): { intent: string; confidence: number } | null
}
```

### Comportamiento por Safety Level

| Level | ¿Qué hace el dispatcher en SPEECH_PARTIAL? | ¿Qué recibe el LLM en SPEECH_FINAL? |
|---|---|---|
| `safe` | Ejecuta tool + guarda `ToolResult` en cache | `cache.get()` → resultado completo (0ms wait) |
| `staged` | Crea draft especulativo + guarda en cache | `cache.getDraft()` → presenta al cliente |
| `protected` | Solo `setHint()` | `cache.getHint()` → LLM pide confirmación al cliente |
| `restricted` | Solo `setHint()` | `cache.getHint()` → SafetyGuard escala a ApprovalOrchestrator |

**Nunca** el dispatcher ejecuta un tool `restricted` o `protected`. Solo registra la intención.

### TTL y LRU

```
SpeculativeCache:
├── TTL por entry: 30 segundos (configurable)
│   → Si el cliente habló de zapatillas pero luego preguntó el horario, el resultado antiguo se invalida
├── LRU: máximo 50 entries activas por sesión
└── Al confirmar/cancelar draft: cache.invalidate(sessionId)
```

---

## Self-Improving: Teacher + Score Store

El dispatcher aprende de sus errores observando las correcciones del LLM.

### Los 3 Outcomes

Cuando el LLM hace un `tool_call`, se compara con lo que el dispatcher especuló:

```
HIT        → dispatcher y LLM eligieron el mismo tool
               EMA del tool sube → dispatcher más confiante la próxima vez

CORRECTION → dispatcher eligió tool X, LLM eligió tool Y
               EMA del tool baja → Teacher evalúa si agregar nuevo ejemplo

MISS       → dispatcher no especuló (baja confianza), LLM usó el tool
               Solo registra el dato — no penaliza, es información útil
```

### IntentTeacher

El Teacher evalúa las CORRECTIONs y decide si el dispatcher debe aprender de ellas.

```typescript
const teacher = new IntentTeacher({
  // Descripción en lenguaje natural del negocio.
  // Sin nombres de tools, sin IDs técnicos.
  instructionPrompt: `
    Eres un evaluador de un asistente de tienda de zapatos.
    El sistema clasifica frases del cliente en estas categorías:
    - Buscar productos: cuando el cliente quiere ver catálogo, buscar algo por nombre o tipo
    - Ver detalle de producto: cuando menciona un código específico o "ese modelo"
    - Consultar precio: cuando pregunta cuánto cuesta algo
    - Estado de pedido: cuando quiere saber dónde está su pedido
    ...
  `,
  model: 'anthropic/claude-3.5-haiku'  // barato, rápido
})
```

**Regla crítica:** El `instructionPrompt` describe intenciones en lenguaje humano. El developer no necesita saber los nombres internos de los tools.

Para cada CORRECTION, el Teacher recibe:

```
query:              "¿ese modelo que mencionaste viene en azul?"
wrong_intent:       product_search     ← lo que eligió el dispatcher
correct_intent:     product_detail     ← lo que eligió el LLM
existing_examples:  [...últimos 5 ejemplos de product_detail...]
```

Y decide:

```
add   → La query es un ejemplo válido de correct_intent.
         teacher.addExample(query, correct_intent) → IntentLibrary se actualiza en vivo.
         Próxima vez que alguien diga algo similar, L2 lo clasifica bien.

skip  → La query es ambigua, mejor no agregar para no confundir el modelo.

flag  → Parece un bug o caso especial — registrar para revisión manual.
```

### IntentScoreStore

EMA (Exponential Moving Average, α=0.1) por tool. Separa el aprendizaje inicial de la operación en producción.

```
Training mode:
  → Dispatcher siempre especula, sin importar el score
  → Acumula datos de calidad para el embedding
  → Dura hasta que hit rate ≥ 90% en N sesiones

Production mode (score ≥ 0.70):
  → Dispatcher solo especula si score del tool ≥ 0.70
  → Evita falsos positivos que desperdicien compute
  → Auto-suggest de switch cuando hay suficiente confianza
```

```typescript
// Consulta antes de especular
const score = await scoreStore.getScore('product_search')
if (mode === 'production' && score < 0.70) {
  // No especular — esperar SPEECH_FINAL
  return null
}

// Registrar outcome después de SPEECH_FINAL
await scoreStore.record('product_search', outcome) // 'hit' | 'correction' | 'miss'
```

---

## IntentLibrary

El IntentLibrary es el vector store que alimenta L2. Crece automáticamente.

```
Por tienda (FitalyCloud):
├── Ejemplos base: cargados en setup (50-100 frases por intent)
├── Ejemplos del Teacher: agregados en vivo según correcciones
├── Backend: Redis vector (producción) | JSON file (desarrollo)
└── Modelo: all-MiniLM-L6-v2 (multilingüe: español, inglés, portugués)

Crecer el IntentLibrary = mejorar el dispatcher sin reentrenar el LLM.
```

### addExample en vivo

```typescript
// Cuando Teacher decide "add":
await intentLibrary.addExample({
  text: "¿ese modelo viene en azul?",
  intent: "product_detail",
  store_id: "store_001",         // aislado por tienda
  added_by: "teacher",
  timestamp: Date.now(),
})
// El embedding se genera y guarda.
// Próxima query similar → L2 clasifica bien.
```

---

## Flujo Completo: SPEECH_PARTIAL → SPEECH_FINAL

```
t=0ms   SPEECH_PARTIAL llega { partial: "¿tienen zapatillas nike en talla..." }
         │
         └── Dispatcher.onSpeechPartial()
             │
             ├── L1 Keyword: ningún patrón directo
             ├── L2 Embedding: "zapatillas nike" → product_search (0.91) ← confiante
             │   → safety=SAFE → EJECUTAR
             │
             └── ExecutorPool.execute('product_search', { q: 'nike zapatillas' })
                 → HTTP GET /api/products?q=nike+zapatillas (en paralelo, no bloquea)


t=10ms  Dispatcher tiene resultado pre-ejecutado
         → cache.set(sessionId, 'product_search', result, ttl=30s)
         → AudioQueue: reproducir filler si está configurado ("Déjame ver...")


t=150ms SPEECH_FINAL llega { text: "¿tienen zapatillas nike en talla 42?" }
         │
         └── InteractionAgent.onSpeechFinal()
             │
             ├── cache.get(sessionId, 'product_search') → HIT
             │   → Tool result lista: [Nike Air 42 ✅, Nike Run 42 ✅, Nike Court 42 ❌]
             │
             └── LLM (Groq/Llama, streaming) recibe:
                 - Transcripción completa
                 - Tool result ya en contexto
                 - System prompt con personaje de la tienda
                 → "Sí, tenemos Nike Air en talla 42 a ₡18,500 y Nike Run
                    a ₡22,000. ¿Cuál le interesa ver?"


t=450ms Respuesta completa → TTS → cliente escucha en ~600ms total


Registro:
  → scoreStore.record('product_search', 'hit')
  → Langfuse span: dispatcher=hit, latency=10ms, tool_saved=300ms
```

---

## Flujo STAGED: Draft Especulativo

```
t=0ms   SPEECH_PARTIAL: "quiero pedir las nike air talla 42..."
         → L2: order_create (0.88) → safety=STAGED
         → DraftStore.create(sessionId, { product: 'nike-air-42', qty: 1 }) → draft_id='dft_123'
         → cache.setDraft(sessionId, draft)
         → NO confirma la orden. Solo crea el borrador.


t=150ms SPEECH_FINAL: "quiero pedir las nike air talla 42 en negro"
         → InteractionAgent consulta cache.getDraft() → draft_id='dft_123'
         → LLM: "Tengo lista su orden: Nike Air 42 Negro, ₡18,500. ¿La confirmo?"


t=+Xs   Cliente: "sí"
         → InteractionAgent: DraftStore.confirm('dft_123') → Order


t=+Xs   Cliente: "no, mejor en azul"
         → InteractionAgent: DraftStore.update('dft_123', { color: 'azul' })
         → "De acuerdo, Nike Air 42 Azul, ₡18,500. ¿La confirmo?"
```

---

## Flujo RESTRICTED: Hint sin Ejecución

```
t=0ms   SPEECH_PARTIAL: "procesa el reembolso de..."
         → L2: refund_create (0.85) → safety=RESTRICTED
         → NO ejecuta nada
         → cache.setHint(sessionId, 'refund_create', 0.85)
         → Posible: pre-cargar contexto del cliente si VoiceIdentifier identificó speaker


t=150ms SPEECH_FINAL: "procesa el reembolso de la orden 4521 por ₡15,000"
         → InteractionAgent: cache.getHint() → { intent: 'refund_create', confidence: 0.85 }
         → SafetyGuard.evaluate('refund_create', { amount: 15000 }, speaker=customer)
         → decision: ESCALATE → required_role: 'manager'
         → ApprovalOrchestrator.orchestrate(request, channels)
         → "Necesito la aprobación del gerente para procesar este reembolso."
```

---

## Migración desde examples/

El prototipo funcional ya existe en `examples/agent-comparison/`. Sprint 2.2 lo migra a packages:

```
examples/agent-comparison/src/intent-teacher.ts
  → packages/dispatcher/src/intent-teacher.ts
  Cambios: instructionPrompt inyectable (sin business logic hardcoded)

examples/agent-comparison/src/intent-score-store.ts
  → packages/dispatcher/src/intent-score-store.ts
  Cambios: Redis backend para producción, InMemory para tests

examples/agent-comparison/src/node-dispatcher.ts
  → packages/dispatcher/src/node-dispatcher.ts (ya existe como base)
  Cambios: integrar SpeculativeCache + SafetyGuard
```

Sprint 2.1 crea `SpeculativeCache` desde cero (no existe prototype — solo la lógica en comments del dispatcher).

---

## Archivos del Package `packages/dispatcher`

```
packages/dispatcher/src/
├── node-dispatcher.ts          # Dispatcher principal — integra L1/L2/L3 + SpeculativeCache
├── speculative-cache.ts        # NUEVO Sprint 2.1 — LRU + TTL
├── intent-teacher.ts           # MIGRAR Sprint 2.2 — Teacher con instructionPrompt configurable
├── intent-score-store.ts       # MIGRAR Sprint 2.2 — EMA por tool
├── intent-library.ts           # Redis/JSON vector store de ejemplos
├── keyword-classifier.ts       # L1 — regex patterns
├── embedding-classifier.ts     # L2 — cosine similarity
└── index.ts                    # Exports públicos
```

---

## Ver también

- [ARCHITECTURE-V2.md](ARCHITECTURE-V2.md) — cómo encaja el dispatcher en la arquitectura completa
- [SAFETY-MODEL.md](SAFETY-MODEL.md) — niveles safe/staged/protected/restricted con ejemplos
- [plans/SPRINTS-V2.md](../plans/SPRINTS-V2.md) — Sprint 2.1 (SpeculativeCache) y Sprint 2.2 (Teacher + ScoreStore)
