# Approval Channels — FitalyAgents v2

> El rol define **quién** puede aprobar. El canal define **cómo** llega la aprobación.
> Los canales son configurables por tool. El sistema los coordina automáticamente.

---

## Concepto Central

Cuando un tool RESTRICTED necesita aprobación, `ApprovalOrchestrator` coordina uno o más canales:

```
Tool RESTRICTED detectado
  → SafetyGuard: ¿speaker ya tiene rol suficiente?
    → SÍ: ejecutar directo (el speaker IS la aprobación)
    → NO: ApprovalOrchestrator.orchestrate(request, channels)
          → lanza canales configurados (parallel o sequential)
          → primer canal en responder → cancela los demás
          → bus:APPROVAL_RESOLVED { approved, approver_id, channel_used }
```

---

## IApprovalChannel

```typescript
interface IApprovalChannel {
  id: string
  type: 'voice' | 'vision' | 'webhook' | 'external_tool'

  /**
   * Notifica al aprobador que hay una acción pendiente.
   * Ej: hablar al empleado, enviar push notification, llamar API externa.
   */
  notify(request: ApprovalRequest, approver: HumanProfile): Promise<void>

  /**
   * Espera la respuesta del aprobador en este canal.
   * Resuelve con ApprovalResponse si responde antes del timeout.
   * Resuelve con null si se agota el tiempo.
   */
  waitForResponse(
    request: ApprovalRequest,
    timeoutMs: number
  ): Promise<ApprovalResponse | null>

  /**
   * Cancela la espera activa (llamado cuando otro canal ya respondió).
   */
  cancel(requestId: string): void
}

interface ApprovalRequest {
  id: string
  draft_id: string
  action: string               // 'refund_create', 'payment_process', etc.
  amount?: number
  session_id: string
  required_role: HumanRole
  context: Record<string, unknown>
  timeout_ms: number
}

interface ApprovalResponse {
  approved: boolean
  approver_id: string
  channel_used: string         // 'voice' | 'webhook' | 'external_tool'
  reason?: string              // si rejected
  timestamp: number
}
```

---

## Los 4 Canales

### 1. VoiceApprovalChannel

El más natural para empleados en piso. Fitaly pregunta en voz alta.

**Notify:**
```
Publica bus:APPROVAL_VOICE_REQUEST
  → AudioQueueService del store genera audio:
    "María, ¿apruebas el reembolso de ₡15,000 para la orden #4521?"
```

**Listen:**
```
Suscribe bus:SPEECH_FINAL donde:
  → VoiceIdentifierAgent confirma speaker == approver esperado
  → NLU simple detecta:
      afirmativo: "sí", "dale", "aprobado", "ok", "confirmo"
      negativo:   "no", "rechaza", "no autorizo", "denegar"
  → Resuelve con { approved: true/false, approver_id, channel_used: 'voice' }
```

**Configuración:**
```typescript
{ type: 'voice', timeout_ms: 15_000 }
// 15 segundos — tiempo razonable si el empleado está en la tienda
```

**Cuándo usarlo:** Empleado está presente físicamente en la tienda.

---

### 2. WebhookApprovalChannel

Para empleados fuera del piso o gerentes remotos. Notificación a app móvil.

**Notify:**
```
Publica bus:APPROVAL_WEBHOOK_REQUEST
  → Push notification a app del empleado con rol requerido
    Título: "Aprobación requerida"
    Cuerpo: "Reembolso ₡15,000 — orden #4521. Tap para aprobar/rechazar"
```

**Listen:**
```
Espera HTTP POST /webhook/approval:
  { action: 'approve', draft_id: 'xxx', approver_id: 'emp_001' }
  o
  { action: 'reject',  draft_id: 'xxx', reason: 'monto incorrecto' }
```

**Configuración:**
```typescript
{ type: 'webhook', timeout_ms: 90_000 }
// 90 segundos — tiempo para que el gerente revise su teléfono
```

**Cuándo usarlo:** Empleado no está físicamente presente, tiene app en teléfono.

---

### 3. ExternalToolChannel

Para integración con sistemas externos: POS, WhatsApp Business, sistema propio.

**Notify:**
```
HTTP POST a URL configurada con payload:
  {
    request_id: 'req_abc',
    action: 'refund_create',
    amount: 15000,
    order_id: '#4521',
    required_role: 'manager',
    store_id: 'store_001',
    timeout_ms: 60000
  }
El sistema externo decide cómo notificar al aprobador.
```

**Listen:**
```
Suscribe bus:APPROVAL_EXTERNAL_RESPONSE donde payload.request_id == request.id
  { request_id, approved: true, approver_id: 'ext_user_123' }
```

**Configuración:**
```typescript
{
  type: 'external_tool',
  timeout_ms: 60_000,
  config: {
    url: 'https://mi-sistema.com/api/approval',
    method: 'POST',
    auth: 'Bearer TOKEN_SECRETO',
  }
}
```

**Cuándo usarlo:**
- Tienda tiene su propio sistema de aprobaciones ya desarrollado
- Integración con WhatsApp Business (el gerente aprueba por WhatsApp)
- Integración con POS que tiene botón de aprobación
- Sistema legado que ya maneja autorizaciones

---

### 4. VisionApprovalChannel *(Sprint futuro)*

Para aprobación por gesto facial o gesture recognition.

**Notify:** Señal visual en pantalla/LED al empleado identificado por cámara.

**Listen:** `VisionDetectorAgent` detecta gesto de aprobación (nod, thumbs up) del empleado identificado.

**Depende de:** FitalyVoice + VisionDetectorAgent (Sprint 5.x).

---

## Estrategias de Coordinación

### `parallel` (default recomendado)

Todos los canales se lanzan simultáneamente. El primero en responder gana y cancela los demás.

```
ApprovalOrchestrator.orchestrate(request, channels, strategy='parallel')
  │
  ├── VoiceChannel.notify() + VoiceChannel.waitForResponse(15s)
  │
  └── WebhookChannel.notify() + WebhookChannel.waitForResponse(90s)
  │
  Empleado responde por voz a los 8 segundos
  → VoiceChannel resuelve { approved: true, channel_used: 'voice' }
  → WebhookChannel.cancel()  ← se cancela inmediatamente
  → bus:APPROVAL_RESOLVED { approved: true, channel_used: 'voice' }
```

**Usar cuando:** Queremos la respuesta más rápida posible.

### `sequential`

Prueba los canales en orden. Si el primero no responde en su timeout, pasa al siguiente.

```
ApprovalOrchestrator.orchestrate(request, channels, strategy='sequential')
  │
  ├── VoiceChannel.waitForResponse(15s)
  │     → timeout (empleado no respondió en 15s)
  │
  └── WebhookChannel.waitForResponse(90s)
        → empleado responde desde app a los 30s
        → { approved: true, channel_used: 'webhook' }
```

**Usar cuando:** Hay un canal preferido (voz) y un fallback (app) si el primero no funciona.

---

## Configuración por Tool

```typescript
const tools: ToolDefinition[] = [
  // Cobro — cajero presente o en app
  {
    name: 'payment_process',
    safety: 'restricted',
    required_role: 'cashier',
    approval_channels: [
      { type: 'voice',   timeout_ms: 15_000 },
      { type: 'webhook', timeout_ms: 90_000 },
    ],
    approval_strategy: 'parallel',
    approval_timeout_ms: 120_000,
  },

  // Reembolso — gerente (límite por rol)
  {
    name: 'refund_create',
    safety: 'restricted',
    required_role: 'manager',
    approval_channels: [
      { type: 'voice',   timeout_ms: 20_000 },
      { type: 'webhook', timeout_ms: 100_000 },
    ],
    approval_strategy: 'parallel',
    approval_timeout_ms: 120_000,
  },

  // Override de precio — dueño o sistema externo
  {
    name: 'price_override',
    safety: 'restricted',
    required_role: 'owner',
    approval_channels: [
      { type: 'external_tool', timeout_ms: 60_000, config: {
          url: 'https://mi-sistema.com/api/approval',
          method: 'POST',
          auth: 'Bearer SECRET',
        }
      },
      { type: 'webhook', timeout_ms: 120_000 },
    ],
    approval_strategy: 'sequential',  // intenta externo primero
    approval_timeout_ms: 180_000,
  },
]
```

---

## ApprovalOrchestrator

```typescript
class ApprovalOrchestrator {
  constructor(deps: {
    bus: IEventBus
    channelRegistry: Map<string, IApprovalChannel>
    defaultTimeoutMs?: number
  })

  start(): Unsubscribe
  // Suscribe bus:ORDER_PENDING_APPROVAL

  async orchestrate(
    request: ApprovalRequest
  ): Promise<ApprovalResponse>
  // Coordina canales según request.approval_strategy
  // Publica bus:APPROVAL_RESOLVED cuando hay respuesta
  // Publica bus:ORDER_APPROVAL_TIMEOUT si todos timeout

  dispose(): void
}
```

---

## Ejemplos de Flujo Completo

### Tienda pequeña — solo webhook

```typescript
const approvalOrchestrator = new ApprovalOrchestrator({
  bus,
  channelRegistry: new Map([
    ['webhook', new WebhookApprovalChannel({ bus })]
  ])
})

// Tool config:
approval_channels: [{ type: 'webhook', timeout_ms: 120_000 }]
```

### Tienda mediana — voz + webhook en paralelo

```typescript
const approvalOrchestrator = new ApprovalOrchestrator({
  bus,
  channelRegistry: new Map([
    ['voice',   new VoiceApprovalChannel({ bus, audioQueue })],
    ['webhook', new WebhookApprovalChannel({ bus })],
  ])
})

// Tool config:
approval_channels: [
  { type: 'voice',   timeout_ms: 15_000 },
  { type: 'webhook', timeout_ms: 90_000 },
]
approval_strategy: 'parallel'
```

### Cadena con sistema de autorizaciones propio

```typescript
const approvalOrchestrator = new ApprovalOrchestrator({
  bus,
  channelRegistry: new Map([
    ['voice',         new VoiceApprovalChannel({ bus, audioQueue })],
    ['webhook',       new WebhookApprovalChannel({ bus })],
    ['external_tool', new ExternalToolChannel({
        bus,
        url: process.env.APPROVAL_API_URL!,
        auth: process.env.APPROVAL_API_TOKEN!,
      })
    ],
  ])
})
```

---

## Backwards Compatibility

`IApprovalQueue` (v1) se mantiene como re-export de `WebhookApprovalChannel`:

```typescript
// packages/core/src/approval/types.ts
export { IApprovalChannel as IApprovalQueue } from '../safety/channels/types.js'
// + re-export ApprovalRecord, ApprovalStatus para no romper código existente
```

Los webhooks existentes (`POST /webhook/approval`) siguen funcionando sin cambios.
