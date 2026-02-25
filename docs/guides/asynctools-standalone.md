# Async Tools — Standalone Usage

> Use `fitalyagents/asynctools` (Layer 2) independently, without the bus or any FitalyAgents infrastructure.

## When to use this

Layer 2 (`@fitalyagents/asynctools`) is fully standalone. Use it when you:

- Already have a LangGraph, LangChain, or custom LLM agent
- Want parallel tool execution without adopting the full SDK
- Need async tool orchestration with injection strategies

## Installation

```bash
npm install fitalyagents
# asynctools is re-exported from fitalyagents:
import { ToolRegistry } from 'fitalyagents/asynctools'

# Or install the standalone package:
npm install @fitalyagents/asynctools
import { ToolRegistry } from '@fitalyagents/asynctools'
```

---

## Core Concepts

### ToolRegistry

Holds all registered tools and their configurations.

```typescript
import { ToolRegistry } from 'fitalyagents/asynctools'

const registry = new ToolRegistry()

registry.register({
  tool_id: 'product_search',
  description: 'Search the product catalog',
  executor: {
    type: 'http',
    url: 'https://api.store.com/search',
    method: 'POST',
  },
  execution_mode: 'async',
  timeout_ms: 5000,
  retry: { max_attempts: 2, backoff_ms: 100 },
})
```

### Execution Modes

| Mode | Behavior |
|---|---|
| `sync` | Blocks until result available |
| `async` | Fire and wait — result injected when ready |
| `fire_forget` | Fire and never wait |
| `deferred` | Execute after all parallel tools finish |

### Injection Strategies

| Strategy | Behavior |
|---|---|
| `inject_when_all` | Wait for ALL parallel tools to complete |
| `inject_when_ready` | Inject each result as soon as it's ready |
| `inject_on_timeout` | Inject partial results on timeout |

---

## Using with LangGraph

```typescript
import { ToolRegistry, ExecutorPool } from 'fitalyagents/asynctools'
import { StateGraph } from '@langchain/langgraph'

const registry = new ToolRegistry()

// Register your tools
registry.register({
  tool_id: 'product_search',
  description: 'Search products by query',
  executor: {
    type: 'ts_fn',
    handler: async ({ query }: { query: string }) => {
      // your actual implementation
      return { products: await db.searchProducts(query) }
    },
  },
  execution_mode: 'async',
  injection_strategy: 'inject_when_all',
  timeout_ms: 3000,
})

registry.register({
  tool_id: 'price_check',
  description: 'Get current price for a product',
  executor: {
    type: 'ts_fn',
    handler: async ({ product_id }: { product_id: string }) => {
      return { price: await pricing.getPrice(product_id) }
    },
  },
  execution_mode: 'async',
  injection_strategy: 'inject_when_all',
  timeout_ms: 2000,
})

// LangGraph node that uses parallel tool execution
const pool = new ExecutorPool({ registry })

async function toolsNode(state: GraphState) {
  const toolCalls = state.messages.at(-1)?.tool_calls ?? []

  // Fire all tool calls in parallel
  const results = await pool.executeAll(toolCalls)

  return { tool_results: results }
}
```

---

## inject_when_all Pattern

The most common pattern for voice/realtime agents — fire multiple tools simultaneously, wait for all to finish, then inject the combined result:

```typescript
// Both product_search and price_check fire at t=0
// inject_when_all waits for BOTH before continuing
// Total latency = max(search_latency, price_latency) instead of sum

const tasks = [
  { tool_id: 'product_search', args: { query: 'red shoes' } },
  { tool_id: 'price_check', args: { product_id: 'SHOE_RED_42' } },
]

const results = await pool.executeAll(tasks, {
  strategy: 'inject_when_all',
  timeout_ms: 5000,
})
// results.product_search = { products: [...] }
// results.price_check = { price: 129.99 }
```

---

## Error Handling

```typescript
registry.register({
  tool_id: 'flaky_api',
  executor: { type: 'http', url: 'https://api.example.com' },
  execution_mode: 'async',
  timeout_ms: 3000,
  retry: {
    max_attempts: 3,
    backoff_ms: 200,
    backoff_multiplier: 2, // 200ms, 400ms, 800ms
  },
  on_failure: 'inject_empty', // or 'throw' | 'skip'
})
```

Available `on_failure` strategies:

| Strategy | Behavior |
|---|---|
| `inject_empty` | Return `null` for this tool, continue others |
| `throw` | Propagate error to caller |
| `skip` | Omit this tool's result entirely |

---

## Using fromFile

Load tool definitions from a JSON config file:

```typescript
const registry = await ToolRegistry.fromFile('./tools.json')
```

`tools.json`:
```json
[
  {
    "tool_id": "product_search",
    "description": "Search products",
    "executor": {
      "type": "http",
      "url": "https://api.store.com/search",
      "method": "POST"
    },
    "execution_mode": "async",
    "timeout_ms": 5000
  }
]
```

---

## TypeScript Types

```typescript
import type {
  ToolDefinition,
  ToolResult,
  ExecutionMode,
  InjectionStrategy,
  ToolStatus,
} from '@fitalyagents/asynctools'
```

---

## What's Next?

- [Getting Started](./getting-started.md) — full SDK with bus and agents
- [Add a New Agent](./add-new-agent.md) — build agents that use these tools
