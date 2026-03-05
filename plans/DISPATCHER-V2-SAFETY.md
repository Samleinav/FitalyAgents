# Dispatcher v2 + Interaction Agent — Arquitectura con Safety Model

> El dispatcher es un acelerador especulativo.
> El LLM rápido es el cerebro.
> No todo se puede disparar antes de tiempo.
> Fecha: 2026-03-05

---

## 1. Principio de Seguridad: Clasificación de Tools por Riesgo

La pregunta central: ¿qué pasa si el dispatcher dispara algo y el cliente
se arrepiente, o el dispatcher se equivocó?

**Regla:** La seguridad no depende del dispatcher. Depende del tool.
Cada tool/agent declara su nivel de riesgo en su manifiesto.

```
SAFE (dispatcher puede disparar speculativamente)
  → Solo lectura. Sin efectos secundarios. Cancelable sin costo.
  → Ejemplos: product_search, price_check, inventory_check, store_hours

STAGED (dispatcher puede preparar, pero no ejecutar)
  → Crea un draft/preview. No ejecuta hasta confirmación.
  → Ejemplos: order_create → order_draft, cart_add → cart_preview

PROTECTED (solo el Interaction Agent con confirmación del cliente)
  → Modifica estado real. Requiere aprobación explícita.
  → Ejemplos: payment_process, refund_create, order_confirm, account_update

RESTRICTED (requiere aprobación de empleado/sistema)
  → Alto impacto. Doble confirmación.
  → Ejemplos: bulk_discount, price_override, inventory_adjustment
```

---

## 2. Cómo se Declara en el Manifiesto del Agent/Tool

```typescript
const orderAgent: AgentManifest = {
  agent_id: 'order_agent',
  capabilities: [
    {
      name: 'ORDER_CREATE',
      safety: 'staged',        // ← el dispatcher solo crea draft
      staged_action: 'draft',  // ← acción que el dispatcher puede hacer
      confirm_action: 'confirm', // ← acción que requiere confirmación
      rollback_action: 'cancel', // ← acción para deshacer
      ttl_seconds: 300,        // ← draft expira en 5 min si no se confirma
    },
    {
      name: 'ORDER_STATUS',
      safety: 'safe',          // ← dispatcher puede disparar libremente
    },
    {
      name: 'ORDER_CANCEL',
      safety: 'protected',     // ← requiere confirmación del cliente
      confirm_prompt: '¿Está seguro que desea cancelar su orden?',
    }
  ]
}

const paymentAgent: AgentManifest = {
  agent_id: 'payment_agent',
  capabilities: [
    {
      name: 'PAYMENT_PROCESS',
      safety: 'restricted',    // ← requiere aprobación de empleado
      approval_channel: 'bus:ORDER_PENDING_APPROVAL',
      approval_timeout_ms: 120000,
    },
    {
      name: 'REFUND_CREATE',
      safety: 'restricted',
      approval_channel: 'bus:ORDER_PENDING_APPROVAL',
      confirm_prompt: '¿Confirma el reembolso de {amount}?',
    }
  ]
}
```

---

## 3. Pipeline Completo: Quién Dispara Qué

```
SPEECH_PARTIAL llega:
    │
    └── Dispatcher speculative classify (10ms)
        │
        ├── intent=product_search, safety=SAFE
        │   → DISPARA tools inmediatamente
        │   → Resultado va al cache
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
        │   ├── SAFE tool result en cache → usa directo
        │   │   "Sí, tenemos Nike Air en talla 42"
        │   │
        │   ├── STAGED draft en cache → presenta al cliente
        │   │   "Tengo su orden lista: Nike Air 42, ₡15,000.
        │   │    ¿La confirmo?"
        │   │   → Cliente dice sí → confirm_action
        │   │   → Cliente dice no → rollback_action
        │   │   → Cliente modifica → update draft → re-presentar
        │   │
        │   ├── PROTECTED/RESTRICTED intent detectado → pide confirmación
        │   │   "Para procesar el pago necesito que confirme.
        │   │    ¿Procedemos con ₡15,000?"
        │   │   → Cliente confirma → Agent ejecuta con approval flow
        │   │
        │   └── No hay cache → LLM llama tools normalmente
        │
        └── Tool calls del LLM alimentan al Teacher como correcciones
```

---

## 4. El Ciclo de Vida del Draft (STAGED tools)

```
           Cliente dice "quiero la Nike azul 42"
                         │
                         ▼
              Dispatcher: ORDER_CREATE detected
              safety=staged → crea ORDER_DRAFT
                         │
                         ▼
                   ┌─────────────┐
                   │ ORDER_DRAFT │ ← TTL 5 min
                   │             │
                   │ items: [{   │
                   │   Nike Air, │
                   │   42, azul  │
                   │   ₡15,000   │
                   │ }]          │
                   │ status:     │
                   │  'draft'    │
                   └──────┬──────┘
                          │
              Interaction Agent presenta al cliente:
              "Tengo lista: Nike Air 42 azul, ₡15,000.
               ¿La confirmo?"
                          │
           ┌──────────────┼──────────────────┐
           ▼              ▼                  ▼
     "Sí, dale"    "No, mejor rojo"    "Agrega esto
                                        también"
           │              │                  │
           ▼              ▼                  ▼
      CONFIRM          UPDATE             UPDATE
    order_draft     order_draft.       order_draft.
    → ORDER real    items[0].color     items.push(...)
                    = 'rojo'
                         │                  │
                         ▼                  ▼
                   Re-presenta         Re-presenta
                   "Nike Air 42       "Nike Air 42 +
                    ROJO, ₡15,000.     Combo, ₡22,000.
                    ¿Ahora sí?"        ¿Confirmo?"
                         │                  │
                         └────────┬─────────┘
                                  ▼
                          Cliente confirma
                                  │
                                  ▼
                          ORDER_CONFIRM
                          → Orden real creada
                          → payment flow si aplica
```

### Si el cliente se arrepiente completamente:

```
Cliente: "No, olvídalo"
    │
    ▼
Interaction Agent detecta cancelación
    │
    ▼
ROLLBACK: order_draft.cancel()
    │
    ▼
Draft eliminado del cache
TTL también lo eliminaría automáticamente en 5 min
    │
    ▼
"Perfecto, lo cancelé. ¿Puedo ayudarle en algo más?"
```

### Si el draft expira (cliente se fue):

```
TTL de 5 min se cumple
    │
    ▼
Draft auto-eliminado
No se creó ninguna orden real
Cero impacto
```

---

## 5. Matriz de Decisión del Dispatcher Speculative

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

## 6. Flujos Concretos por Caso

### Caso 1: SAFE — Búsqueda de producto (ideal para speculative)

```
t=0ms     PARTIAL: "quiero ver zapatos"
t=10ms    Dispatcher: product_search (0.91) → SAFE → EJECUTA
t=300ms   Tool retorna: [{Nike Air, ₡15k}, {Adidas Ultra, ₡12k}]
t=500ms   FINAL: "quiero ver zapatos nike talla 42"
t=580ms   LLM: "¡Claro!" → TTS (filler natural, no artificial)
t=600ms   LLM: tool_call product_search("nike", 42)
          → CACHE HIT parcial: ya tiene Nike, re-filtra por talla
t=650ms   LLM: "Tenemos Nike Air en 42, ₡15,000"

Ahorro real: ~250ms. Sin riesgo.
```

### Caso 2: STAGED — Crear orden (draft speculative, confirmar después)

```
t=0ms     PARTIAL: "ponme la nike azul cuarenta y dos"
t=10ms    Dispatcher: order_create (0.88) → STAGED → crea DRAFT
t=200ms   Draft listo: {items: [Nike Air, 42, azul], total: ₡15,000}
t=500ms   FINAL: "ponme la nike azul cuarenta y dos"
t=580ms   LLM: consulta cache → draft existe
t=600ms   LLM: "Tengo lista su orden: Nike Air 42 azul, ₡15,000.
                ¿La confirmo?"
t=800ms   Cliente: "Sí, dale"
t=900ms   LLM: order_confirm(draft_id) → PROTECTED step
          → ApprovalQueue si requiere pago
          → o confirma directo si es solo reserva

Ahorro: draft ya estaba listo cuando el LLM lo necesitó.
Seguridad: nunca se creó una orden real sin confirmación.
```

### Caso 3: STAGED — Cliente cambia de opinión

```
t=0ms     "ponme la nike azul cuarenta y dos"
t=10ms    Dispatcher: draft creado
t=600ms   LLM: "Nike Air 42 azul, ₡15,000. ¿La confirmo?"
t=800ms   Cliente: "no, mejor la roja"
t=900ms   LLM: detecta modificación, NO cancelación
          → order_draft.update(color: 'rojo')
t=950ms   LLM: "Perfecto, Nike Air 42 ROJA, mismo precio. ¿Ahora sí?"
t=1100ms  Cliente: "sí"
t=1200ms  LLM: order_confirm(draft_id)

El draft es mutable hasta que se confirma.
El cliente puede modificar N veces sin crear órdenes fantasma.
```

### Caso 4: STAGED — Cliente cancela todo

```
t=0ms     "quiero una nike"
t=10ms    Dispatcher: draft creado
t=600ms   LLM: "Nike Air, ₡15,000. ¿La confirmo?"
t=800ms   Cliente: "no, olvídalo"
t=900ms   LLM: detecta cancelación → order_draft.cancel(draft_id)
t=950ms   LLM: "Sin problema. ¿Puedo ayudarle en algo más?"

Draft eliminado. Cero impacto en el sistema.
```

### Caso 5: PROTECTED — Cobro requiere confirmación explícita

```
t=0ms     "cóbrame"
t=10ms    Dispatcher: payment_process (0.93) → PROTECTED → NO DISPARA
          Solo marca en cache: {probable_intent: 'payment'}
t=500ms   FINAL: "cóbrame lo de la orden"
t=580ms   LLM: detecta intent de pago
          → NO ejecuta payment_process directamente
          → Primero verifica: ¿hay orden activa?
t=600ms   LLM: "Su orden es Nike Air 42 azul, ₡15,000.
                ¿Confirma el cobro?"
t=800ms   Cliente: "Sí"
t=900ms   LLM: payment_process(order_id, ₡15,000)
          → Ejecuta AHORA con confirmación explícita

El dispatcher NO aceleró nada aquí. Y está bien.
Un cobro incorrecto cuesta mucho más que 250ms de latencia.
```

### Caso 6: RESTRICTED — Reembolso requiere empleado

```
t=0ms     "quiero un reembolso"
t=10ms    Dispatcher: refund_create → RESTRICTED → NO DISPARA
t=500ms   FINAL
t=580ms   LLM: "Entiendo. Para procesar el reembolso necesito
                verificar su orden. ¿Cuál es el número?"
t=800ms   Cliente: "la del viernes"
t=900ms   LLM: order_search → encuentra orden
t=1000ms  LLM: "Encontré su orden #4521 por ₡15,000.
                Voy a solicitar el reembolso. Un empleado
                debe aprobarlo."
t=1100ms  LLM: refund_request(order_id)
          → bus:ORDER_PENDING_APPROVAL
          → Empleado recibe notificación
          → Cuando aprueba → bus:ORDER_APPROVED
          → Interaction Agent: "Su reembolso fue aprobado,
            el monto se verá reflejado en 24-48 horas."

Múltiples pasos de seguridad. Dispatcher no interviene.
```

### Caso 7: Dispatcher se equivoca (speculative erróneo)

```
t=0ms     PARTIAL: "quiero ver..."
t=10ms    Dispatcher: product_search (0.87) → SAFE → ejecuta
          → tool busca productos genéricos
t=500ms   FINAL: "quiero ver el estado de mi pedido"
t=580ms   LLM: intent real = order_status, NO product_search
          → Ignora cache del dispatcher (intent diferente)
          → Ejecuta order_status normalmente
t=600ms   Teacher: registra corrección
          → product_search guessed, order_status actual
          → Teacher evalúa: ¿agregar "quiero ver el estado"
            como ejemplo de order_status?

Costo del error: 1 tool call desperdiciado (product_search)
= unos centavos de API, cero impacto al cliente.
El LLM siempre tiene la última palabra.
```

---

## 7. Implementación: SafetyGuard en el Dispatcher

```typescript
class DispatcherV2 {
  private classifier: EmbeddingClassifier
  private toolCache: LRUCache<string, ToolResult>
  private draftStore: DraftStore  // Redis con TTL
  private teacher: IntentTeacher

  async onSpeechPartial(event: SpeechPartialEvent): Promise<void> {
    const result = await this.classifier.classify(event.text)

    if (result.confidence < 0.90 || result.margin < 0.15) {
      return // No lo suficientemente seguro para speculative
    }

    const safety = this.getSafetyLevel(result.intent_id)

    switch (safety) {
      case 'safe':
        // Ejecutar tool y cachear resultado
        const toolResult = await this.executeTool(result)
        this.toolCache.set(cacheKey(event.session_id, result.intent_id), toolResult)
        break

      case 'staged':
        // Crear draft, NO ejecutar acción real
        const draft = await this.createDraft(result, event.session_id)
        this.draftStore.set(event.session_id, draft, { ttl: 300 })
        break

      case 'protected':
      case 'restricted':
        // NO hacer nada, solo registrar hint
        this.toolCache.set(
          `hint:${event.session_id}`,
          { probable_intent: result.intent_id, confidence: result.confidence }
        )
        break
    }
  }

  // El Interaction Agent consulta esto
  async getSpeculativeResult(
    sessionId: string,
    intentId: string
  ): Promise<SpeculativeResult | null> {
    // Buscar en cache de tools (SAFE)
    const cached = this.toolCache.get(cacheKey(sessionId, intentId))
    if (cached) return { type: 'tool_result', data: cached }

    // Buscar draft (STAGED)
    const draft = await this.draftStore.get(sessionId)
    if (draft && draft.intent_id === intentId) {
      return { type: 'draft', data: draft }
    }

    // Buscar hint (PROTECTED/RESTRICTED)
    const hint = this.toolCache.get(`hint:${sessionId}`)
    if (hint) return { type: 'hint', data: hint }

    return null
  }
}
```

---

## 8. Implementación: Interaction Agent con Safety

```typescript
class InteractionAgentV2 {
  private llm: GroqStreamingClient  // Llama 3.1 8B o similar
  private dispatcher: DispatcherV2
  private approvalQueue: ApprovalQueue

  async onSpeechFinal(event: SpeechFinalEvent): Promise<void> {
    // 1. Consultar cache del dispatcher
    const speculative = await this.dispatcher.getSpeculativeResult(
      event.session_id, null // null = buscar cualquier intent
    )

    // 2. Construir contexto para el LLM
    const context = await this.buildContext(event, speculative)

    // 3. LLM streaming con tool calling
    const stream = await this.llm.stream({
      model: 'llama-3.1-8b-instant',
      messages: context.messages,
      tools: context.tools,
      stream: true,
    })

    // 4. Procesar stream
    for await (const chunk of stream) {
      if (chunk.type === 'text') {
        // Enviar a TTS inmediatamente
        await this.tts.feed(chunk.text)
      }

      if (chunk.type === 'tool_call') {
        await this.handleToolCall(chunk, event.session_id, speculative)
      }
    }
  }

  private async handleToolCall(
    toolCall: ToolCall,
    sessionId: string,
    speculative: SpeculativeResult | null
  ): Promise<ToolResult> {
    const safety = this.getSafetyLevel(toolCall.name)

    // SAFE: ¿ya lo tiene el dispatcher?
    if (safety === 'safe' && speculative?.type === 'tool_result') {
      // Cache hit — usar resultado especulativo
      this.teacher.recordMatch(toolCall.name) // dispatcher acertó
      return speculative.data
    }

    // STAGED: ¿hay draft?
    if (safety === 'staged' && speculative?.type === 'draft') {
      // Presentar draft al cliente para confirmación
      return {
        type: 'draft_ready',
        draft: speculative.data,
        needs_confirmation: true,
        confirm_prompt: `Tengo listo: ${speculative.data.summary}. ¿Confirmo?`
      }
    }

    // PROTECTED: pedir confirmación al cliente
    if (safety === 'protected') {
      return {
        type: 'needs_confirmation',
        action: toolCall.name,
        confirm_prompt: this.getConfirmPrompt(toolCall),
        // El LLM preguntará al cliente y solo ejecutará si confirma
      }
    }

    // RESTRICTED: enviar a ApprovalQueue
    if (safety === 'restricted') {
      const approvalId = await this.approvalQueue.submit({
        action: toolCall.name,
        params: toolCall.arguments,
        session_id: sessionId,
      })
      return {
        type: 'pending_approval',
        approval_id: approvalId,
        message: 'Un empleado debe aprobar esta acción.',
      }
    }

    // SAFE sin cache: ejecutar normalmente
    const result = await this.executeTool(toolCall)

    // Registrar como corrección si dispatcher predijo diferente
    if (speculative && speculative.data?.probable_intent !== toolCall.name) {
      this.teacher.recordCorrection(
        speculative.data.probable_intent,
        toolCall.name,
        /* original text */
      )
    }

    return result
  }
}
```

---

## 9. DraftStore — Órdenes Mutables con TTL

```typescript
class DraftStore {
  // Redis con TTL automático

  async create(sessionId: string, draft: Draft): Promise<string> {
    const draftId = `draft_${crypto.randomUUID()}`
    await this.redis.json.set(`drafts:${draftId}`, '$', {
      ...draft,
      id: draftId,
      session_id: sessionId,
      status: 'draft',
      created_at: Date.now(),
      history: []  // Historial de cambios
    })
    // TTL: auto-elimina si nadie confirma
    await this.redis.expire(`drafts:${draftId}`, draft.ttl_seconds ?? 300)

    // Índice por sesión para lookup rápido
    await this.redis.set(`draft_session:${sessionId}`, draftId, 'EX', 300)
    return draftId
  }

  async update(draftId: string, changes: Partial<Draft>): Promise<Draft> {
    const current = await this.redis.json.get(`drafts:${draftId}`)
    if (!current || current.status !== 'draft') {
      throw new DraftNotMutableError(draftId)
    }

    // Guardar estado anterior en historial
    await this.redis.json.arrAppend(`drafts:${draftId}`, '$.history', {
      timestamp: Date.now(),
      previous: current.items,
    })

    // Aplicar cambios
    for (const [key, value] of Object.entries(changes)) {
      await this.redis.json.set(`drafts:${draftId}`, `$.${key}`, value)
    }

    // Renovar TTL
    await this.redis.expire(`drafts:${draftId}`, 300)
    return await this.redis.json.get(`drafts:${draftId}`)
  }

  async confirm(draftId: string): Promise<Order> {
    const draft = await this.redis.json.get(`drafts:${draftId}`)
    if (!draft || draft.status !== 'draft') {
      throw new DraftNotFoundError(draftId)
    }

    // Marcar como confirmado (ya no mutable)
    await this.redis.json.set(`drafts:${draftId}`, '$.status', 'confirmed')

    // Crear orden real desde el draft
    const order = await this.orderService.createFromDraft(draft)

    // Limpiar draft
    await this.redis.del(`draft_session:${draft.session_id}`)

    return order
  }

  async cancel(draftId: string): Promise<void> {
    await this.redis.del(`drafts:${draftId}`)
    // Nada más que limpiar. No se creó nada real.
  }

  async rollback(draftId: string): Promise<Draft> {
    const draft = await this.redis.json.get(`drafts:${draftId}`)
    if (!draft?.history?.length) throw new NothingToRollbackError()

    const previous = draft.history[draft.history.length - 1]
    await this.redis.json.set(`drafts:${draftId}`, '$.items', previous.previous)
    await this.redis.json.arrPop(`drafts:${draftId}`, '$.history')

    return await this.redis.json.get(`drafts:${draftId}`)
  }
}
```

---

## 10. Resumen de Seguridad por Nivel

```
SAFE (lectura)
├── Dispatcher: dispara en PARTIAL sin restricción
├── Rollback: no necesario (no modifica nada)
├── Error del dispatcher: costo = 1 API call desperdiciado
└── Ejemplos: search, price, inventory, hours, status

STAGED (escritura reversible)
├── Dispatcher: crea DRAFT en PARTIAL, nunca ejecuta
├── Rollback: draft.cancel() o TTL auto-expira
├── Confirmación: Interaction Agent presenta y pregunta
├── Mutabilidad: cliente puede modificar N veces antes de confirmar
├── Error del dispatcher: draft se descarta, cero impacto
└── Ejemplos: order_create, cart_add, reservation_create

PROTECTED (escritura irreversible con confirmación de cliente)
├── Dispatcher: NO dispara, solo marca hint
├── Rollback: depende del tool (refund, cancel policy)
├── Confirmación: Interaction Agent DEBE preguntar al cliente
├── Error del dispatcher: imposible (no ejecutó nada)
└── Ejemplos: payment, order_confirm, account_delete

RESTRICTED (requiere aprobación externa)
├── Dispatcher: NO dispara, solo marca hint
├── Rollback: ApprovalQueue con reject/timeout
├── Confirmación: empleado o sistema aprueba
├── Error del dispatcher: imposible (no ejecutó nada)
└── Ejemplos: refund, price_override, bulk_operations
```

---

## 11. Lo que Cambia vs el Dispatcher Actual

```
ELIMINAR:
├── CapabilityRouter complejo (LLM decide routing)
├── LLMFallbackAgent como proceso separado (LLM principal = fallback)
└── Cascada de 5 niveles (simplificada a 2: speculative + LLM)

MANTENER:
├── EmbeddingClassifier (con upgrade multilingüe)
├── IntentTeacher (aprende de correcciones del LLM)
├── ScoreStore (tracking accuracy)
├── LRU Cache (ahora para tool results + drafts)
└── IntentLibrary en Redis (sigue creciendo con correcciones)

AGREGAR:
├── SafetyGuard (classifica tools por riesgo)
├── DraftStore (staged actions con TTL y rollback)
├── Speculative cache (tool results pre-computados)
├── SPEECH_PARTIAL listener (speculative dispatch)
└── Langfuse integration (observability)

CAMBIAR DE ROL:
├── Dispatcher: de "cerebro" a "acelerador especulativo"
├── Interaction Agent: de "presenta resultados" a "cerebro con LLM streaming"
└── Teacher: de "aprende del fallback" a "aprende del LLM principal"
```
