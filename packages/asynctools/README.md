# @fitalyagents/asynctools

> Standalone async parallel tool execution for any LLM agent — no Redis, no bus, just wrap your agent and get parallel async tools.

[![npm version](https://img.shields.io/npm/v/@fitalyagents/asynctools)](https://www.npmjs.com/package/@fitalyagents/asynctools)
[![License: MIT](https://img.shields.io/badge/License-MIT-blue.svg)](../../LICENSE)

## Overview

`@fitalyagents/asynctools` is **Layer 2** of the FitalyAgents SDK. It solves the fundamental problem with LLM tool calling: **tools must execute in parallel and asynchronously**, but the standard LLM SDK paradigm forces sequential, synchronous execution.

This package provides:

- 🚀 **`AsyncAgent`** — wrap any LLM agent (OpenAI, Anthropic, custom) to add parallel async tool execution
- 🛠️ **`ToolRegistry`** — type-safe tool definition and registration with Zod validation
- ⚡ **`ExecutorPool`** — concurrent tool execution with per-tool limits, retry, and timeout
- 📊 **`PendingStateTracker`** — tracks tool call states with configurable injection strategies
- 💉 **`InjectionManager`** — formats results and re-injects them into the conversation

## Installation

```bash
npm install @fitalyagents/asynctools zod
# or
pnpm add @fitalyagents/asynctools zod
```

## Quickstart

```typescript
import {
  AsyncAgent,
  ToolRegistry,
  ExecutorPool,
  InMemoryPendingStateTracker,
  registerFunctionHandler,
} from '@fitalyagents/asynctools'

// 1. Define your tools
const registry = new ToolRegistry()

registry.register({
  tool_id: 'product_search',
  description: 'Search products by keyword',
  executor: { type: 'ts_fn' },
  execution_mode: 'async',          // runs in parallel
  max_concurrent: 3,
  retry: { max_attempts: 2, backoff_ms: 300 },
  timeout_ms: 5000,
})

// 2. Register the function handler
registerFunctionHandler('product_search', async (input) => {
  const { query } = input as { query: string }
  // call your actual search API here
  return { results: [`Nike Air Max for "${query}"`] }
})

// 3. Wrap any LLM agent
const agent = new AsyncAgent({
  inner: myOpenAICompatibleAgent,   // anything with run(messages)
  toolRegistry: registry,
  executorPool: new ExecutorPool(registry),
  tracker: new InMemoryPendingStateTracker(),
  injectionStrategy: 'inject_when_all',   // wait for all tools
  globalTimeoutMs: 30_000,
})

// 4. Run
const response = await agent.run('Find Nike shoes in size 42')
console.log(response.content)  // "I found 3 Nike shoes matching size 42: ..."
```

## Execution Modes

Each tool in your `ToolRegistry` has an `execution_mode` that controls how `AsyncAgent` handles it:

| Mode | Behavior | Use Case |
|------|----------|----------|
| `sync` | Blocks the turn until the tool completes. Result injected immediately. | Fast, cheap lookups (cache hits, in-memory calc) |
| `async` | Launches in background. Result injected when strategy resolves. | **Most tools** — API calls, DB queries, embeddings |
| `fire_forget` | Launches in background. Result **never** injected. | Logging, analytics, webhooks |
| `deferred` | Like `async` but waits until end of turn to inject. | Tools where order of injection matters |

## Injection Strategies

The `injectionStrategy` controls **when** async results are re-injected into the conversation:

| Strategy | Resolves When | Use Case |
|----------|--------------|----------|
| `inject_when_all` | ALL tool calls are terminal (completed/failed/timed_out) | Most consistent — LLM sees the full picture |
| `inject_when_ready` | ANY single tool completes | Low-latency — first result triggers continuation |
| `inject_on_timeout` | Global timeout expires | Hard real-time constraints |

## Executors

### HttpExecutor

Execute tools via HTTP using native `fetch()` (Node 18+). No external dependencies.

```typescript
registry.register({
  tool_id: 'weather_api',
  executor: {
    type: 'http',
    url: 'https://api.weather.com/v1/current',
    method: 'POST',
    headers: { 'Authorization': 'Bearer my-token' },
  },
  execution_mode: 'async',
  timeout_ms: 8000,
})
```

The input payload is serialized as JSON in the request body. The response is parsed as JSON automatically.

### FunctionExecutor

Execute tools by calling registered TypeScript/JavaScript functions. Sync functions are automatically wrapped in a Promise.

```typescript
import { registerFunctionHandler } from '@fitalyagents/asynctools'

registry.register({
  tool_id: 'calculate',
  executor: { type: 'ts_fn' },
  execution_mode: 'sync',  // fast — good for sync mode
})

registerFunctionHandler('calculate', (input) => {
  const { expression } = input as { expression: string }
  return { result: eval(expression) }  // (use a safe evaluator in production)
})
```

### SubprocessExecutor

Execute tools by spawning child processes. Input is sent via stdin as JSON; output is read from stdout as JSON.

```typescript
registry.register({
  tool_id: 'python_analyzer',
  executor: {
    type: 'subprocess',
    command: 'python3',
    args: ['tools/analyzer.py'],
    cwd: '/path/to/project',
  },
  execution_mode: 'async',
  timeout_ms: 15_000,
})
```

## ToolRegistry

```typescript
const registry = new ToolRegistry()

// Register a single tool
registry.register({ tool_id: 'search', executor: { type: 'ts_fn' } })

// Register many tools (transactional — all or nothing)
registry.registerMany([tool1, tool2, tool3])

// Load from a JSON file
const registry = await ToolRegistry.fromFile('./tools.json')

// Load from a plain object
const registry = ToolRegistry.fromObject({
  tools: [{ tool_id: 'search', executor: { type: 'ts_fn' } }]
})

// Query
const tool = registry.get('search')           // ToolDefinition | undefined
const tool = registry.getOrThrow('search')    // ToolDefinition (throws ToolNotFoundError)
const all  = registry.list()                   // ToolDefinition[]
const has  = registry.has('search')            // boolean
registry.unregister('search')                  // remove
```

### JSON format for `tools.json`

```json
{
  "tools": [
    {
      "tool_id": "product_search",
      "description": "Search products by keyword",
      "executor": {
        "type": "http",
        "url": "https://api.store.com/search",
        "method": "POST"
      },
      "execution_mode": "async",
      "timeout_ms": 5000,
      "max_concurrent": 3,
      "retry": { "max_attempts": 2, "backoff_ms": 300 }
    }
  ]
}
```

## ExecutorPool

```typescript
const pool = new ExecutorPool(registry)

// Execute a tool
const result = await pool.execute('product_search', 'call_id_123', { query: 'nike' })
console.log(result.status)      // 'completed' | 'failed'
console.log(result.result)      // the tool's return value
console.log(result.duration_ms) // execution time

// Get execution stats
const stats = pool.getStats('product_search')
// { executing: 0, queued: 0, completed: 5, failed: 1 }
```

## Error Handling

All errors extend `FitalyError` with a programmatic `code` field:

```typescript
import {
  ToolNotFoundError,
  ToolValidationError,
  DuplicateToolError,
  HttpExecutorError,
  ToolExecutionError,
} from '@fitalyagents/asynctools'

try {
  registry.getOrThrow('nonexistent')
} catch (e) {
  if (e instanceof ToolNotFoundError) {
    console.log(e.code)    // 'TOOL_NOT_FOUND'
    console.log(e.toolId)  // 'nonexistent'
  }
}

try {
  registry.register({ tool_id: '' })  // invalid — empty ID
} catch (e) {
  if (e instanceof ToolValidationError) {
    console.log(e.issues)  // Zod validation issues
  }
}
```

## IInnerAgent Interface

`AsyncAgent` works with **any** agent that implements this minimal interface:

```typescript
interface IInnerAgent {
  run(messages: Message[]): Promise<AgentResponse>
}

interface AgentResponse {
  content?: string
  tool_calls?: Array<{ id: string; tool_id: string; input: unknown }>
  stop_reason?: 'end_turn' | 'tool_use' | 'max_tokens'
}
```

You can adapt any LLM SDK with a thin wrapper:

```typescript
// OpenAI example adapter
class OpenAIAdapter implements IInnerAgent {
  constructor(private client: OpenAI, private model = 'gpt-4o') {}

  async run(messages: Message[]): Promise<AgentResponse> {
    const resp = await this.client.chat.completions.create({
      model: this.model,
      messages: messages as any,
    })
    const choice = resp.choices[0]
    return {
      content: choice.message.content ?? undefined,
      tool_calls: choice.message.tool_calls?.map(tc => ({
        id: tc.id,
        tool_id: tc.function.name,
        input: JSON.parse(tc.function.arguments),
      })),
      stop_reason: choice.finish_reason === 'tool_calls' ? 'tool_use' : 'end_turn',
    }
  }
}
```

## License

MIT © FitalyAgents Contributors
