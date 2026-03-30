# @fitalyagents/dispatcher

Intent classification and speculative dispatch for FitalyAgents.

This package contains:

- `NodeDispatcher`
- `InMemoryEmbeddingClassifier`
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
