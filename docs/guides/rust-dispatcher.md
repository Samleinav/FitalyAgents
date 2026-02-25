# Rust Dispatcher

> When and how to use the high-performance Rust dispatcher binary.

## Status

The Rust dispatcher is planned for **Phase 5** (post v1.0.0). This guide describes the intended architecture and migration path. The Node.js dispatcher (`NodeDispatcher`) is production-ready for v1.0.0.

---

## When to Use the Rust Dispatcher

Use the Node.js `NodeDispatcher` by default. Upgrade to the Rust binary when:

- You process **> 1,000 classifications/second** and latency matters
- You want **< 2ms** classification latency (vs ~5–15ms for Node.js)
- You need **deterministic performance** without GC pauses
- You're running on **constrained hardware** (edge, IoT, embedded)

| Metric | NodeDispatcher | Rust Dispatcher (planned) |
|---|---|---|
| Classification latency | 5–15ms | 0.5–2ms |
| Throughput | ~500 req/s | ~10,000 req/s |
| Memory | ~80MB | ~15MB |
| GC pauses | Yes | No |
| Startup time | ~200ms | ~10ms |
| Requires Node.js | Yes | No |
| Hot reload | Yes | Yes |

---

## Architecture (Planned)

The Rust dispatcher is a drop-in replacement that:

1. Connects to the same Redis instance
2. Subscribes to the same channels (`bus:INTENT_CLASSIFY`, `bus:INTENT_UPDATED`)
3. Publishes the same result events
4. Uses `all-MiniLM-L6-v2` via `candle` for local, offline embeddings

```
                    Redis
                      │
   Node.js agents ←───┤──→ Rust Dispatcher binary
   (unchanged)        │    (replaces NodeDispatcher)
                      │
              same bus channels
```

No changes to your agents or intent library are needed when switching.

---

## Migration Path (Future)

When Phase 5 is available:

### 1. Download the binary

```bash
# Linux x86_64
curl -L https://github.com/your-org/fitalyagents/releases/latest/download/dispatcher-linux-x86_64 \
  -o dispatcher && chmod +x dispatcher

# macOS arm64
curl -L https://github.com/your-org/fitalyagents/releases/latest/download/dispatcher-darwin-arm64 \
  -o dispatcher && chmod +x dispatcher
```

### 2. Configure via environment variables

```bash
export REDIS_URL=redis://localhost:6379
export INTENTS_FILE=./intents.json
export MIN_CONFIDENCE=0.70
export HIGH_CONFIDENCE=0.85
export FALLBACK_AGENT=llm-agent
```

### 3. Run

```bash
./dispatcher
# → Loaded 24 intents
# → Embedded 187 examples in 340ms
# → Listening on bus:INTENT_CLASSIFY
```

### 4. Stop the NodeDispatcher

```typescript
// Remove from your app initialization:
// const dispatcher = new NodeDispatcher({ bus, ... })
// await dispatcher.start()

// The Rust binary handles classification independently
```

---

## Intent Library Compatibility

The intent JSON format is identical between Node.js and Rust dispatchers. No migration needed.

---

## Embedding Model

The Rust dispatcher uses `all-MiniLM-L6-v2` (384 dimensions) loaded locally via `candle`. This means:

- **No external API calls** for embeddings
- **No API costs** for classification
- **Works offline**
- **Deterministic** results across restarts

The Node.js dispatcher can be configured to use the same model for consistency:

```typescript
const dispatcher = new NodeDispatcher({
  bus,
  intentLibrary,
  embedder: {
    type: 'local',
    model: 'all-MiniLM-L6-v2',
  },
})
```

---

## For Now — Use NodeDispatcher

```typescript
import { NodeDispatcher } from 'fitalyagents/dispatcher'

const dispatcher = new NodeDispatcher({
  bus,
  intentLibrary: await IntentLibrary.fromFile('./intents.json'),
  routing: {
    min_confidence: 0.70,
    high_confidence: 0.85,
    fallback_agent: 'llm-agent',
  },
})

await dispatcher.start()
```

See [Training the Dispatcher](./training-the-dispatcher.md) for how to define intents.
