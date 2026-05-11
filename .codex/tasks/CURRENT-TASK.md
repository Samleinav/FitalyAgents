# TASK BUG-01 — Fix: doble confirmación en checkout shortcut

**Skill:** `$store-runtime-dev`
**Branch:** `feat/store-agent-golden-path`
**Prioridad:** P0 — bug en producción

## Síntoma

El usuario dice "quiero pagar con tarjeta". El agente responde "Tengo listo el cobro.
Preparo el pago?". El usuario responde cualquier cosa (pregunta, frase, afirmación no
exacta) y el agente dice "No entendi. Tengo listo el cobro. Preparo el pago?" — loop.

## Causa raíz

`payment_intent_create` tiene `safety: 'protected'`. Cuando `handleStoreShortcutIntent`
lo llama via `interaction.handleToolCall`, `InteractionAgent` crea una confirmación
pendiente y espera "sí" explícito en el siguiente turno.

Pero el usuario YA confirmó con "quiero pagar con tarjeta". La petición al shortcut
path con `requestedMethod !== null` ES el consentimiento — no se necesita un segundo
"sí".

## Fix requerido

### `apps/store-runtime/src/agents/interaction-runtime-agent.ts`

En `handleStoreShortcutIntent`, después del bloque que llama `handleToolCall` para
`payment_intent_create`, el resultado (`result`) puede ser `draft_ready` o
`needs_confirmation`. En ambos casos, auto-confirmar inmediatamente con "si" ya que
el método de pago fue explícito:

```ts
const result = await this.deps.toolRegistry.runWithContext(executionContext, () =>
  this.deps.interaction.handleToolCall(
    'payment_intent_create',
    { order_id: order.id, amount: total, payment_method: requestedMethod },
    event.session_id, event.speaker_id, event.role,
  ),
)

// Si quedó pendiente de confirmación, auto-confirmar — el usuario ya
// expresó su intención explícitamente al decir el método de pago.
if (result.type === 'draft_ready' || result.type === 'needs_confirmation') {
  await this.deps.toolRegistry.runWithContext(executionContext, async () => {
    await this.deps.interaction.handleProtectedConfirm(event.session_id, 'si')
  })
  return true
}

await this.handleToolResults(event.session_id, [result])
return true
```

Si el resultado es `executed` o `cached` (ya aprobado), pasa a `handleToolResults`
normalmente.

### `apps/store-runtime/src/agents/interaction-runtime-agent.test.ts`

Añadir test:
- Shortcut con `requestedMethod = 'card'` → `handleToolCall` retorna `draft_ready`
  → `handleProtectedConfirm` es llamado con `'si'` en el mismo turno
- Shortcut con `requestedMethod = 'cash'` → mismo comportamiento
- Shortcut con `requestedMethod = null` (sin método) → NO auto-confirma, solo pide
  el método (comportamiento existente sin cambio)

## Lo que NO tocar
- El path donde `requestedMethod === null` — ese caso ya funciona bien (pregunta el método)
- `handleCancelIntent`, `handleCorrectionIntent`, `handleVisualSelectionIntent`
- Ningún otro archivo fuera de `interaction-runtime-agent.ts` y su test

## Validación requerida
```bash
pnpm --filter store-runtime type-check
pnpm --filter store-runtime lint
pnpm --filter store-runtime test
```

## Criterio de aceptación
- "quiero pagar con tarjeta" → pago procesado en el mismo turno, sin segunda confirmación
- "quiero pagar con efectivo" → igual, sin esperar "sí"
- "quiero pagar" (sin método) → el agente pregunta el método, sin cambio
- El usuario NO puede quedar atrapado en loop de confirmación de pago
- Tests pasando

## Al terminar
Escribir `.codex/tasks/LAST-RESULT.md` según PROTOCOL.md y hacer commit.
