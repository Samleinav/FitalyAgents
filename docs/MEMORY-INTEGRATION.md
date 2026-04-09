# Memory Integration: FitalyAgents + MemPalace

> **Status:** Implemented core + optional MemPalace backend adapter  
> **Affects:** `@fitalyagents/dispatcher`  
> **MemPalace version referenced:** 3.1.0 (PyPI latest as of 2026-04-09)

---

## 1. Executive Summary

FitalyAgents can run perfectly well without memory: the embedding classifier and
LLM fallback work from the first dispatch. However, **without memory the system
starts cold in every session**. It does not know who the user is, what they asked
for before, or which patterns have emerged over time.

The memory integration solves that by letting the dispatcher accumulate history
per actor (customer, employee, manager, group, store) and use that history to
enrich the LLM fallback when classifier confidence is below the threshold. The
result is a system that **improves with each interaction** without touching the
hot path.

> **Memory is optional but recommended.** A deployment without `IMemoryStore`
> still works at 100%. With memory, the LLM fallback becomes progressively more
> precise and contextual.

---

## 2. Design Philosophy

| Principle                         | Decision                                                                                                      |
| --------------------------------- | ------------------------------------------------------------------------------------------------------------- |
| Do not touch the hot path         | Memory is only used on the fallback path (`confidence < 0.85`)                                                |
| Writes never block dispatch       | Memory writes are async fire-and-forget                                                                       |
| Do not store ambiguity            | Memory is written only after a resolved dispatch, never from the raw unresolved fallback request              |
| Memory is optional                | `NodeDispatcher` accepts `memoryStore?: IMemoryStore`; without it, behavior remains unchanged                 |
| Explicit per-actor scope          | `NodeDispatcher` accepts `memoryScopeResolver?: MemoryScopeResolver` to map each utterance to `wing` + `room` |
| No mandatory Python runtime       | Native memory is TypeScript; MemPalace Python is an optional external backend                                 |
| Reuse existing embedding patterns | The native memory store follows the same local vector-search style as `InMemoryEmbeddingClassifier`           |
| Keep backend choice behind a port | Dispatcher depends only on `IMemoryStore`, so native, CLI, and MCP backends can be swapped                    |

---

## 3. Architecture

### 3.1 Full Memory Flow

```text
SPEECH_FINAL
|
+-- classify(text)
    |
    +-- confidence >= 0.85 ------------------> TASK_AVAILABLE
    |                                           |
    |                               [async] MemoryWriter
    |                               .write(text, scope)
    |
    +-- confidence < 0.85
        |
        +-- MemoryScopeResolver.resolve(event)
        |       -> { wing, room }
        |
        +-- memoryStore.query(text, scope, n=3)
        |       -> [{ text, wing, room, similarity }, ...]
        |
        +-- DISPATCH_FALLBACK(text + memory_context)
                |
                +-- LLM fallback resolves intent
                        |
                        +-- TASK_AVAILABLE
                                |
                        [async] MemoryWriter
                        .write(original_text, same_scope)
```

### 3.2 Dispatcher Memory Files

```text
packages/dispatcher/src/
`-- memory/
    |-- types.ts              # IMemoryStore, MemoryHit, MemoryEntry
    |-- memory-store.ts       # InMemoryMemoryStore, native in-process vector index
    |-- scope-resolver.ts     # MemoryScope, MemoryScopeResolver
    |-- aaak-dialect.ts       # TypeScript AAAK compression port
    `-- mempalace-store.ts    # MemPalaceMemoryStore + CLI/MCP transports
```

Memory search and memory writes are currently orchestrated inside
`node-dispatcher.ts` so no separate runtime worker is required.

### 3.3 Existing Component Changes

| File                 | Change                                                                                             |
| -------------------- | -------------------------------------------------------------------------------------------------- |
| `node-dispatcher.ts` | Accepts `memoryStore?: IMemoryStore` in `NodeDispatcherDeps`                                       |
| `node-dispatcher.ts` | Accepts `memoryScopeResolver?: MemoryScopeResolver` for actor / store / group / session resolution |
| `node-dispatcher.ts` | On fallback: resolves memory scope, queries memory, and enriches `DISPATCH_FALLBACK`               |
| `node-dispatcher.ts` | After resolved classifier dispatch: writes memory asynchronously                                   |
| `node-dispatcher.ts` | After resolved `llm_fallback`: writes the original fallback utterance to the same scope            |
| `types/index.ts`     | `FallbackRequest` includes optional `memory_context?: MemoryHit[]`                                 |
| `types/index.ts`     | `SPEECH_FINAL` / `SPEECH_PARTIAL` accept optional actor metadata                                   |
| `index.ts`           | Exports native memory, AAAK, scope resolver, and MemPalace adapter APIs                            |

---

## 4. Public API

```typescript
export interface MemoryHit {
  text: string
  wing: string // actor/store/group type: 'customer', 'employee', 'store', etc.
  room: string // stable id: 'cust_ana', 'staff_luis', 'store_001'
  similarity: number // 0.0 - 1.0
}

export interface MemoryEntry {
  text: string
  wing: string
  room: string
  embedding?: Float32Array // auto-computed by native store if omitted
}

export interface MemoryScope {
  wing: string
  room: string
}

export type MemoryScopeResolver = (input: {
  session_id: string
  text: string
  locale?: string
  speaker_id?: string
  role?: string
  actor_type?: string
  store_id?: string
  group_id?: string
  timestamp: number
}) => MemoryScope | null | Promise<MemoryScope | null>

export interface IMemoryStore {
  write(entry: MemoryEntry): Promise<void>
  query(text: string, opts?: { wing?: string; room?: string; n?: number }): Promise<MemoryHit[]>
  dispose?(): void
}
```

---

## 5. Memory Structure By Actor

MemPalace organizes memory hierarchically with `wing` (project or actor type)
and `room` (specific instance). FitalyAgents adopts the same convention:

```text
wing = "customer"    room = "cust_maria"
  -> "asked for a schedule change three times this month"
  -> "prefers decaf coffee"
  -> "last complaint: checkout is slow on Fridays"

wing = "employee"    room = "staff_pedro"
  -> "handles returns well"
  -> "needs help with inventory lookups"
  -> "shift: morning, register 3"

wing = "manager"     room = "mgr_lucia"
  -> "approves discounts above $50 only with photo evidence"
  -> "usually absent on Mondays"
  -> "priority: reduce waiting time"

wing = "store"       room = "store_001"
  -> "register two slows down during afternoon checkout"
  -> "Friday pickup queue exceeds target after 5 PM"
```

This lets the LLM fallback receive **actor-specific context** instead of searching
through global memory.

### 5.1 Memory Scope Resolver

In FitalyAgents, `session_id` isolates the conversation, but it does **not**
always identify the correct actor. In retail, ambient voice, or diarized group
audio, one session can include:

- an individual customer
- multiple customers in a group
- an employee joining the interaction
- a manager or supervisor
- store / branch context

That is why the design includes `memoryScopeResolver`: an optional callback that
decides where to read and write memory for each utterance.

```typescript
const memoryScopeResolver: MemoryScopeResolver = ({
  session_id,
  speaker_id,
  actor_type,
  store_id,
  group_id,
}) => {
  if (actor_type === 'customer' && speaker_id) {
    return { wing: 'customer', room: speaker_id }
  }

  if (actor_type === 'employee' && speaker_id) {
    return { wing: 'employee', room: speaker_id }
  }

  if (actor_type === 'manager' && speaker_id) {
    return { wing: 'manager', room: speaker_id }
  }

  if (group_id) {
    return { wing: 'group', room: group_id }
  }

  if (store_id) {
    return { wing: 'store', room: store_id }
  }

  return { wing: 'session', room: session_id }
}
```

With this approach:

- a customer and an employee can share the same session without mixing memory
- a group can have shared memory that is distinct from each person's memory
- a store can keep operational memory separate from people
- fallback still works without stable identity by using `session_id`

### 5.2 Recommended Scope Resolution Order

When multiple candidates are available, resolve scope in this order:

1. Actor identified by diarization / speaker id
2. Identified group (`group_id`)
3. Store / branch (`store_id`)
4. Ephemeral session (`session_id`)

---

## 6. LLM Fallback Integration

`FallbackRequest` now supports optional memory context in a backwards-compatible
way:

```typescript
const scope = await this.resolveMemoryScope(event)
const memoryHits = await this.memoryStore.query(event.text, {
  wing: scope.wing,
  room: scope.room,
  n: 3,
})

await this.bus.publish('bus:DISPATCH_FALLBACK', {
  event: 'DISPATCH_FALLBACK',
  session_id: event.session_id,
  text: event.text,
  classifier_confidence: result.confidence,
  top_candidates: result.top_candidates,
  ...(memoryHits.length > 0 ? { memory_context: memoryHits } : {}),
  timestamp: Date.now(),
})
```

The existing `ILLMFallbackAgent` receives `memory_context` in the event payload.
No new bus event is required.

Important rule: the dispatcher **must not write unresolved fallback text to
memory**. Memory is written only after a confident classifier dispatch or after
the LLM fallback publishes a resolved `TASK_AVAILABLE` with
`source: 'llm_fallback'`.

---

## 7. AAAK Dialect

MemPalace `dialect.py` implements AAAK: a lossy compression format that extracts
entities, topics, emotions, and flags from free text.

In FitalyAgents, `AaakDialect` can be used before embedding and querying native
memory. It reduces noise in the vector index while still returning the original
memory text in hits.

```text
Input: "Customer Pedro decided to cancel the subscription because the price increased and he never used premium features"
AAAK:  PED|cancel_subscription|"price increased"|frust+grief|DECISION
```

The TypeScript port is pure text processing - regexes and keyword maps - with no
external runtime dependencies.

---

## 8. Backends And Setup

Memory is selected by passing an `IMemoryStore` to `NodeDispatcher`. The
dispatcher does not know whether the backend is in-process, CLI-based, or MCP
based.

### 8.1 Native TypeScript Store

Use `InMemoryMemoryStore` for tests, demos, embedded development, and short-lived
runtime memory:

```typescript
import { AaakDialect, InMemoryMemoryStore } from '@fitalyagents/dispatcher'

const memoryStore = new InMemoryMemoryStore({
  dialect: new AaakDialect({
    entities: {
      Anna: 'ANA',
      Luis: 'LUI',
      Register: 'REG',
    },
  }),
})
```

This backend is dependency-free, fast, and easy to run locally. It does not
persist memory across process restarts unless the caller snapshots and restores
entries separately.

### 8.2 MemPalace CLI Backend

Use `MemPalaceCliTransport` when you want the real MemPalace backend from a
script, local prototype, or simple deployment:

```bash
python3 -m venv .venv-mempalace
source .venv-mempalace/bin/activate
python -m pip install -U pip
python -m pip install mempalace
mempalace init ~/.mempalace/fitaly-retail
```

```typescript
import { MemPalaceCliTransport, MemPalaceMemoryStore } from '@fitalyagents/dispatcher'

const memoryStore = new MemPalaceMemoryStore({
  transport: new MemPalaceCliTransport({
    palacePath: process.env.MEMPALACE_PALACE ?? '~/.mempalace/fitaly-retail',
    timeoutMs: 15000,
  }),
})
```

The CLI transport shells out to `mempalace search` for reads and uses
`mempalace mine` on a temporary conversation file for writes. This is simple and
portable, but each operation pays process startup overhead.

### 8.3 MemPalace MCP Backend

Use `MemPalaceMcpTransport` for long-running services where the app can keep an
MCP session open:

```typescript
import {
  MemPalaceMcpTransport,
  MemPalaceMemoryStore,
  type MemPalaceMcpClient,
} from '@fitalyagents/dispatcher'

const client: MemPalaceMcpClient = {
  callTool: (name, args) => yourMcpClient.callTool(name, args),
}

const memoryStore = new MemPalaceMemoryStore({
  transport: new MemPalaceMcpTransport({ client }),
})
```

By default, the transport calls `mempalace_search` for queries and
`mempalace_add_drawer` for writes. If the MCP client exposes different argument
shapes, pass `toSearchArgs`, `toWriteArgs`, or `parseSearchResponse`.

### 8.4 Backend Selection Guidance

| Use case                        | Recommended backend                              |
| ------------------------------- | ------------------------------------------------ |
| Unit tests                      | `InMemoryMemoryStore`                            |
| Local demo                      | `InMemoryMemoryStore` + optional `AaakDialect`   |
| Persistent local prototype      | `MemPalaceMemoryStore` + `MemPalaceCliTransport` |
| Production service with MCP     | `MemPalaceMemoryStore` + `MemPalaceMcpTransport` |
| Voice retail with many actors   | Any backend + `memoryScopeResolver`              |
| Offline/local-first deployments | MemPalace backend                                |

---

## 9. Usage Example

```typescript
import {
  InMemoryEmbeddingClassifier,
  InMemoryMemoryStore,
  NodeDispatcher,
} from '@fitalyagents/dispatcher'

const memoryStore = new InMemoryMemoryStore({ embedder })

const dispatcher = new NodeDispatcher({
  bus,
  classifier,
  fallbackAgent,
  memoryStore, // optional: dispatcher still works without it
  memoryScopeResolver: ({ session_id, speaker_id, actor_type, store_id }) => {
    if (actor_type === 'customer' && speaker_id) return { wing: 'customer', room: speaker_id }
    if (actor_type === 'employee' && speaker_id) return { wing: 'employee', room: speaker_id }
    if (store_id) return { wing: 'store', room: store_id }
    return { wing: 'session', room: session_id }
  },
})

await dispatcher.start()

await bus.publish('bus:SPEECH_FINAL', {
  event: 'SPEECH_FINAL',
  session_id: 'floor_session_1',
  speaker_id: 'cust_maria',
  actor_type: 'customer',
  text: 'the same coffee as before',
  timestamp: Date.now(),
})

// Internally:
// 1. Classifier confidence is below threshold, so dispatcher falls back.
// 2. Memory scope resolves to { wing: 'customer', room: 'cust_maria' }.
// 3. Memory query retrieves "prefers decaf coffee".
// 4. DISPATCH_FALLBACK includes memory_context.
// 5. LLM fallback resolves intent_id: 'order_regular_item'.
// 6. TASK_AVAILABLE is published.
// 7. The original utterance is written back to the same customer scope.
```

---

## 10. Relationship With MemPalace Python

MemPalace Python is not required for the base runtime, but it can be used as a
persistent backend when we want local ChromaDB search, palace structure, and MCP
tools.

| MemPalace Python                | FitalyAgents TS                                                      |
| ------------------------------- | -------------------------------------------------------------------- |
| `mempalace mine` offline/CLI    | `MemPalaceCliTransport.write()` through a temporary file             |
| `searcher.py` + ChromaDB        | `MemPalaceCliTransport.search()` or `MemPalaceMcpTransport.search()` |
| `dialect.py` AAAK               | `aaak-dialect.ts` TypeScript port                                    |
| `knowledge_graph.py` SQLite     | Out of initial scope                                                 |
| MCP server with MemPalace tools | `MemPalaceMcpTransport` through an injected MCP client               |

Recommended usage:

- `InMemoryMemoryStore`: tests, demos, local development, and ephemeral embedded memory
- `MemPalaceCliTransport`: scripts, prototypes, and environments where one process per operation is acceptable
- `MemPalaceMcpTransport`: long-running services where an MCP session already exists or should stay open

The dispatcher still depends only on `IMemoryStore`, so changing memory backends
does not affect dispatch logic or `memoryScopeResolver`.

---

## 11. Performance Considerations

| Operation                       | Estimated Latency                       | Path                              |
| ------------------------------- | --------------------------------------- | --------------------------------- |
| `InMemoryMemoryStore.query()`   | 0.5-3ms                                 | Only on fallback                  |
| `InMemoryMemoryStore.write()`   | ~1ms                                    | Async, non-blocking               |
| AAAK compression                | < 0.5ms                                 | Pure TypeScript, no external deps |
| `MemPalaceCliTransport.query()` | tens to hundreds of ms                  | CLI process + local search        |
| `MemPalaceMcpTransport.query()` | lower than CLI when the session is warm | Persistent MCP + local search     |
| Hot path (`confidence >= 0.85`) | **0ms memory overhead**                 | Memory is not touched             |

---

_Document based on the analysis of `mempalace@3.0.0` / `3.1.0` available on
PyPI on 2026-04-09 and the current `@fitalyagents/dispatcher@1.2.0`
architecture._
