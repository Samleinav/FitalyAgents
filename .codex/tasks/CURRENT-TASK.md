# TASK GP-01 — Visual IDs en customer display y selección natural

**Skill:** `$store-runtime-dev`
**Branch:** `feat/store-agent-golden-path`
**Prioridad:** P0

## Contexto

El customer display ya muestra productos en `state.suggestions` cuando `product_search`
devuelve resultados (`customer-display-state.ts:applyToolResult`). Pero los productos no
tienen ID visual corto (A1, A2...), y el agente no sabe resolver cuando el cliente dice
"el A2" o "el primero".

## Cambios requeridos

### 1. `apps/store-runtime/src/retail/ui/customer-display-state.ts`

Añadir `visualId: string` a la interfaz `CustomerDisplaySuggestion`:

```ts
export interface CustomerDisplaySuggestion {
  id: string
  visualId: string   // 'A1', 'A2', ... 'A6'
  name: string
  price: number
  description: string
  stock?: number
}
```

En la función `readProductSuggestions`, asignar `visualId` en orden:
`visualId = 'A' + (index + 1)` → A1, A2, A3, A4, A5, A6 (máx 6).

### 2. `apps/store-runtime/src/retail/ui/customer-display-page.ts`

En el HTML del product grid, mostrar el `visualId` como badge prominente junto al nombre.
Estilo sugerido: `[A1]` en negrita antes del nombre del producto.

### 3. `apps/store-runtime/src/agents/interaction-runtime-agent.ts`

**3a. Mapa de última lista visible por sesión:**

Añadir propiedad privada en la clase:
```ts
private lastProductList = new Map<string, CustomerDisplaySuggestion[]>()
```

Añadir `'bus:TOOL_RESULT'` a `channels`.

En `onEvent`, cuando `channel === 'bus:TOOL_RESULT'`:
```ts
const e = payload as { tool_name?: string; session_id?: string; result?: unknown }
if ((e.tool_name === 'product_search' || e.tool_name === 'inventory_check') && e.session_id) {
  const products = extractSuggestionsFromResult(e.result)
  if (products.length > 0) {
    this.lastProductList.set(e.session_id, products)
  }
}
```

Implementar `extractSuggestionsFromResult(result: unknown): CustomerDisplaySuggestion[]`
que lea `result.products` o `result` como array y mapee igual que `readProductSuggestions`,
incluyendo el `visualId`.

**3b. Resolución de intent visual antes del LLM:**

Añadir función `resolveVisualIdSelection(text: string, sessionId: string): CustomerDisplaySuggestion | null`
que detecte:

- `A1`, `A2`...`A6` (con o sin artículo: "el A2", "la A1", "A3 por favor")
- Ordinales: `el primero` → índice 0, `el segundo` → 1, `el tercero` → 2, `el cuarto` → 3
- Atributo único si solo un producto coincide: `el azul`, `el nike`, `el barato`
  (el más barato = precio mínimo), `el caro` (precio máximo)

Si retorna producto, llamar directamente `order_create` vía `handleToolCall` con:
```ts
{ product_id: product.id, name: product.name, quantity: 1, price: product.price }
```
y retornar sin pasar al LLM.

Insertar este check en `onEvent` **antes** de `handleStoreShortcutIntent`.

Si no hay lista activa para la sesión, retornar `null` (pasa al LLM normalmente).

## Lo que NO tocar
- `packages/core/` — no tocar
- `apps/store-deploy-center/` — no tocar
- Tipos del bus de eventos existentes
- Lógica de draft/approval existente

## Validación requerida
```bash
pnpm --filter store-runtime type-check
pnpm --filter store-runtime lint
pnpm --filter store-runtime test
```

## Criterio de aceptación
- `CustomerDisplaySuggestion.visualId` existe y vale `A1`...`A6`
- Agent resuelve "el A2" → selecciona segundo producto de la lista activa en sesión
- Agent resuelve "el primero" → selecciona primer producto
- Agent resuelve "el azul" cuando solo hay un producto azul en la lista
- Si no hay lista activa, la resolución retorna null y el flujo continúa normal

## Al terminar
Escribir `.codex/tasks/LAST-RESULT.md` según el PROTOCOL.md y hacer commit.
