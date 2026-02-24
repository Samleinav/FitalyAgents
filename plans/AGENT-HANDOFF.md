# Agent Handoff — Consideraciones para el siguiente agente

> Última actualización: 2026-02-23  
> Estado: **Phase 0 COMPLETA** — `@fitalyagents/asynctools` funcional y testeado  
> Siguiente: **Phase 1 (Sprint 1.1) — NexusAgent + IEventBus**

---

## 📌 Estado actual resumido

Phase 0 está **100% implementada** (Sprints 0.1–0.6):

| Sprint | Qué | Estado | Tests |
|--------|-----|--------|-------|
| 0.1 | Monorepo, tooling, tipos base Zod | ✅ | 15 |
| 0.2 | ToolRegistry | ✅ | 35 |
| 0.3 | ExecutorPool + HttpExecutor + FunctionExecutor + SubprocessExecutor | ✅ | 11 |
| 0.4 | InMemoryPendingStateTracker | ✅ | 24 |
| 0.5 | InjectionManager + AsyncAgent | ✅ | 6 |
| 0.6 | Build, README, example | ✅ | — |

**Total: 91 tests pasando, build ESM+CJS+DTS exitoso.**

---

## ⚠️ Consideraciones técnicas que NO están en los planes

### 1. Patrón de wrapping del input en los executors

Los ejecutores (`HttpExecutor`, `FunctionExecutor`, `SubprocessExecutor`) reciben el input **envuelto** por `ExecutorPool` en un objeto:

```typescript
{
  __executor_config: toolDef.executor,  // { type, url, method, headers, ... }
  __payload: input                       // el input real del usuario
}
```

Esto es un detalle de implementación interno. **Si se crea un nuevo executor**, debe extraer `__executor_config` y `__payload` del input recibido. El `ExecutorPool.executeWithRetry()` siempre envuelve así antes de llamar a `executor.execute()`.

### 2. FunctionExecutor usa un registry global

`FunctionExecutor` no recibe la función directamente desde `ToolDefinition`. En cambio, hay un **registry global de handlers**:

```typescript
import { registerFunctionHandler, clearFunctionHandlers } from './function-executor.js'

registerFunctionHandler('my_tool_id', (input) => { ... })
```

Esto es porque las funciones no se pueden serializar en JSON. Si alguien hace `ToolRegistry.fromFile()`, el handler se registra aparte. Este patrón se mantiene para los tests con `clearFunctionHandlers()` en `afterEach`.

### 3. El `inject_when_ready` solo resuelve con `completed`, no con `failed`

La lógica en `InMemoryPendingStateTracker.isResolved()`:
- `inject_when_all` → true cuando TODOS son terminal (`completed | failed | timed_out`)
- `inject_when_ready` → true solo cuando hay al menos un `completed` (NO cuenta `failed`)
- `inject_on_timeout` → true cuando `Date.now() - created_at >= global_timeout_ms`

Esto es intencional: si usas `inject_when_ready`, quieres ver al menos un resultado exitoso antes de continuar.

### 4. TTL de orphan cleanup en tracker

`InMemoryPendingStateTracker` tiene un TTL configurable (default 60s) que borra turns automáticamente. Los timers usan `.unref()` para no bloquear el exit del proceso. Al borrar un turn con `deleteTurn()`, el timer se cancela.

### 5. El barrel export usa `.js` en los paths de importación

Todos los imports internos usan extensión `.js` aunque los archivos son `.ts`:

```typescript
export { ToolRegistry } from './registry/tool-registry.js'
```

Esto es porque TypeScript con `moduleResolution: "bundler"` no rewrite extensions. `tsup` se encarga de resolver. **No cambiar a `.ts` o sin extensión** — romperá el build.

### 6. El package.json de asynctools tiene `"type": "module"`

Por ser ESM-first. Los subpath exports siguen el orden `types → import → require` (corregido respecto al original).

### 7. Tests HTTP del ExecutorPool usan servidor real, no mocks

`executor-pool.test.ts` levanta un `http.createServer()` en `127.0.0.1:0` (port aleatorio) para tests HTTP. No usa `msw` ni nock. Esto es más fiable pero puede ser más lento. Si se necesitan tests más rápidos, considerar mocking.

### 8. AsyncAgent.run() tiene protección anti-loop

`maxTurns` (default 10) previene que un LLM que siempre retorna `tool_calls` haga un loop infinito. Cuando se agota, retorna `{ content: 'Agent reached maximum...', stop_reason: 'max_tokens' }`.

### 9. El global timeout del AsyncAgent usa `AbortController` pero NO lo propaga a los tools individuales

El `globalTimeoutMs` del AsyncAgent solo detecta timeout a nivel del loop general. Los tools individuales tienen su propio `timeout_ms` en `ToolDefinition` que el `ExecutorPool` maneja por separado. Son timeouts independientes.

### 10. `fire_forget` no espera a que el tool termine

Dentro de `AsyncAgent.run()`, los tools `fire_forget` se lanzan con un `.catch(() => {})` swallowed. El agent NO espera a que terminen. El test verifica que se ejecutan con un `await new Promise(r => setTimeout(r, 50))` después del `agent.run()`.

---

## 🔧 Cosas pendientes menores dentro de Phase 0

1. **Adaptadores OpenAI/Anthropic** (`AsyncAgent.fromOpenAI()`, `AsyncAgent.fromAnthropic()`) — marcados como planificados en Sprint 0.5. Solo existe `AsyncAgent.fromFunction()`.
2. **`npm publish --dry-run`** — no ejecutado, requiere npm account.
3. **Git tag `v0.1.0-asynctools`** — no creado.
4. **`typedoc`** — no instalado ni configurado.
5. **`RedisPendingStateTracker`** — marcado como ⏳ en la matriz. Se implementará en Phase 1 cuando se integre con Redis.

---

## 🚀 Siguiente: Sprint 1.1 — NexusAgent Base Class + Bus Abstraction

Referencia: `plans/PLAN-SPRINTS.md` líneas 268+

### Lo que hay que implementar en `packages/core/`:

1. **`IEventBus` interface** — `publish()`, `subscribe()`, `request()` (request-reply)
2. **`RedisBus`** — implementación Redis con `ioredis` (pub/sub channels)
3. **`InMemoryBus`** — para testing sin Redis
4. **`NexusAgent` base class** — el agent del Layer 1 que se registra en el bus
5. **`AgentManifest`** schema — Zod schema para declarar capacidades del agente
6. **`AgentRegistry`** — registro dinámico de agentes en el bus

### Dependencias necesarias para `core/`:
- `ioredis` ya está en `package.json` de core
- `zod` ya está en `package.json` de core
- Puede necesitar `uuid` o `crypto.randomUUID()` para IDs

### Consideraciones para el bus:

- El `PLAN-ARCHITECTURE.md` tiene el **mapa completo de Redis channels** (líneas 1-50 aprox)
- Los JSON schemas de cada evento están en `PLAN-ARCHITECTURE.md`
- El patrón de Redis es Pub/Sub, NO Streams (por ahora)
- El `NexusAgent` debe poder usar `ExecutorPool` de asynctools para sus tools

### Patrón de tests recomendado:

```typescript
// Usar InMemoryBus para tests, no Redis real
const bus = new InMemoryBus()
const agent = new NexusAgent({ bus, manifest: { ... } })
```

---

## 🧭 Referencia rápida a los archivos de planificación

| Archivo | Contenido |
|---------|-----------|
| `plans/PLAN.md` | Visión general, 3 capas, principios, timeline |
| `plans/PLAN-ARCHITECTURE.md` | Redis channels, JSON schemas, event flows, data structures |
| `plans/PLAN-DISPATCHER.md` | Task Dispatcher: classifier + LLM fallback, Node.js + Rust |
| `plans/PLAN-SPRINTS.md` | Checklist completo con estados ✅/⬜/⏳ y matriz de progreso |
| `plans/PROJECT-STRUCTURE.md` | Mapa de archivos, exports, tipos, comandos |

---

## 📋 Reglas de estilo del proyecto

- **Indentación:** 4 espacios (definido en prettier)
- **Semicolons:** NO (prettier `semi: false`)
- **Quotes:** Single quotes (prettier `singleQuote: true`)
- **Trailing commas:** all (prettier `trailingComma: 'all'`)
- **Print width:** 100
- **Commits:** Conventional commits enforced (`feat:`, `fix:`, `chore:`, etc.)
- **TypeScript:** `strict: true` everywhere
- **Module system:** ESM-first, CJS output via tsup
- **Test framework:** Vitest with globals enabled
- **Imports:** Usar `.js` extension en imports TypeScript internos
- **Line endings:** CRLF (Windows) — el repo no lo fuerza, pero los archivos existentes son CRLF

---

## 💡 Tips para el agente

1. **Lee `PLAN-SPRINTS.md` primero** — tiene el checklist exacto de lo que falta
2. **Corre `pnpm run test` y `pnpm run build`** después de cada cambio significativo
3. **Los packages `core` y `dispatcher` están vacíos** — solo tienen scaffolding (package.json, tsconfig, tsup, vitest)
4. **El test script usa `vitest run --passWithNoTests`** en core y dispatcher para no fallar sin tests
5. **No instalar deps nuevas sin necesidad** — el proyecto es zero-dependency excepto `zod` e `ioredis`
6. **Verificar que los imports del barrel export (`index.ts`) cubren todo** lo que se agrega
