# Human Roles — FitalyAgents v2

> En v1, los roles estaban en los agentes IA (WorkAgent.role = 'DISPATCHER').
> En v2, los roles están en los **humanos** que interactúan con el sistema.
> Los roles definen **quién puede aprobar qué** y con qué límites.

---

## Los 5 Roles

```
customer   → Cliente de la tienda. Sin permisos de aprobación.
staff      → Vendedor de piso. Sin permisos de aprobación. Puede pedir ayuda al agente.
cashier    → Cajero. Puede aprobar cobros hasta payment_max. Confirma órdenes.
manager    → Gerente de tienda. Puede aprobar reembolsos, descuentos, overrides (con límites).
owner      → Dueño / administrador. Aprueba todo sin restricción. Configura el sistema.
```

---

## Tipos

```typescript
type HumanRole = 'customer' | 'staff' | 'cashier' | 'manager' | 'owner'

interface HumanProfile {
  id: string
  name: string
  role: HumanRole
  store_id: string
  voice_embedding?: Float32Array   // Registrado por VoiceIdentifierAgent
  approval_limits: ApprovalLimits
  is_present?: boolean             // true si VoiceIdentifier lo detectó recientemente
}

interface ApprovalLimits {
  payment_max?: number             // Monto máximo para cobros (undefined = sin permiso)
  discount_max_pct?: number        // Porcentaje máximo de descuento
  refund_max?: number              // Monto máximo para reembolsos
  can_override_price?: boolean     // Puede hacer price override
  can_adjust_inventory?: boolean   // Puede ajustar inventario
}
```

---

## Límites por Defecto

```typescript
const defaultLimits: Record<HumanRole, ApprovalLimits> = {
  customer: {},

  staff: {},
  // Vendedor de piso: no aprueba nada, pero puede preguntar al agente

  cashier: {
    payment_max: 50_000,
    // Puede cobrar hasta ₡50,000 sin aprobación adicional
  },

  manager: {
    payment_max: Infinity,
    discount_max_pct: 30,
    refund_max: 100_000,
    can_override_price: true,
    can_adjust_inventory: true,
    // ₡100,000 límite en reembolsos — más grande requiere owner
  },

  owner: {
    payment_max: Infinity,
    discount_max_pct: 100,
    refund_max: Infinity,
    can_override_price: true,
    can_adjust_inventory: true,
    // Sin restricciones
  },
}
```

Los límites son configurables por tienda en el dashboard de FitalyStore.

---

## Cómo se Identifica el Rol

### 1. Por voz (VoiceIdentifierAgent)

Los empleados se registran con su voz (3-5 frases de ejemplo en el dashboard):

```
Setup:
  Gerente abre dashboard → "Registrar empleado"
  → Empleado dice 3-5 frases al micrófono
  → Sistema genera voice_embedding (parecido a como face ID funciona)
  → Asocia: embedding + nombre + rol + store_id

En operación:
  Alguien habla → VoiceIdentifierAgent
    → cosine similarity vs embeddings registrados
    → ¿match? → speaker = HumanProfile (con rol)
    → ¿no match? → speaker = { role: 'customer', id: 'anon_xxx' }
```

### 2. Por sesión (dashboard o app)

El empleado inicia sesión en la app → su `HumanProfile` queda activo para el `store_id`.

### 3. Fallback: desconocido = customer

Si `VoiceIdentifierAgent` no reconoce la voz → `role = 'customer'` → sin permisos de aprobación.

---

## SafetyGuard + Roles

`SafetyGuard.evaluate()` usa el rol del speaker para decidir si puede ejecutar directamente o necesita escalar:

```typescript
// roleHasPermission compara tool.required_role con speaker.role + limits
function roleHasPermission(
  speaker: HumanProfile,
  toolName: string,
  params: Record<string, unknown>
): boolean {
  const tool = toolRegistry.get(toolName)
  const limits = speaker.approval_limits

  // Ejemplo: payment_process
  if (toolName === 'payment_process') {
    return (limits.payment_max ?? 0) >= (params.amount as number)
  }

  // Ejemplo: refund_create
  if (toolName === 'refund_create') {
    return (limits.refund_max ?? 0) >= (params.amount as number)
  }

  // Ejemplo: price_override
  if (toolName === 'price_override') {
    return limits.can_override_price === true
  }

  // rol owner siempre puede
  if (speaker.role === 'owner') return true

  return false
}
```

---

## Permisos por Acción

| Acción | customer | staff | cashier | manager | owner |
|---|:---:|:---:|:---:|:---:|:---:|
| product_search | ✅ | ✅ | ✅ | ✅ | ✅ |
| price_check | ✅ | ✅ | ✅ | ✅ | ✅ |
| order_create (draft) | ✅ | ✅ | ✅ | ✅ | ✅ |
| payment_process ≤ ₡50k | ❌ | ❌ | ✅ | ✅ | ✅ |
| payment_process > ₡50k | ❌ | ❌ | ❌ | ✅ | ✅ |
| order_confirm | ❌ | ❌ | ✅ | ✅ | ✅ |
| refund_create ≤ ₡100k | ❌ | ❌ | ❌ | ✅ | ✅ |
| refund_create > ₡100k | ❌ | ❌ | ❌ | ❌ | ✅ |
| discount_apply ≤ 30% | ❌ | ❌ | ❌ | ✅ | ✅ |
| discount_apply > 30% | ❌ | ❌ | ❌ | ❌ | ✅ |
| price_override | ❌ | ❌ | ❌ | ✅ | ✅ |
| inventory_adjustment | ❌ | ❌ | ❌ | ✅ | ✅ |
| config_agent | ❌ | ❌ | ❌ | ❌ | ✅ |
| manage_employees | ❌ | ❌ | ❌ | ❌ | ✅ |

---

## Escalación Automática

Cuando el speaker no tiene el rol requerido, `SafetyGuard` devuelve una decisión de escalación:

```
Escalación:
  1. ¿Hay alguien con el rol requerido identificado por voz en la tienda?
     → SÍ: VoiceChannel pregunta por voz ("María, ¿apruebas...?")
     → NO: WebhookChannel notifica por app

  2. Si múltiples canales configurados → ApprovalOrchestrator.orchestrate()
     → parallel: voz + app al mismo tiempo, primero que responde gana
     → sequential: voz primero, app como fallback

  3. Si nadie responde en approval_timeout_ms:
     → bus:ORDER_APPROVAL_TIMEOUT
     → InteractionAgent: "No fue posible obtener aprobación. Intente más tarde."
```

---

## Escenarios Concretos

### Escenario A: Cliente pide cobro (sin empleado en piso)

```
Cliente: "Cóbrame"
→ SafetyGuard: speaker=customer → NO tiene permiso para payment_process
→ ApprovalOrchestrator: busca cajero o gerente
→ is_present=false para todos → WebhookChannel
→ Notificación push a app del cajero/gerente
→ "No hay cajero disponible ahora. Le notificaré cuando alguien apruebe."
```

### Escenario B: Cajero identifica su voz y pide cobro

```
Cajero (María): "Fitaly, cobra la orden 4521"
→ VoiceIdentifierAgent: speaker=María, role=cashier, payment_max=50_000
→ SafetyGuard: amount=15_000 ≤ 50_000 → SÍ tiene permiso
→ Ejecutar directamente
→ "Cobro de ₡15,000 procesado. Orden 4521."
```

### Escenario C: Cajero pide reembolso (no tiene permiso)

```
Cajero (María): "Fitaly, reembolso de la orden 4521"
→ SafetyGuard: payment_process → cashier ok | refund_create → cashier NO
→ ApprovalOrchestrator: required_role=manager
→ VoiceChannel: "Don Carlos, ¿aprueba reembolso de ₡15,000?"
→ WebhookChannel: notificación app (en paralelo)
→ Don Carlos responde por voz: "Sí, aprobado"
→ "El reembolso fue aprobado por el gerente."
```

### Escenario D: Gerente da descuento del 25%

```
Gerente (Carlos): "Fitaly, dale 25% de descuento a este cliente"
→ VoiceIdentifierAgent: speaker=Carlos, role=manager, discount_max_pct=30
→ SafetyGuard: 25% ≤ 30% → SÍ tiene permiso
→ Ejecutar directamente
→ "Descuento del 25% aplicado. Total: ₡11,250."
```

### Escenario E: Gerente intenta descuento del 40% (fuera de límite)

```
Gerente (Carlos): "Fitaly, dale 40% de descuento"
→ SafetyGuard: 40% > 30% (límite del manager) → NO tiene permiso
→ ApprovalOrchestrator: required_role=owner
→ VoiceChannel + WebhookChannel
→ "Descuentos mayores al 30% requieren aprobación del dueño."
```

---

## Dashboard por Rol

| Vista | customer | staff | cashier | manager | owner |
|---|:---:|:---:|:---:|:---:|:---:|
| Ver conversación activa | ❌ | ❌ | ✅ | ✅ | ✅ |
| Aprobar/rechazar (tap) | ❌ | ❌ | ✅ | ✅ | ✅ |
| Ver órdenes del día | ❌ | ❌ | ✅ | ✅ | ✅ |
| Ver métricas del día | ❌ | ❌ | ❌ | ✅ | ✅ |
| Aprobar remotamente (app) | ❌ | ❌ | ✅ | ✅ | ✅ |
| Ver analytics (Insights) | ❌ | ❌ | ❌ | ✅ | ✅ |
| Gestionar empleados | ❌ | ❌ | ❌ | ❌ | ✅ |
| Configurar agente | ❌ | ❌ | ❌ | ❌ | ✅ |
| Ver todos los locales | ❌ | ❌ | ❌ | ❌ | ✅ |
| Facturación | ❌ | ❌ | ❌ | ❌ | ✅ |

---

## Registro de Empleados

El dueño registra empleados desde el dashboard de FitalyStore:

```
1. Dashboard → Empleados → Agregar
2. Ingresar nombre y rol
3. "Registrar voz": empleado dice 5 frases al micrófono
   → VoiceIdentifierAgent genera voice_embedding
   → Guarda en HumanProfile con store_id
4. Confirmar límites (usar defaults o personalizar)
5. Empleado queda activo — VoiceIdentifierAgent lo reconoce automáticamente
```

Los límites por defecto son los del rol, pero el dueño puede ajustarlos por empleado:
```
María (cajero) → payment_max personalizado: ₡80,000 (en lugar de ₡50,000 default)
```
