# Safety Model — FitalyAgents v2

> Cada tool declara su nivel de riesgo. La seguridad no depende del dispatcher — depende del tool.

---

## Los 4 Niveles

```
SAFE
  → Solo lectura. Sin efectos secundarios. Cancelable sin costo.
  → Dispatcher puede disparar speculativamente en SPEECH_PARTIAL.
  → Ejemplos: product_search, price_check, inventory_check, store_hours, order_status

STAGED
  → Crea un draft/preview. No ejecuta hasta confirmación del cliente.
  → Dispatcher puede crear el draft en SPEECH_PARTIAL.
  → Draft es mutable: cliente puede modificar N veces antes de confirmar.
  → Ejemplos: order_create → order_draft, cart_add → cart_preview

PROTECTED
  → Modifica estado real. Requiere confirmación explícita del cliente.
  → Dispatcher NO dispara nada. Solo registra hint.
  → Interaction Agent pregunta: "¿Confirma el cobro de ₡15,000?"
  → Ejemplos: payment_process, order_confirm, account_update, order_cancel

RESTRICTED
  → Alto impacto. Requiere aprobación de empleado con rol suficiente.
  → Dispatcher NO dispara nada.
  → ApprovalOrchestrator coordina canal(es) de aprobación.
  → Ejemplos: refund_create, price_override, bulk_discount, inventory_adjustment
```

---

## Declaración en ToolDefinition

```typescript
const tools: ToolDefinition[] = [
  // SAFE — dispatcher dispara libremente
  {
    name: 'product_search',
    description: 'Busca productos por marca, talla, color, categoría',
    safety: 'safe',
    parameters: { brand: 'string?', size: 'number?', color: 'string?' },
    executor: { type: 'http', url: '/api/products/search' },
    timeout_ms: 5000,
  },

  // STAGED — dispatcher crea draft, cliente debe confirmar
  {
    name: 'order_create',
    description: 'Crea una orden de compra',
    safety: 'staged',
    staged_action: 'draft',
    confirm_action: 'confirm',
    rollback_action: 'cancel',
    ttl_seconds: 300,
    parameters: { items: 'array', customer_id: 'string?' },
    executor: { type: 'http', url: '/api/orders' },
    timeout_ms: 8000,
  },

  // PROTECTED — cliente debe confirmar explícitamente
  {
    name: 'payment_process',
    description: 'Procesa un pago',
    safety: 'protected',
    confirm_prompt: '¿Confirma el cobro de {amount}?',
    parameters: { order_id: 'string', amount: 'number' },
    executor: { type: 'http', url: '/api/payments' },
    timeout_ms: 30000,
  },

  // RESTRICTED — empleado con rol suficiente debe aprobar
  {
    name: 'refund_create',
    description: 'Crea un reembolso',
    safety: 'restricted',
    required_role: 'manager',
    approval_channels: [
      { type: 'voice',   timeout_ms: 15_000 },
      { type: 'webhook', timeout_ms: 90_000 },
    ],
    approval_strategy: 'parallel',
    approval_timeout_ms: 120_000,
    parameters: { order_id: 'string', amount: 'number', reason: 'string' },
    executor: { type: 'http', url: '/api/refunds' },
    timeout_ms: 30000,
  },
]
```

---

## Matriz de Decisión

```
┌─────────────────┬──────────┬──────────┬──────────┬──────────────┐
│                 │   SAFE   │  STAGED  │ PROTECTED│  RESTRICTED  │
├─────────────────┼──────────┼──────────┼──────────┼──────────────┤
│ SPEECH_PARTIAL  │ Ejecutar │ Draft    │ NO       │ NO           │
│ conf > 0.90     │ → cache  │ → cache  │          │              │
├─────────────────┼──────────┼──────────┼──────────┼──────────────┤
│ SPEECH_PARTIAL  │ NO       │ NO       │ NO       │ NO           │
│ conf < 0.90     │          │          │          │              │
├─────────────────┼──────────┼──────────┼──────────┼──────────────┤
│ SPEECH_FINAL    │ Ejecutar │ Draft    │ Hint     │ Hint         │
│ dispatcher      │ (o cache)│ (o cache)│ solo     │ solo         │
├─────────────────┼──────────┼──────────┼──────────┼──────────────┤
│ LLM tool_call   │ Ejecutar │ Presentar│ Pedir    │ ApprovalOrch │
│                 │ directo  │ draft    │ confirm  │ → canal(es)  │
└─────────────────┴──────────┴──────────┴──────────┴──────────────┘
```

---

## DraftStore — Lifecycle completo

```
Cliente: "quiero la Nike azul 42"
               │
               ▼
    Dispatcher: ORDER_CREATE detected (safety=staged)
    → DraftStore.create(sessionId, draft)
               │
               ▼
         ┌──────────────┐
         │  ORDER_DRAFT │  ← TTL 5 min (auto-expira si nadie confirma)
         │  Nike Air    │
         │  42 azul     │
         │  ₡15,000     │
         │  status:draft│
         └──────┬───────┘
                │
    InteractionAgent presenta:
    "Tengo lista: Nike Air 42 azul, ₡15,000. ¿Confirmo?"
                │
     ┌──────────┼───────────────────┐
     ▼          ▼                   ▼
  "Sí"       "No, rojo"        "Agrega esto"
     │          │                   │
     ▼          ▼                   ▼
 CONFIRM     UPDATE              UPDATE
 → orden     color='rojo'        items.push(...)
   real
             │                   │
             ▼                   ▼
          Re-presenta         Re-presenta
          "Nike ROJA          "Nike + Combo
           ¿Ahora sí?"         ¿Confirmo?"
```

### API DraftStore

```typescript
class DraftStore {
  create(sessionId: string, draft: DraftInput): Promise<string>
  // → devuelve draftId
  // → auto-expira en draft.ttl_seconds (default 300)

  update(draftId: string, changes: Partial<DraftData>): Promise<Draft>
  // → guarda estado anterior en historial
  // → renueva TTL

  confirm(draftId: string): Promise<Order>
  // → marca status='confirmed' (ya no mutable)
  // → crea orden real desde el draft
  // → limpia índice de sesión

  cancel(draftId: string): Promise<void>
  // → elimina draft
  // → nada que rollback (nunca se creó nada real)

  rollback(draftId: string): Promise<Draft>
  // → revierte al estado anterior del historial
}
```

---

## SafetyGuard — Evaluación

```typescript
class SafetyGuard {
  evaluate(
    action: string,
    params: Record<string, unknown>,
    speaker: SpeakerProfile,
    context: SessionContext
  ): SafetyDecision

  // SafetyDecision:
  //   { allowed: true,  execute: true }                    ← SAFE o rol suficiente
  //   { allowed: true,  execute: false, action: 'draft' }  ← STAGED
  //   { allowed: false, reason: 'needs_confirmation' }     ← PROTECTED sin confirmar
  //   { allowed: false, reason: 'needs_approval',          ← RESTRICTED
  //     escalate_to: HumanRole, channels: ChannelConfig[] }
}
```

### Cortocircuito por rol del speaker

Si el **speaker ya tiene el rol requerido**, `SafetyGuard` ejecuta directamente sin pasar por `ApprovalOrchestrator`:

```
RESTRICTED tool: refund_create, required_role: 'manager'

Speaker = cliente (rol: customer)
  → SafetyGuard: NO tiene permiso
  → ApprovalOrchestrator: buscar manager

Speaker = María (rol: cashier, refund_max: undefined)
  → SafetyGuard: NO tiene permiso para refunds
  → ApprovalOrchestrator: buscar manager

Speaker = Don Carlos (rol: manager, refund_max: 100_000)
  → SafetyGuard: amount=15_000 ≤ 100_000 → SÍ tiene permiso
  → Ejecutar directamente (el speaker ES la aprobación)
```

---

## Flujos concretos

> Los casos están organizados en dos grupos:
> **Ventas** — intents que mueven dinero o crean órdenes.
> **Soporte y atención** — intents que resuelven problemas, recomiendan o hacen seguimiento.

---

### GRUPO A — Ventas

#### Caso 1 — SAFE: búsqueda de producto (speculative)

```
t=0ms    PARTIAL: "quiero ver zapatos"
t=10ms   Dispatcher: product_search (0.91) → SAFE → ejecuta
t=310ms  Tool retorna: [Nike Air, Adidas Ultra, ...]
t=500ms  FINAL: "quiero ver zapatos nike talla 42"
t=510ms  LLM: tool_call product_search("nike", 42)
         → CACHE HIT → 0ms
t=560ms  LLM: "Tenemos Nike Air en talla 42, ₡15,000"
```

#### Caso 2 — STAGED: crear orden + modificar

```
t=0ms    PARTIAL: "ponme la nike azul cuarenta y dos"
t=10ms   Dispatcher: order_create (0.88) → STAGED → draft
t=200ms  Draft: {items:[Nike Air, 42, azul], total:₡15k}
t=500ms  FINAL
t=510ms  LLM: "Nike Air 42 azul, ₡15,000. ¿Confirmo?"
t=700ms  Cliente: "no, mejor roja"
t=800ms  LLM: DraftStore.update(draftId, {color:'rojo'})
t=830ms  LLM: "Nike Air 42 ROJA, ₡15,000. ¿Ahora sí?"
t=950ms  Cliente: "sí"
t=960ms  LLM: DraftStore.confirm(draftId) → orden real
```

#### Caso 3 — PROTECTED: cobro con confirmación

```
t=0ms    FINAL: "cóbrame lo de la orden"
t=500ms  LLM: detecta intent de pago → safety=PROTECTED
         → NO ejecuta payment directamente
         → Verifica: ¿hay orden activa?
t=600ms  LLM: "Su orden es Nike Air 42 azul, ₡15,000. ¿Confirma el cobro?"
t=800ms  Cliente: "sí"
t=900ms  LLM: payment_process(order_id, 15000) → ejecuta
```

#### Caso 4 — RESTRICTED: reembolso con aprobación de gerente

```
t=0ms    FINAL: "quiero un reembolso"
t=500ms  LLM: detecta intent → safety=RESTRICTED
         → SafetyGuard: speaker=cliente → NO tiene permiso
         → LLM recopila info: "¿Cuál es el número de orden?"
t=800ms  Cliente: "la del viernes, orden #4521"
t=900ms  LLM: order_search → orden #4521, ₡15,000
t=1000ms LLM: "Voy a solicitar el reembolso. Un empleado debe aprobarlo."
         → refund_request(order_id: '#4521', amount: 15000)
         → SafetyGuard → ApprovalOrchestrator
         → VoiceChannel: "Don Carlos, ¿aprueba reembolso de ₡15,000?"
         → WebhookChannel: push notification a app (en paralelo)
t=12000ms Don Carlos (voz): "sí, aprobado"
          → VoiceChannel gana → cancela WebhookChannel
          → bus:APPROVAL_RESOLVED {channel_used: 'voice', approved: true}
t=12100ms LLM: "Su reembolso fue aprobado. Se verá reflejado en 24-48 horas."
```

#### Caso 5 — RESTRICTED: cajero pide cobro (ejecuta directo)

```
t=0ms    Cajero María (voz identificada): "Fitaly, cobra la orden 4521"
         → VoiceIdentifierAgent: speaker=María, role=cashier
t=500ms  LLM: payment_process(order_id: '4521')
         → SafetyGuard:
             required_role = 'cashier'
             speaker.role  = 'cashier'
             amount=15,000 ≤ payment_max=50,000
             → SÍ tiene permiso
         → Ejecutar directamente (María ES la aprobación)
t=600ms  "Cobro procesado, ₡15,000 orden 4521."
```

---

### GRUPO B — Soporte y Atención al Cliente

> Estos casos no mueven dinero directamente.
> La mayoría son SAFE (lectura) o STAGED (crean ticket/solicitud para revisión humana).

#### Caso 6 — SAFE: seguimiento de pedido

```
t=0ms    Cliente: "¿cuándo llega mi pedido?"
t=10ms   Dispatcher: order_tracking (0.93) → SAFE → ejecuta
t=200ms  Tool retorna: {order: '#4521', status: 'en camino', eta: 'mañana 10am'}
t=500ms  FINAL: "¿cuándo llega mi pedido del viernes?"
t=510ms  LLM: tool_call order_tracking()
         → CACHE HIT → 0ms
t=560ms  LLM: "Su pedido #4521 está en camino. Llega mañana antes de las 10am."

Safety: SAFE
Intent: order_tracking
Dispatcher: especula libremente
No requiere aprobación.
```

#### Caso 7 — SAFE: consulta de política de devolución

```
t=0ms    Cliente: "¿puedo devolver algo si no me queda?"
t=10ms   Dispatcher: knowledge_search (0.89) → SAFE → ejecuta
         → RAG sobre documentos de la tienda (política de devoluciones)
t=300ms  Tool retorna: "Devoluciones en 30 días con ticket de compra..."
t=500ms  FINAL
t=560ms  LLM: "Claro, puede devolver productos en un plazo de 30 días
               presentando el ticket de compra. ¿Desea hacer una devolución ahora?"

Safety: SAFE
Intent: knowledge_search (RAG sobre docs de la tienda)
No requiere aprobación. El dueño sube las políticas al dashboard.
```

#### Caso 8 — SAFE: recomendación entre categorías

```
t=0ms    Cliente: "tengo las Nike Air Max, ¿qué medias me recomiendas para correr?"
t=10ms   Dispatcher: product_recommend (0.87) → SAFE → ejecuta
         → busca medias compatibles con running
t=400ms  Tool retorna: [{Medias Nike Pro, ₡3,500}, {Medias Compresión, ₡4,200}]
t=500ms  FINAL
t=560ms  LLM: "Para las Nike Air Max corriendo, le recomiendo las Medias Nike Pro
               (₡3,500) — diseñadas para running con acolchado en talón.
               ¿Le agrego unas a su compra?"

Safety: SAFE
Intent: product_recommend
Dispatcher: especula en SPEECH_PARTIAL.
El LLM cruza información del contexto (producto que el cliente ya tiene) con el catálogo.
```

#### Caso 9 — SAFE: comparación de productos

```
t=0ms    Cliente: "¿cuál es mejor para la lluvia, la Nike o la Adidas?"
t=10ms   Dispatcher: product_compare (0.91) → SAFE → ejecuta
         → obtiene ficha técnica de ambos modelos
t=300ms  Tool retorna: {nike: {impermeabilidad: 8/10}, adidas: {impermeabilidad: 7/10}}
t=500ms  FINAL
t=560ms  LLM: "Para lluvia, la Nike Waterproof tiene mejor impermeabilidad (8/10)
               y suela antideslizante. La Adidas es más liviana pero menos resistente
               al agua. ¿Le muestro la Nike en su talla?"

Safety: SAFE
Intent: product_compare
No requiere ninguna aprobación. Solo lee fichas técnicas del catálogo.
```

#### Caso 10 — STAGED: registrar reclamo (ticket de soporte)

```
t=0ms    Cliente: "mi producto llegó dañado"
t=10ms   Dispatcher: support_ticket_create (0.85) → STAGED → draft
         → draft con tipo=daño, estado=pendiente
t=500ms  FINAL: "me llegó el paquete aplastado y el producto dañado"
t=560ms  LLM: detecta reclamo → consulta draft del dispatcher
         → "Lamento mucho eso. Voy a registrar un reclamo. ¿Me da el número de su orden?"
t=800ms  Cliente: "orden #4521"
t=900ms  LLM: DraftStore.update(draftId, {order_id:'#4521', description:'producto dañado en envío'})
t=950ms  LLM: "Registraré un reclamo de daño para la orden #4521.
               Un empleado lo revisará y le contactaremos.
               ¿Confirma el registro?"
t=1100ms Cliente: "sí"
t=1200ms LLM: DraftStore.confirm(draftId) → soporte crea ticket real
         LLM: "Reclamo #8823 registrado. Un agente le responderá en 24 horas."

Safety: STAGED (crea ticket borrador, no se envía sin confirmación del cliente)
Intent: support_ticket_create
Dispatcher: crea draft especulativo en SPEECH_PARTIAL.
```

#### Caso 11 — SAFE: estado de un reclamo previo

```
t=0ms    Cliente: "¿en qué va mi reclamo?"
t=10ms   Dispatcher: support_ticket_status (0.88) → SAFE → ejecuta
         → busca último ticket activo del cliente (por voz identificada o sesión)
t=200ms  Tool retorna: {ticket: '#8823', status: 'en revisión', assigned_to: 'soporte_nivel2'}
t=500ms  FINAL
t=560ms  LLM: "Su reclamo #8823 está en revisión por nuestro equipo de soporte nivel 2.
               Le responderán antes del viernes. ¿Necesita algo más?"

Safety: SAFE
No requiere aprobación. Es lectura del estado del ticket.
VoiceIdentifierAgent puede identificar al cliente recurrente para contexto automático.
```

#### Caso 12 — STAGED: registrar aviso de stock ("avísame cuando llegue")

```
t=0ms    Cliente: "¿cuándo llegan los Nike en talla 41?"
t=10ms   Dispatcher: inventory_check (0.93) → SAFE → ejecuta
t=200ms  Tool retorna: {stock: 0, expected_restock: 'sin fecha'}
t=500ms  FINAL
t=560ms  LLM: "Lamentablemente no tenemos Nike en talla 41 ahora y no tenemos
               fecha estimada. ¿Quiere que le avisemos cuando lleguen?"
t=800ms  Cliente: "sí, por favor"
t=900ms  LLM: tool_call notify_register({product:'Nike Air', size:41, contact: session_id})
         → STAGED draft: {type:'stock_notify', product:'Nike Air', size:41}
t=950ms  LLM: "¿Le aviso por WhatsApp o correo?"
t=1100ms Cliente: "WhatsApp al 8888-1234"
t=1200ms LLM: DraftStore.update(draftId, {channel:'whatsapp', contact:'8888-1234'})
t=1250ms LLM: "¿Confirmo que le aviso por WhatsApp al 8888-1234 cuando lleguen las Nike talla 41?"
t=1400ms Cliente: "sí"
t=1500ms LLM: DraftStore.confirm(draftId) → registro de notificación creado

Safety: STAGED (el cliente confirma antes de que se guarde su contacto)
```

#### Caso 13 — SAFE + STAGED: atención al cliente con contexto acumulado (multi-turno)

```
Visita 1 — semana pasada:
  Cliente: "¿tienen las Nike Air en rojo?"
  → VoiceIdentifierAgent: speaker desconocido → anon_001
  → LLM: "Sí, las tenemos. ¿Las quiere ver?"
  → ContextBuilderAgent: guarda {product_interest:'Nike Air rojo', speaker:'anon_001'}

Visita 2 — hoy (misma voz):
  VoiceIdentifierAgent: speaker = anon_001 (reconocido por embedding)
  ContextBuilderAgent: restaura contexto → interest='Nike Air rojo'

  Cliente: "vine la semana pasada, ¿siguen teniendo las rojas?"
  → Dispatcher: product_search (SAFE) → SPEECH_PARTIAL
  → LLM tiene contexto: "el cliente preguntó por Nike Air rojo"
  → LLM: tool_call product_search({brand:'Nike Air', color:'rojo'})
  → "¡Hola de nuevo! Sí, seguimos teniendo las Nike Air en rojo, talla 42. ¿Las apartamos?"

Safety: SAFE (búsqueda) + STAGED si decide apartar
Requiere: VoiceIdentifierAgent (identifica cliente recurrente) + ContextBuilderAgent (restaura historial)
```

#### Caso 14 — SAFE: FAQ de la tienda

```
t=0ms    Cliente: "¿a qué hora abren el domingo?"
t=10ms   Dispatcher: knowledge_search (0.94) → SAFE → ejecuta
         → RAG sobre configuración de la tienda
t=150ms  Tool retorna: "Domingos: 10am - 6pm"
t=500ms  FINAL
t=520ms  LLM: tool_call store_hours() → CACHE HIT
t=540ms  LLM: "Los domingos abrimos de 10am a 6pm. ¿Hay algo en lo que pueda ayudarle?"

Safety: SAFE
Más rápido que cualquier empleado respondería. Cero costo de aprobación.
El dueño configura horarios en el dashboard — el agente los conoce automáticamente.
```

#### Caso 15 — RESTRICTED: excepción de política (requiere gerente)

```
t=0ms    Cliente: "compré hace 45 días, ¿puedo devolver igual?"
t=500ms  LLM: knowledge_search → política: "devoluciones en 30 días"
t=600ms  LLM: "Nuestra política es de 30 días. Su compra fue hace 45 días,
               fuera del plazo normal. Puedo consultar con el gerente
               si puede hacer una excepción. ¿Quiere que lo consulte?"
t=800ms  Cliente: "sí, por favor"
t=900ms  LLM: policy_exception_request(type='return_window', order_id, days_over=15)
         → RESTRICTED (excepciones de política requieren manager)
         → ApprovalOrchestrator: required_role='manager'
         → VoiceChannel: "Don Carlos, cliente quiere devolver fuera de plazo (45 días). ¿Autoriza?"
t=25000ms Don Carlos: "sí, caso por caso, dale"
t=25100ms LLM: "El gerente autorizó la excepción. ¿Desea proceder con la devolución ahora?"

Safety: RESTRICTED
El agente nunca promete excepciones sin aprobación.
El empleado tiene contexto completo antes de decidir.
```

---

## Nueva tabla de tools por tipo de uso

```
VENTAS:
  product_search       SAFE    Buscar productos
  price_check          SAFE    Consultar precio
  inventory_check      SAFE    Ver disponibilidad
  product_compare      SAFE    Comparar dos productos
  product_recommend    SAFE    Recomendar por contexto
  order_create         STAGED  Crear orden (draft primero)
  notify_register      STAGED  "Avísame cuando llegue"
  payment_process      PROTECTED Cobrar (cliente confirma)
  order_confirm        PROTECTED Confirmar orden
  refund_create        RESTRICTED Reembolso (gerente aprueba)
  price_override       RESTRICTED Override precio (owner)
  bulk_discount        RESTRICTED Descuento masivo (manager)

SOPORTE:
  order_tracking       SAFE    Estado de envío
  support_ticket_status SAFE   Estado de reclamo previo
  knowledge_search     SAFE    RAG sobre políticas, FAQ, docs
  store_hours          SAFE    Horarios de la tienda
  support_ticket_create STAGED Registrar reclamo (cliente confirma)
  review_create        STAGED  Dejar calificación (cliente confirma)
  policy_exception_request RESTRICTED Excepción de política (manager)
  account_update       PROTECTED Actualizar datos del cliente
```

---

## Bus Events del Safety Module

```
bus:DRAFT_CREATED          → {draft_id, session_id, intent_id, summary, ttl}
bus:DRAFT_CONFIRMED        → {draft_id, session_id, order_id}
bus:DRAFT_CANCELLED        → {draft_id, session_id, reason}
bus:ORDER_PENDING_APPROVAL → {draft_id, session_id, action, amount, required_role}
bus:APPROVAL_VOICE_REQUEST → {request_id, draft_id, approver_id, prompt_text}
bus:APPROVAL_WEBHOOK_REQUEST → {request_id, draft_id, required_role, amount}
bus:APPROVAL_EXTERNAL_REQUEST  → {request_id, draft_id, payload}
bus:APPROVAL_EXTERNAL_RESPONSE → {request_id, approved, approver_id, reason?}
bus:APPROVAL_RESOLVED      → {request_id, draft_id, approved, approver_id, channel_used}
bus:ORDER_APPROVED         → {draft_id, session_id, approved_by, channel_used}
bus:ORDER_APPROVAL_REJECTED → {draft_id, session_id, reason}
bus:ORDER_APPROVAL_TIMEOUT → {draft_id, session_id}
```
