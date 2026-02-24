# asynctools-only Example

This is a standalone example that demonstrates `@fitalyagents/asynctools` without any real LLM — it uses a mock agent that returns simulated tool calls.

## What it demonstrates

- Registering 3 tools with different `execution_mode` values
- `AsyncAgent` loop: detect tool_calls → dispatch → wait for results → re-inject → final response
- `inject_when_all` injection strategy
- Parallel execution with `max_concurrent` limiting
- Retry with exponential backoff

## Run

```bash
cd examples/asynctools-only
pnpm install
npx tsx run.ts
```
