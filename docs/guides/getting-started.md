# Getting Started with FitalyAgents

> Get a fully orchestrated multi-agent system running in 10 minutes.

## Prerequisites

- Node.js 20+
- pnpm 8+
- Redis 7+ (for production; in-memory bus available for testing)

## Installation

```bash
npm install fitalyagents
```

Or with pnpm:

```bash
pnpm add fitalyagents
```

---

## Quickstart — In-Memory (no Redis needed)

```typescript
import {
  InMemoryBus,
  NexusAgent,
  InMemoryContextStore,
  InMemorySessionManager,
} from 'fitalyagents'

// 1. Create the shared bus
const bus = new InMemoryBus()

// 2. Create supporting infrastructure
const context = new InMemoryContextStore()
const sessions = new InMemorySessionManager()

// 3. Create a session
const session = await sessions.createSession('sess_001', { user: 'Ana' })
console.log('Session created:', session.sessionId, session.status) // active

// 4. Use the context store
await context.patch('sess_001', { cart: [], locale: 'es-MX' })
const cart = await context.get('sess_001', 'cart')
console.log('Cart:', cart) // []

// 5. Terminate and clean up
await sessions.terminateSession('sess_001')
console.log('Done!')
```

---

## Quickstart — With Redis (production)

```typescript
import { createBus, NexusAgent } from 'fitalyagents'

const bus = await createBus({ redisUrl: process.env.REDIS_URL })

// bus is a RedisBus — same interface as InMemoryBus
// All agents work identically with either bus implementation
```

---

## Building Your First Agent

All agents extend `NexusAgent`. Implement the `process()` method to handle tasks.

```typescript
import { NexusAgent } from 'fitalyagents'
import type { TaskPayloadEvent, TaskResultEvent } from 'fitalyagents'

interface GreetAgentDeps {
  bus: IEventBus
}

export class GreetAgent extends NexusAgent {
  constructor({ bus }: GreetAgentDeps) {
    super({
      bus,
      manifest: {
        agent_id: 'greet-agent',
        role: 'worker',
        scope: 'greeting',
        capabilities: ['GREET'],
        context_access: 'read_own',
        domain: 'retail',
        requires_human_approval: false,
      },
    })
  }

  async process(task: TaskPayloadEvent): Promise<TaskResultEvent> {
    const name = task.slots.name ?? 'World'

    return {
      event: 'TASK_RESULT',
      task_id: task.task_id,
      session_id: task.session_id,
      intent_id: task.intent_id,
      status: 'completed',
      result: { text: `Hello, ${name}!` },
      context_patch: {},
    }
  }
}
```

Start and stop the agent:

```typescript
const agent = new GreetAgent({ bus })

await agent.start()       // begins listening to its inbox
// ... serve traffic ...
await agent.shutdown()    // graceful stop
```

Send a task directly:

```typescript
const result = await agent.process({
  event: 'TASK_PAYLOAD',
  task_id: 'task_001',
  session_id: 'sess_001',
  intent_id: 'GREET',
  slots: { name: 'Ana' },
  context_snapshot: {},
  cancel_token: null,
  timeout_ms: 5000,
  reply_to: 'queue:greet:outbox',
})

console.log(result.result.text) // "Hello, Ana!"
```

---

## Core Concepts

### Event Bus

The bus is the backbone of all agent communication.

| Pattern | When to use |
|---|---|
| `bus.publish(channel, data)` | Broadcast events to all subscribers |
| `bus.subscribe(channel, handler)` | React to broadcast events |
| `bus.lpush(channel, data)` | Push to a queue (agent inbox) |
| `bus.brpop(channel, timeout)` | Read from a queue (agent processing) |

### Session Lifecycle

```
created → active → paused → active → terminated
```

- **active**: Normal operation
- **paused**: Interrupted by higher-priority session (employee interrupt)
- **terminated**: Session ended, all callbacks fired

### Priority Groups

| Value | Meaning | Can interrupt |
|---|---|---|
| `0` | Social / group chat | — |
| `1` | Individual client (default) | Group chats (0) |
| `2` | Employee / system | All lower groups |

### Context Store

Session-scoped key/value store with access control:

```typescript
// Write
await context.patch('sess_001', { cart: [{ id: 'prod_1', qty: 2 }] })

// Read
const cart = await context.get('sess_001', 'cart')

// Read with exclusions
const snapshot = await context.getSnapshot('sess_001', ['*'], ['payment_token'])
```

---

## What's Next?

- [Async Tools standalone](./asynctools-standalone.md) — use Layer 2 without the bus
- [Add a New Agent](./add-new-agent.md) — step-by-step guide
- [Training the Dispatcher](./training-the-dispatcher.md) — intent routing
- [Rust Dispatcher](./rust-dispatcher.md) — when to upgrade to the Rust binary
