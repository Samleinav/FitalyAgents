# FitalyAgents SDK — Plan Maestro
> *Así como FITALY pone las letras donde los dedos ya están, FitalyAgents pone los resultados donde el agente los necesita — sin esperar.*

---

## ¿Qué es FitalyAgents?

Un SDK TypeScript para orquestación de agentes con herramientas asíncronas paralelas y despacho inteligente de tareas. Se instala como un solo paquete con subpaths:

```bash
npm install fitalyagents
```

```typescript
import { AsyncAgent, ToolRegistry } from 'fitalyagents/asynctools'  // Layer 2 standalone
import { NexusAgent, createBus }     from 'fitalyagents'            // Layer 1 completo
import { NodeDispatcher }            from 'fitalyagents/dispatcher'  // Dispatcher Node.js
```

---

## Arquitectura en tres capas

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
│  │  NodeDispatcher (incluido, default)             │   │
│  │  ┌─ EmbeddingClassifier  (entrenamiento local)  │   │
│  │  ├─ LLMFallbackAgent     (cuando conf < 0.85)   │   │
│  │  ├─ CapabilityRouter     (matching algoritmo)   │   │
│  │  └─ IntentLibrary        (Redis, crece solo)    │   │
│  └─────────────────────────────────────────────────┘   │
└─────────────────────────────────────────────────────────┘

  + dispatcher-core-rust (binario separado, futuro comercial)
    Mismos canales Redis, 10x más rápido, drop-in replacement
```

### Regla de oro — Bus Redis exclusivo
```
TypeScript nunca llama a Rust directamente.
Rust nunca llama a TypeScript directamente.
Todo es PUBLISH/SUBSCRIBE en Redis.
El JSON schema es el único contrato entre procesos.
```

---

## El Dispatcher y su "entrenamiento"

El Task Dispatcher NO es un LLM corriendo siempre. Es un sistema que mejora con el tiempo:

```
Texto entrante
      │
      ▼
EmbeddingClassifier  ──── confianza ≥ 0.85 ────► TaskAvailable (~5ms)
      │
      └─ confianza < 0.85 ────► LLMFallbackAgent ──► TaskAvailable (~250ms)
                                        │
                                        └─► IntentLibrary.addExample()
                                                  │
                                                  └─► Classifier.reloadEmbedding()
                                                            │
                                                            └─► próxima vez: confiante ✓
```

**En producción**: ~95% de inputs resueltos por el clasificador en 5ms. El 5% restante usa LLM y ese resultado entrena el clasificador. Con el tiempo se vuelve más rápido sin intervención manual.

---

## Versiones del Dispatcher

| Versión | Donde vive | Latencia | Estado |
|---|---|---|---|
| `NodeDispatcher` | `fitalyagents/dispatcher` | ~50-200ms | ✅ En el SDK, gratis |
| `dispatcher-core-rust` | Binario separado | ~5-20ms | 🔮 Futuro comercial |

Ambas versiones hablan exactamente los mismos canales Redis con los mismos schemas JSON. Cambiar uno por el otro no requiere tocar los agentes TypeScript.

---

## Principios de Diseño

1. **Sin lock-in de LLM ni de framework** — cualquier agente en cualquier lenguaje puede conectarse
2. **`fitalyagents/asynctools` es completamente standalone** — usable sin Layer 1 ni Dispatcher
3. **Los agentes son cajas negras** — el sistema solo ve manifiesto, inbox y outbox
4. **El contexto pertenece al middleware** — los agentes reciben snapshots, nunca el store completo
5. **Redis es el único contrato** — schemas JSON = API entre procesos
6. **El Dispatcher se entrena solo** — feedback loop LLM fallback → Intent Library → Classifier
7. **Drop-in Rust** — el binario Rust es reemplazable sin cambiar nada en TypeScript

---

## Archivos de este Plan

| Archivo | Contenido |
|---|---|
| `PLAN.md` | Este archivo — visión general, arquitectura, principios |
| `PLAN-ARCHITECTURE.md` | Canal map Redis, JSON schemas completos, estructuras de datos |
| `PLAN-DISPATCHER.md` | Dispatcher en detalle: Node + Rust, training, intent library |
| `PLAN-SPRINTS.md` | Todos los sprints con checklists granulares |

---

## Estructura del Repositorio

```
fitalyagents/
├── packages/
│   ├── core/                        # package: fitalyagents
│   │   ├── src/
│   │   │   ├── agent/               # NexusAgent base class
│   │   │   ├── bus/                 # IEventBus abstraction (Redis impl)
│   │   │   ├── registry/            # AgentRegistry
│   │   │   ├── context/             # ContextStore (Redis JSON)
│   │   │   ├── locks/               # LockManager
│   │   │   ├── session/             # SessionManager
│   │   │   ├── tasks/               # TaskQueue + lifecycle
│   │   │   └── types/               # Tipos públicos
│   │   └── package.json
│   │
│   ├── asynctools/                  # subpath: fitalyagents/asynctools
│   │   ├── src/
│   │   │   ├── registry/            # ToolRegistry
│   │   │   ├── executor/            # ExecutorPool (http, ts_fn, subprocess)
│   │   │   ├── injection/           # InjectionManager
│   │   │   ├── wrapper/             # AsyncAgent<TInner>
│   │   │   ├── tracking/            # PendingStateTracker
│   │   │   └── types/
│   │   └── package.json
│   │
│   └── dispatcher/                  # subpath: fitalyagents/dispatcher
│       ├── src/
│       │   ├── node/                # NodeDispatcher (default, en SDK)
│       │   │   ├── classifier/      # EmbeddingClassifier (Node)
│       │   │   ├── fallback/        # LLMFallbackAgent
│       │   │   ├── router/          # CapabilityRouter
│       │   │   └── intent-library/  # IntentLibrary (Redis)
│       │   └── types/               # Schemas Zod compartidos con Rust
│       └── package.json
│
├── dispatcher-core-rust/            # Binario Rust (futuro comercial)
│   ├── src/
│   │   ├── classifier/              # candle embeddings
│   │   ├── router/                  # capability matching
│   │   ├── registry/                # Redis mirror
│   │   ├── session/
│   │   └── locks/
│   └── Cargo.toml
│
├── examples/
│   ├── asynctools-only/             # Layer 2 standalone, sin bus
│   ├── node-full/                   # SDK completo con Node dispatcher
│   └── voice-retail/                # Caso de uso real
│
├── docs/
├── schemas/                         # JSON schemas compartidos (source of truth)
│   └── events/                      # Un .json por evento del bus
├── pnpm-workspace.yaml
├── turbo.json
└── README.md
```

---

## Stack Técnico

| Decisión | Elección | Razón |
|---|---|---|
| Lenguaje SDK | TypeScript 5.x strict | Tipos completos, mejor DX |
| Lenguaje Dispatcher (prod) | Rust + Tokio | Sub-ms latencia, zero-cost async |
| Monorepo | pnpm workspaces + turbo | Build incremental |
| Bus transport | Redis Pub/Sub | Sub-ms latencia, simple ops |
| Context store | Redis JSON (RedisJSON) | Atomic partial updates, TTL nativo |
| Validación schemas | Zod (TS) / serde_json (Rust) | Runtime + tipos en uno |
| Testing | vitest | Rápido, compatible con ESM |
| Build | tsup | ESM + CJS, tipos incluidos |
| Embeddings (Node) | `@xenova/transformers` | WASM, sin dependencias nativas |
| Embeddings (Rust) | `candle` (Hugging Face) | ~2-5ms, sin servidor externo |
| Dispatcher LLM fallback | Claude Haiku | Structured output, < 250ms |
| Agent LLM (interacción) | Claude Sonnet | Calidad conversacional |
| Agent LLM (work/orders) | Claude Haiku | Solo tool calling, velocidad |

---

## Timeline General

| Fase | Contenido | Semanas |
|---|---|---|
| 0 | Fundación + `fitalyagents/asynctools` standalone | 1–3 |
| 1 | Layer 1 core bus + `NexusAgent` base class | 4–7 |
| 2 | `NodeDispatcher` con EmbeddingClassifier + LLM Fallback | 8–10 |
| 3 | Agentes: Interaction + Work + Orders | 11–13 |
| 4 | Multi-sesión, priority groups, docs, v1.0.0 | 14–15 |
| 5 | `dispatcher-core-rust` (binario comercial) | 16–20 |

> Ver `PLAN-SPRINTS.md` para el detalle completo de cada sprint.
