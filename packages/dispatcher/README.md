# @fitalyagents/dispatcher

Intent classification and speculative dispatch for FitalyAgents.

This package contains:

- `NodeDispatcher`
- `InMemoryEmbeddingClassifier`
- `InMemoryMemoryStore`
- `LLMDirectClassifier`
- `InMemoryIntentLibrary`
- `SpeculativeCache`
- `IntentTeacher`
- `IntentScoreStore`
- `ClaudeLLMProvider`

## Install

```bash
npm install @fitalyagents/dispatcher fitalyagents
```

## Quickstart

```ts
import { InMemoryBus } from 'fitalyagents'
import {
  InMemoryEmbeddingClassifier,
  InMemoryIntentLibrary,
  NodeDispatcher,
} from '@fitalyagents/dispatcher'

const bus = new InMemoryBus()
const intentLibrary = new InMemoryIntentLibrary()

await intentLibrary.createIntent({
  intent_id: 'product_search',
  domain_required: 'customer_facing',
  scope_hint: 'commerce',
  capabilities_required: ['PRODUCT_SEARCH'],
  initial_examples: ['find nike shoes', 'search for sneakers', 'show me red running shoes'],
})

const classifier = new InMemoryEmbeddingClassifier(intentLibrary)

const fallbackAgent = {
  start() {},
  dispose() {},
}

const dispatcher = new NodeDispatcher({
  bus,
  classifier,
  fallbackAgent,
})

await dispatcher.start()

await bus.publish('bus:SPEECH_FINAL', {
  event: 'SPEECH_FINAL',
  session_id: 'session-1',
  text: 'find nike shoes',
  timestamp: Date.now(),
})
```

When classification is confident enough, `NodeDispatcher` publishes `bus:TASK_AVAILABLE`.
When confidence is too low, it publishes `bus:DISPATCH_FALLBACK`.

## Optional memory

`NodeDispatcher` can enrich low-confidence fallback requests with session memory
when you provide a `memoryStore`.

```ts
import {
  AaakDialect,
  InMemoryEmbeddingClassifier,
  InMemoryIntentLibrary,
  InMemoryMemoryStore,
  NodeDispatcher,
} from '@fitalyagents/dispatcher'

const memoryStore = new InMemoryMemoryStore({
  dialect: new AaakDialect({
    entities: { Pedro: 'PED' },
  }),
})

await memoryStore.write({
  text: 'customer usually orders decaf coffee',
  wing: 'session',
  room: 'session-1',
})

const dispatcher = new NodeDispatcher({
  bus,
  classifier,
  fallbackAgent,
  memoryStore,
  memoryScopeResolver: ({ session_id, speaker_id, role, store_id, group_id }) => {
    if (role === 'customer' && speaker_id) return { wing: 'customer', room: speaker_id }
    if (role === 'staff' && speaker_id) return { wing: 'employee', room: speaker_id }
    if (group_id) return { wing: 'group', room: group_id }
    if (store_id) return { wing: 'store', room: store_id }
    return { wing: 'session', room: session_id }
  },
})
```

When a `SPEECH_FINAL` event falls below the confidence threshold, the emitted
`bus:DISPATCH_FALLBACK` payload includes an optional `memory_context` array with
the most similar memories for that session. New utterances are also written back
to memory asynchronously after dispatch, so the hot path stays unchanged.

`memoryScopeResolver` is optional, but it becomes important in shared retail or
voice environments where one `session_id` may contain multiple actors such as
customers, staff, managers, or group conversations.

If you want denser memory embeddings, `InMemoryMemoryStore` also accepts
`dialect: new AaakDialect(...)`, which compresses text into AAAK before
embedding and querying while still returning the original memory text in hits.

### MemPalace backend

For persistent local memory backed by MemPalace/ChromaDB, use
`MemPalaceMemoryStore` with either CLI or MCP transport.

CLI is useful for local development and scripts:

```ts
import { MemPalaceCliTransport, MemPalaceMemoryStore } from '@fitalyagents/dispatcher'

const memoryStore = new MemPalaceMemoryStore({
  transport: new MemPalaceCliTransport({
    palacePath: process.env.MEMPALACE_PALACE,
  }),
})
```

MCP is the better long-running service shape because your app can keep a
persistent MCP session open:

```ts
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

The default MCP tool names are `mempalace_search` and
`mempalace_add_drawer`. If your MCP client exposes slightly different
arguments, pass `toSearchArgs`, `toWriteArgs`, or `parseSearchResponse`.

## Speculative execution

`NodeDispatcher` can also listen to `bus:SPEECH_PARTIAL` and pre-compute results for safe tools.

To enable that path, provide:

- `speculativeCache`
- `intentToolResolver`
- `speculativeExecutor`

```ts
import { SpeculativeCache } from '@fitalyagents/dispatcher'

const speculativeCache = new SpeculativeCache({ maxEntries: 256 })

const dispatcher = new NodeDispatcher({
  bus,
  classifier,
  fallbackAgent,
  speculativeCache,
  intentToolResolver: (intentId) => {
    if (intentId === 'product_search') {
      return { tool_id: 'product_search', safety: 'safe' }
    }
    return null
  },
  speculativeExecutor: async (intentId, sessionId) => {
    return { intentId, sessionId, prefetched: true }
  },
})
```

The speculative thresholds exported by the package are:

- `SPECULATIVE_CONFIDENCE_MIN`
- `SPECULATIVE_MARGIN_MIN`

## Runtime helpers

### `IntentTeacher`

Learns from corrections and can append examples to the intent library.

### `IntentScoreStore`

Tracks intent hit rate and confidence trends over time.

### `ClaudeLLMProvider`

Adapter for Anthropic models when you want LLM-based classification instead of the in-memory embedding classifier.

## Docs

- Root docs: `../../README.md`
- Architecture: `../../apps/docs/content/docs/architecture.mdx`
- Intent training guide: `../../apps/docs/content/docs/guides/intent-training.mdx`
- Observability guide: `../../apps/docs/content/docs/guides/observability.mdx`

## License

MIT
