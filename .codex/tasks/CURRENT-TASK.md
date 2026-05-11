# TASK GP-05 — Cierre de sesión limpio + alternativas sin stock

**Skill:** `$store-runtime-dev`
**Branch:** `feat/store-agent-golden-path`
**Prioridad:** P1

## Contexto

Dos gaps que cierran el P1:

1. Cuando el cliente se despide, la sesión queda abierta en BD y el display no se limpia.
2. Cuando hay productos agotados, el agente no ofrece alternativas proactivamente.

---

## Cambio 1 — Cierre de sesión en farewell

### `apps/store-runtime/src/agents/interaction-runtime-agent.ts`

En `handleStoreShortcutIntent`, el bloque `isFarewellIntent` actualmente solo habla.
Después de `ttsStream.speakText`, añadir:

```ts
this.deps.sessionRepository.end(event.session_id, {
  closed_by: 'farewell',
  last_user_text: event.text,
})
this.deps.bus.publish('bus:SESSION_ENDED', {
  session_id: event.session_id,
  store_id: event.store_id,
  timestamp: Date.now(),
})
```

`sessionRepository` ya existe en `deps` como `deps.sessionRepository` y tiene método `end()`.
`bus` ya existe en `deps` como `deps.bus`.

### `apps/store-runtime/src/retail/ui/customer-display-state.ts`

Añadir case en `applyCustomerDisplayBusEvent` para `'bus:SESSION_ENDED'`:

```ts
case 'bus:SESSION_ENDED':
  applySessionEnded(next, event, timestamp)
  break
```

Implementar `applySessionEnded`:
- Resetea `sessionId` a `null`
- Resetea `speakerId` a `null`
- Resetea `order` a estado idle (mismos defaults que `createCustomerDisplayState`)
- Limpia `suggestions` a `[]`
- Pone `message` a `null`

---

## Cambio 2 — Alternativas proactivas en sin stock

### `apps/store-runtime/src/retail/preset.ts`

Añadir al system prompt:

```ts
'Cuando muestres productos, si alguno aparece como agotado (stock 0), no lo incluyas ' +
'en tu respuesta oral principal. Si todos estan agotados, dilo claramente y ofrece ' +
'buscar alternativas: usa product_search con un termino relacionado. ' +
'Si hay mezcla de disponibles y agotados, menciona solo los disponibles con sus codigos visuales.',
```

---

## Validación requerida
```bash
pnpm --filter store-runtime type-check
pnpm --filter store-runtime lint
pnpm --filter store-runtime test
```

## Criterio de aceptación
- Farewell → `session_summaries.ended_at` se actualiza en BD
- Farewell → display se limpia (suggestions vacías, order idle, message null)
- System prompt indica al LLM ignorar agotados en respuesta oral
- Tests cubriendo el reset del display en `bus:SESSION_ENDED`

## Al terminar
Escribir `.codex/tasks/LAST-RESULT.md` según PROTOCOL.md y hacer commit.
