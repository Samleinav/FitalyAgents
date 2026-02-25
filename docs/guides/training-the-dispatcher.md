# Training the Dispatcher

> How intent classification works and how to add new intents to the dispatcher.

## Overview

The FitalyAgents dispatcher routes raw user utterances to the correct agent by classifying them into **intents**. It uses semantic embedding similarity — each intent has a set of example utterances that are pre-embedded, and incoming messages are matched by cosine similarity.

```
User: "Where's my order?"
    ↓
Dispatcher: embed("Where's my order?") → vector
    ↓
Similarity against intent library:
  order_status:    0.92 ✓
  product_search:  0.31
  refund_create:   0.41
    ↓
Route to OrderAgent with intent_id: 'order_status'
```

---

## Intent Library Structure

Intents are defined in a JSON file (or loaded from Redis):

```json
[
  {
    "intent_id": "order_status",
    "description": "User wants to know the status of their order",
    "agent_scope": "order_management",
    "examples": [
      "Where is my order?",
      "What's the status of my package?",
      "Has my order shipped yet?",
      "I want to track my delivery",
      "When will my order arrive?",
      "Did my order go through?",
      "Check my order status"
    ],
    "slots": [
      { "name": "order_id", "type": "string", "required": false }
    ]
  }
]
```

### Key fields

| Field | Description |
|---|---|
| `intent_id` | Unique snake_case identifier |
| `description` | Human-readable description (also used for embedding) |
| `agent_scope` | Which scope/agent handles this intent |
| `examples` | 5–15 example utterances — quality matters more than quantity |
| `slots` | Named parameters to extract from the utterance |

---

## Adding a New Intent

### 1. Add examples to the intent library

```json
{
  "intent_id": "catalog_search",
  "description": "User wants to search the product catalog",
  "agent_scope": "catalog",
  "examples": [
    "Show me red shoes",
    "I'm looking for running sneakers",
    "Do you have Nike Air Max?",
    "Search for blue dresses under $50",
    "What products do you have in stock?",
    "Find me a gift for my mom",
    "I want to browse your catalog",
    "Any new arrivals this week?"
  ],
  "slots": [
    { "name": "query", "type": "string", "required": true },
    { "name": "max_price", "type": "number", "required": false },
    { "name": "color", "type": "string", "required": false }
  ]
}
```

### 2. Run training

```bash
npx fitalyagents train --intents ./intents.json

# Or with Redis:
REDIS_URL=redis://localhost:6379 npx fitalyagents train --intents ./intents.json --store redis
```

This embeds all example utterances and stores the vectors.

### 3. Verify classification

```bash
npx fitalyagents classify "I want to find red sneakers"
# → catalog_search (0.89)
```

---

## Writing Good Examples

Quality examples are the most important factor in classification accuracy.

### Do

- **Cover different phrasings** of the same intent
- **Include short and long utterances**
- **Include questions and statements**
- **Include misspellings or casual language** if your users speak that way
- **Use domain vocabulary** ("refund", "order", "tracking", "SKU")

### Don't

- **Duplicate examples** across different intents — this confuses the classifier
- **Use overly similar examples** for different intents
- **Use fewer than 5 examples** per intent
- **Use generic phrases** that could apply to any intent

### Example — good vs. bad

```
# BAD — too generic, overlaps with other intents:
"help me"
"I have a question"
"I need something"

# GOOD — specific, distinctive:
"I never received my refund"
"Can I get my money back for order #12345?"
"The product arrived damaged, I want a refund"
"Issue a refund for my last purchase"
```

---

## Slot Extraction

Slots are named parameters extracted from utterances. The dispatcher uses the LLM to extract them:

```
User: "Show me Nike shoes under $100"
Intent: catalog_search
Extracted slots:
  query: "Nike shoes"
  max_price: 100
```

Define slots with clear names that match what your agent expects in `task.slots`.

---

## Confidence Thresholds

| Confidence | Behavior |
|---|---|
| ≥ 0.85 | Route directly to agent |
| 0.60–0.85 | Route with low-confidence flag |
| < 0.60 | Fall through to LLM fallback agent |

Configure thresholds:

```typescript
const dispatcher = new NodeDispatcher({
  bus,
  intentLibrary,
  routing: {
    min_confidence: 0.70,         // minimum to route
    high_confidence: 0.85,        // skip fallback check
    fallback_agent: 'llm-agent',  // handle < min_confidence
  },
})
```

---

## Updating Intents in Production

The dispatcher subscribes to `bus:INTENT_UPDATED` events. To hot-reload without restarting:

```typescript
// Publish updated intent
await bus.publish('bus:INTENT_UPDATED', {
  event: 'INTENT_UPDATED',
  intent_id: 'catalog_search',
  examples: [...newExamples],
})

// Dispatcher will re-embed and update its routing table automatically
```

---

## Debugging Classification

Enable verbose logging:

```typescript
const dispatcher = new NodeDispatcher({
  bus,
  intentLibrary,
  debug: true, // logs top-3 candidates for each classification
})
```

Sample debug output:
```
[dispatcher] classify("where is my package")
  #1 order_status     0.91 → route
  #2 order_cancel     0.43
  #3 product_search   0.22
```

---

## Compatibility

| Component | Node Dispatcher | Rust Dispatcher (Phase 5) |
|---|---|---|
| Intent file format | JSON ✓ | JSON ✓ |
| Embedding model | OpenAI / local | `all-MiniLM-L6-v2` (candle) |
| Hot reload | `bus:INTENT_UPDATED` | `bus:INTENT_UPDATED` |
| Redis required | No (InMemory) | Yes |
| Latency | ~5–15ms | ~0.5–2ms |
