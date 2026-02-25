# Voice Retail — FitalyAgents Example

> A complete multi-agent voice retail assistant demonstrating all FitalyAgents features: parallel tool execution, session management, human approval flows, and employee interrupt protocol.

## What this example shows

| Feature | Where |
|---|---|
| Multi-agent orchestration | `InteractionAgent` + `WorkAgent` + `OrderAgent` |
| Parallel async tools | `WorkAgent` with `inject_when_all` |
| Human approval flow | `OrderAgent` → `InMemoryApprovalQueue` → webhook |
| Session priority & interrupts | Employee (priority 2) pauses customer (priority 1) |
| Audio queue with barge-in | `InMemoryAudioQueueService` + `bus:BARGE_IN` |
| Multi-session isolation | Sprint 4.1 E2E tests |
| Context store | `InMemoryContextStore` |

---

## Architecture

```
User utterance
    ↓
InteractionAgent (TEN Framework)
    │
    ├── Sends filler audio while waiting
    │
    └── publishes task → bus.lpush('queue:work-agent:inbox', task)
                              ↓
                        WorkAgent (LangChain.js)
                              │
                    ┌─────────┴──────────┐
                    │ parallel tools     │
                    │  product_search    │
                    │  price_check       │
                    └─────────┬──────────┘
                              │ inject_when_all
                              │
                        bus.publish('bus:ACTION_COMPLETED')
                              ↓
                    InteractionAgent hears ACTION_COMPLETED
                        → interrupts filler
                        → speaks real result
                        → pushes to AudioQueue

For orders:
    ↓
OrderAgent
    ├── Creates draft
    ├── Submits for approval
    ├── Publishes bus:ORDER_PENDING_APPROVAL
    │
    └── ApprovalQueue auto-timeout / webhook
          ├── approve() → bus:ACTION_COMPLETED → InteractionAgent speaks confirmation
          └── reject()  → bus:ACTION_COMPLETED → InteractionAgent speaks rejection
```

---

## Agents

### InteractionAgent

Located in `src/agents/interaction/`

- Handles user-facing interaction (voice, text)
- Uses `ITENClient` interface (mockeable — TEN Framework in production)
- Sends quick filler response immediately
- Listens for `bus:ACTION_COMPLETED` to interrupt filler and deliver real result
- Pushes final response to `InMemoryAudioQueueService`

### WorkAgent

Located in `src/agents/work/`

- Processes tool-based tasks (product search, price check, etc.)
- Uses `IToolExecutor` interface (mockeable — LangChain.js in production)
- Supports parallel execution with `inject_when_all`
- Publishes `bus:ACTION_COMPLETED` when done

### OrderAgent

Located in `src/agents/order/`

- Handles order lifecycle: create, cancel, status, refunds
- Orders requiring approval: `status: 'waiting_approval'` + `bus:ORDER_PENDING_APPROVAL`
- Immediate operations: `status: 'completed'` + `bus:ACTION_COMPLETED`
- Uses `IOrderService` interface (mockeable)

---

## E2E Test Scenarios

Run all tests:

```bash
npx vitest run --reporter=verbose --root examples/voice-retail
```

### Pipeline E2E (`src/e2e/pipeline.e2e.test.ts`)

Full conversation flow from utterance to audio output:
- Product search with filler → real result
- Barge-in handling
- p50 latency target: < 800ms

### Order Approval E2E (`src/e2e/order-approval.e2e.test.ts`)

Human-in-the-loop approval flows:
- Customer orders → pending approval → employee approves → InteractionAgent speaks confirmation
- Rejection flow
- Timeout flow (auto-reject)
- Refund approval

### Multi-Session E2E (`src/e2e/multi-session.e2e.test.ts`)

Concurrency and isolation:
- 10 concurrent sessions, zero cross-contamination
- ContextStore isolation between sessions
- ACTION_COMPLETED event scoping
- Load test: latency at 1/5/10/20 concurrent sessions
- AudioQueue session isolation
- TaskQueue concurrent isolation

### Order Lifecycle E2E (`src/e2e/order-lifecycle.e2e.test.ts`)

Full order lifecycle:
- Create → approve → complete
- Cancel active order
- Order status query

### Cancel Chain E2E (`src/e2e/cancel-chain.e2e.test.ts`)

Cancellation propagation:
- Task cancelled mid-flight
- Partial results handled gracefully

---

## Running the Example

```bash
# From repo root
pnpm install
pnpm run build

# Run all voice-retail tests
npx vitest run --root examples/voice-retail

# Run only E2E tests
npx vitest run --root examples/voice-retail src/e2e
```

---

## Compatibility Matrix

| Component | Minimum | Recommended |
|---|---|---|
| Node.js | 18.x | 20.x LTS |
| Redis | 6.x | 7.x |
| TypeScript | 5.0 | 5.5+ |
| pnpm | 8.x | 9.x |

---

## Key Design Decisions

### Interfaces over concrete classes

Every external dependency (TEN Framework, LangChain, order management system) is injected via an interface. This makes the agents 100% testable with mocks and decoupled from specific SDK versions.

### Bus topology

- **Pub/Sub** (`bus.publish` / `bus.subscribe`): broadcast events like `ACTION_COMPLETED`, `ORDER_PENDING_APPROVAL`
- **Queues** (`bus.lpush` / `bus.brpop`): directed tasks to specific agent inboxes

### Human approval bridge

`ApprovalQueue.approve()` publishes both `bus:ORDER_APPROVED` (for other systems) AND `bus:ACTION_COMPLETED` (for `InteractionAgent`). This means `InteractionAgent` needs zero modifications to support approval flows.

### Employee interrupt protocol

```typescript
// Employee interrupts customer
await bus.publish('bus:PRIORITY_INTERRUPT', {
  interrupter_session: 'sess_employee',
  target_session: 'sess_customer',
})
// → SessionManager.pauseSession('sess_customer', 'sess_employee')

// Employee done
await bus.publish('bus:SESSION_RESUMED', { session_id: 'sess_customer' })
// → SessionManager.resumeSession('sess_customer')
```
