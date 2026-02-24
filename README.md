# FitalyAgents

[![CI](https://github.com/your-org/fitalyagents/actions/workflows/ci.yml/badge.svg)](https://github.com/your-org/fitalyagents/actions/workflows/ci.yml)

> *Así como FITALY pone las letras donde los dedos ya están, FitalyAgents pone los resultados donde el agente los necesita — sin esperar.*

SDK TypeScript para orquestación de agentes con herramientas asíncronas paralelas y despacho inteligente de tareas.

## Instalación

```bash
npm install fitalyagents
```

## Uso rápido

### Layer 2 — Async Tools (standalone, sin bus)

```typescript
import { ToolRegistry } from 'fitalyagents/asynctools'

const registry = new ToolRegistry()
registry.register({
  tool_id: 'product_search',
  executor: { type: 'http', url: 'https://api.store.com/search', method: 'POST' },
  execution_mode: 'async',
  timeout_ms: 5000,
})
```

### Layer 1 — Full SDK con bus Redis

```typescript
import { NexusAgent, createBus } from 'fitalyagents'
import { NodeDispatcher } from 'fitalyagents/dispatcher'
```

## Arquitectura

```
┌─────────────────────────────────────────────────────────┐
│                  fitalyagents (npm)                     │
│                                                         │
│  ┌─────────────────────────────────────────────────┐   │
│  │  LAYER 1 — Agent Middleware Bus                 │   │
│  │  AgentRegistry · ContextStore · LockManager     │   │
│  │  CapabilityRouter · SessionManager · TaskQueue  │   │
│  └──────────────────────┬──────────────────────────┘   │
│                         │ usa                           │
│  ┌──────────────────────▼──────────────────────────┐   │
│  │  LAYER 2 — fitalyagents/asynctools (standalone) │   │
│  │  ToolRegistry · ExecutorPool · InjectionManager  │   │
│  │  AsyncAgent wrapper · PendingStateTracker        │   │
│  └─────────────────────────────────────────────────┘   │
│                                                         │
│  ┌─────────────────────────────────────────────────┐   │
│  │  DISPATCHER — fitalyagents/dispatcher           │   │
│  │  NodeDispatcher · EmbeddingClassifier            │   │
│  │  LLMFallbackAgent · IntentLibrary               │   │
│  └─────────────────────────────────────────────────┘   │
└─────────────────────────────────────────────────────────┘
```

## Desarrollo

```bash
# Instalar dependencias
pnpm install

# Build de todos los paquetes
pnpm run build

# Tests
pnpm run test

# Lint
pnpm run lint

# Type check
pnpm run type-check
```

## Stack Técnico

| Decisión | Elección | Razón |
|---|---|---|
| Lenguaje SDK | TypeScript 5.x strict | Tipos completos, mejor DX |
| Monorepo | pnpm workspaces + turbo | Build incremental |
| Bus transport | Redis Pub/Sub | Sub-ms latencia, simple ops |
| Context store | Redis JSON (RedisJSON) | Atomic partial updates, TTL nativo |
| Validación schemas | Zod | Runtime + tipos en uno |
| Testing | vitest | Rápido, compatible con ESM |
| Build | tsup | ESM + CJS, tipos incluidos |

## Licencia

MIT
