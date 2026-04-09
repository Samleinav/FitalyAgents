# Memory Retail Example

Runnable retail example with optional memory in `@fitalyagents/dispatcher`.

## What It Shows

- `NodeDispatcher` with `InMemoryMemoryStore` and `AaakDialect`
- `memoryScopeResolver` separating customer, employee, and store memory
- Automatic memory writes after a resolved dispatch
- Ambiguous fallback requests using `memory_context` to resolve follow-ups
- Store-level memory persisting across different sessions

## Run

```bash
pnpm --filter fitalyagents build
pnpm --filter @fitalyagents/dispatcher build
pnpm --filter memory-retail-example run run
```

## What You Will See

- A customer and an employee sharing the same `session_id` without mixing memory
- An ambiguous customer follow-up resolved with the customer's own history
- An ambiguous employee follow-up resolved with the employee's own history
- A store issue retrieved in another session through the `store` scope
