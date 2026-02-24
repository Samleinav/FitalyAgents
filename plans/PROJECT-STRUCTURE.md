# Estructura del Proyecto — FitalyAgents Monorepo

> Snapshot actualizado: 2026-02-23

## Raíz del monorepo

```
d:\GitHub\FitalyAgents\
├── .github/workflows/ci.yml       # CI: lint → type-check → test → build (Node 20, 22)
├── .gitignore
├── .nvmrc                          # Node 20
├── README.md                       # Overview del proyecto
├── commitlint.config.js            # Conventional commits (@commitlint/config-conventional)
├── eslint.config.js                # Flat config ESLint + TypeScript
├── package.json                    # Root — scripts: build, test, lint, type-check, prepare
├── pnpm-workspace.yaml             # Workspaces: packages/*, examples/*
├── prettier.config.js              # Sin semicolons, single quotes, trailing commas
├── tsconfig.base.json              # strict: true, ES2022, bundler resolution
├── turbo.json                      # Pipelines: build, test, lint, type-check, dev
├── vitest.config.ts                # Root vitest: globals, V8 coverage
│
├── plans/
│   ├── PLAN.md                     # Visión general, 3 capas, timeline
│   ├── PLAN-ARCHITECTURE.md        # Redis channels, JSON schemas, flows
│   ├── PLAN-DISPATCHER.md          # Task Dispatcher (classifier + LLM fallback)
│   ├── PLAN-SPRINTS.md             # Checklist sprint-by-sprint (con estado ✅/⬜)
│   ├── PROJECT-STRUCTURE.md        # ← ESTE ARCHIVO
│   └── AGENT-HANDOFF.md            # Consideraciones para el próximo agente
│
├── packages/
│   ├── asynctools/                 # Layer 2 — @fitalyagents/asynctools (COMPLETO)
│   ├── core/                       # Layer 1 — @fitalyagents/core (PLACEHOLDER)
│   └── dispatcher/                 # Layer 3 — @fitalyagents/dispatcher (PLACEHOLDER)
│
└── examples/
    └── asynctools-only/            # Ejemplo funcional standalone
```

---

## `packages/asynctools/` — @fitalyagents/asynctools v0.0.1

**Estado: PHASE 0 COMPLETA (Sprints 0.1–0.6)**

```
packages/asynctools/
├── package.json                    # exports: types → import → require
├── tsconfig.json                   # extends ../../tsconfig.base.json
├── tsup.config.ts                  # ESM (.mjs) + CJS (.cjs) + .d.ts, sourcemap
├── vitest.config.ts                # include src/**/*.test.ts, globals
├── README.md                       # Documentación del paquete
│
└── src/
    ├── index.ts                    # Barrel export — API pública completa
    │
    ├── types/
    │   ├── index.ts                # Zod schemas + TypeScript types
    │   └── types.test.ts           # 15 tests — validación de schemas
    │
    ├── errors.ts                   # Jerarquía de errores:
    │                               #   FitalyError (base, tiene .code)
    │                               #   ├── ToolNotFoundError (.toolId)
    │                               #   ├── ToolValidationError (.issues[])
    │                               #   ├── DuplicateToolError (.toolId)
    │                               #   ├── HttpExecutorError (.status, .body, .url)
    │                               #   └── ToolExecutionError (.toolId, .cause, .attempt)
    │
    ├── registry/
    │   ├── tool-registry.ts        # ToolRegistry (register, registerMany, fromFile, fromObject,
    │   │                           #   get, getOrThrow, list, has, unregister, size)
    │   └── tool-registry.test.ts   # 35 tests
    │
    ├── executor/
    │   ├── types.ts                # IExecutor interface { execute(toolId, input, signal?) }
    │   ├── http-executor.ts        # HttpExecutor — fetch nativo, JSON, headers, AbortSignal
    │   ├── function-executor.ts    # FunctionExecutor + registerFunctionHandler() + clearFunctionHandlers()
    │   ├── subprocess-executor.ts  # SubprocessExecutor — child_process.spawn, stdin/stdout JSON
    │   ├── executor-pool.ts        # ExecutorPool — concurrencia por tool, retry exponencial,
    │   │                           #   timeout AbortController, getStats()
    │   └── executor-pool.test.ts   # 11 tests (HTTP real, func sync/async, concurrencia, retry)
    │
    ├── tracking/
    │   ├── types.ts                # IPendingStateTracker interface
    │   ├── in-memory-tracker.ts    # InMemoryPendingStateTracker — TTL cleanup, 3 strategies
    │   └── tracker.test.ts         # 24 tests (todas las strategies, orphan cleanup)
    │
    ├── injection/
    │   └── injection-manager.ts    # InjectionManager — watchTurn, waitForResolution,
    │                               #   formatForReinjection, cancelTurn, dispose
    │
    └── wrapper/
        ├── async-agent.ts          # AsyncAgent — orquestador principal
        │                           #   run(), fromFunction() factory
        └── async-agent.test.ts     # 6 tests E2E (MockLLM: async, sync, fire_forget, mixed, error)
```

### Tipos clave definidos en `types/index.ts`

| Tipo/Schema                | Descripción |
|---------------------------|-------------|
| `ExecutionMode`           | `'sync' \| 'async' \| 'fire_forget' \| 'deferred'` |
| `InjectionStrategy`      | `'inject_when_all' \| 'inject_when_ready' \| 'inject_on_timeout'` |
| `ToolStatus`              | `'pending' \| 'running' \| 'completed' \| 'failed' \| 'timed_out'` |
| `ExecutorType`            | `'http' \| 'ts_fn' \| 'subprocess'` |
| `HttpExecutorConfig`      | `{ type: 'http', url, method, headers? }` |
| `FunctionExecutorConfig`  | `{ type: 'ts_fn', handler? }` |
| `SubprocessExecutorConfig`| `{ type: 'subprocess', command, args, cwd?, env? }` |
| `RetryConfig`             | `{ max_attempts: 1, backoff_ms: 200 }` (defaults) |
| `ToolDefinition`          | Tool completa: `tool_id, executor, execution_mode, timeout_ms, max_concurrent, retry, schemas` |
| `ToolResult`              | `{ tool_call_id, tool_id, status, result?, error?, started_at, completed_at, duration_ms }` |
| `PendingToolCall`         | `{ tool_call_id, tool_id, status, input, created_at }` |
| `TurnState`               | `{ turn_id, agent_id, strategy, global_timeout_ms, tool_calls: Map, results: Map }` |
| `IInnerAgent`             | `{ run(messages: Message[]): Promise<AgentResponse> }` |
| `Message`                 | `{ role, content, tool_call_id? }` |
| `AgentResponse`           | `{ content?, tool_calls?, stop_reason? }` |
| `ExecutorStats`           | `{ executing, queued, completed, failed }` |

### API pública exportada desde `index.ts`

```typescript
// Classes
ToolRegistry, ExecutorPool, AsyncAgent
HttpExecutor, FunctionExecutor, SubprocessExecutor
InMemoryPendingStateTracker, InjectionManager

// Functions
registerFunctionHandler(toolId, handler)
clearFunctionHandlers()

// Interfaces (type-only)
IExecutor, IPendingStateTracker, AsyncAgentOptions

// Errors
FitalyError, ToolNotFoundError, ToolValidationError,
DuplicateToolError, HttpExecutorError, ToolExecutionError

// All Zod schemas + inferred types
```

---

## `packages/core/` — @fitalyagents/core (PLACEHOLDER)

```
packages/core/
├── package.json        # deps: ioredis, zod | test: vitest run --passWithNoTests
├── tsconfig.json
├── tsup.config.ts
├── vitest.config.ts
└── src/
    └── index.ts        # export {} (vacío)
```

**Próximo paso:** Sprint 1.1 — IEventBus, RedisBus, NexusAgent

---

## `packages/dispatcher/` — @fitalyagents/dispatcher (PLACEHOLDER)

```
packages/dispatcher/
├── package.json        # deps: ioredis, zod | test: vitest run --passWithNoTests
├── tsconfig.json
├── tsup.config.ts
├── vitest.config.ts
└── src/
    └── index.ts        # export {} (vacío)
```

**Próximo paso:** Sprint 2.1 — NodeClassifier + EmbeddingClassifier

---

## `examples/asynctools-only/`

```
examples/asynctools-only/
├── package.json        # deps: @fitalyagents/asynctools (workspace:*)
├── tsconfig.json
├── README.md
└── run.ts              # MockShoppingAgent: 3 tools (async + sync + fire_forget)
                        # Ejecutar: npx tsx run.ts
```

---

## Dependencias del monorepo

### Root devDependencies
- `turbo` — build orchestration
- `eslint` + `@typescript-eslint/*` — linting
- `prettier` — formatting
- `husky` + `lint-staged` — pre-commit hooks
- `commitlint` — conventional commits
- `vitest` — testing
- `tsup` — bundling (ESM + CJS + .d.ts)
- `typescript` ~5.8

### asynctools dependencies
- `zod` ^3.24 — runtime schema validation
- `@types/node` ^25.3 (devDep)

### core/dispatcher dependencies
- `ioredis` — Redis client
- `zod` ^3.24

---

## Comandos principales

```bash
# Desde la raíz
pnpm install              # Instalar todo
pnpm run build            # turbo run build (todos los packages)
pnpm run test             # turbo run test
pnpm run lint             # turbo run lint
pnpm run type-check       # turbo run type-check

# Desde un package individual
cd packages/asynctools
npx vitest run            # tests
npx tsup                  # build
npx tsc --noEmit          # type-check

# Ejemplo
cd examples/asynctools-only
npx tsx run.ts
```

## Tests — 91 total (todos ✅)

| File | Tests | Descripción |
|------|-------|-------------|
| `types/types.test.ts` | 15 | Validación de Zod schemas |
| `registry/tool-registry.test.ts` | 35 | ToolRegistry completo |
| `executor/executor-pool.test.ts` | 11 | HTTP real, func, concurrency, retry |
| `tracking/tracker.test.ts` | 24 | 3 strategies, TTL, state transitions |
| `wrapper/async-agent.test.ts` | 6 | E2E con MockLLM |
