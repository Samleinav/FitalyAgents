# @fitalyagents/asynctools

Standalone async and parallel tool execution for LLM agents.

This package gives you:

- `ToolRegistry` for validated tool definitions
- `ExecutorPool` for concurrency, retries, timeouts, rate limiting, and circuit breaking
- `AsyncAgent` for wrapping any agent that emits tool calls
- `InMemoryPendingStateTracker` and `InjectionManager` for re-injecting async results

## Install

```bash
npm install @fitalyagents/asynctools
```

## Quickstart

```ts
import {
  AsyncAgent,
  ExecutorPool,
  InMemoryPendingStateTracker,
  ToolRegistry,
  registerFunctionHandler,
} from '@fitalyagents/asynctools'
import type { AgentResponse, IInnerAgent, Message } from '@fitalyagents/asynctools'

const registry = new ToolRegistry()

registry.register({
  tool_id: 'product_search',
  description: 'Search products by keyword',
  executor: { type: 'ts_fn' },
  execution_mode: 'async',
  timeout_ms: 5_000,
  max_concurrent: 3,
  retry: { max_attempts: 2, backoff_ms: 300 },
})

registerFunctionHandler('product_search', async (input) => {
  const { query } = input as { query: string }
  return {
    results: [{ name: 'Nike Air Max', query }],
  }
})

const inner: IInnerAgent = {
  async run(_messages: Message[]): Promise<AgentResponse> {
    return {
      tool_calls: [
        {
          id: 'tool_call_1',
          tool_id: 'product_search',
          input: { query: 'nike size 42' },
        },
      ],
      stop_reason: 'tool_use',
    }
  },
}

const agent = new AsyncAgent({
  inner,
  toolRegistry: registry,
  executorPool: new ExecutorPool(registry),
  tracker: new InMemoryPendingStateTracker(),
  injectionStrategy: 'inject_when_all',
  globalTimeoutMs: 30_000,
})

const result = await agent.run('Find Nike shoes in size 42')
console.log(result.content)
```

## Core API

### `ToolRegistry`

```ts
const registry = new ToolRegistry()

registry.register({
  tool_id: 'weather_lookup',
  executor: {
    type: 'http',
    url: 'https://api.example.com/weather',
    method: 'POST',
  },
})

const tool = registry.getOrThrow('weather_lookup')
const allTools = registry.list()
```

### `ExecutorPool`

`ExecutorPool.execute(toolId, toolCallId, input)` always resolves to a `ToolResult`.
It does not throw for normal tool failures.

```ts
const pool = new ExecutorPool(registry)

const result = await pool.execute('weather_lookup', 'call_123', {
  city: 'San Jose',
})

console.log(result.status)
console.log(result.result)
console.log(result.error)
```

### `AsyncAgent`

`AsyncAgent` wraps any inner agent that implements:

```ts
interface IInnerAgent {
  run(messages: Message[]): Promise<AgentResponse>
}
```

It intercepts `tool_calls`, runs them according to each tool's `execution_mode`,
waits according to the selected `injectionStrategy`, and re-injects results.

## Execution modes

| Mode          | Behavior                                              |
| ------------- | ----------------------------------------------------- |
| `sync`        | Blocks the turn until the tool completes              |
| `async`       | Runs in background and injects when strategy resolves |
| `fire_forget` | Runs in background and is never injected back         |
| `deferred`    | Runs in background and injects at the end of the turn |

## Hardening

Every tool can define retries, per-tool rate limits, and a circuit breaker:

```ts
registry.register({
  tool_id: 'payment_gateway',
  executor: { type: 'http', url: 'https://api.example.com/pay', method: 'POST' },
  timeout_ms: 8_000,
  retry: { max_attempts: 2, backoff_ms: 500 },
  rate_limit: { requests_per_second: 10 },
  circuit_breaker: {
    failure_threshold: 5,
    reset_timeout_ms: 30_000,
  },
})
```

`CircuitBreaker` uses `CLOSED -> OPEN -> HALF_OPEN`, and in `HALF_OPEN` it allows only one concurrent probe.

## Tool result statuses

`ToolResult.status` can be:

- `completed`
- `failed`
- `timed_out`
- `rate_limited`
- `circuit_open`

## Docs

- Root docs: `../../README.md`
- Async tools guide: `../../apps/docs/content/docs/guides/async-tools.mdx`
- Hardening guide: `../../apps/docs/content/docs/guides/hardening.mdx`

## License

MIT
