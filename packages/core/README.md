# fitalyagents

Event-driven multi-agent framework with built-in governance.

This package contains the core runtime:

- `InMemoryBus`, `RedisBus`, `createBus`
- `InteractionAgent`, `StaffAgent`, `UIAgent`, `AmbientAgent`, `ContextBuilderAgent`, `ProactiveAgent`
- `SafetyGuard`, `InMemoryDraftStore`, `ApprovalOrchestrator`
- `InMemoryContextStore`, `InMemorySessionManager`, `TargetGroupBridge`
- tracing primitives such as `NoopTracer` and `LangfuseTracer`

## Install

```bash
npm install fitalyagents
```

## Quickstart

```ts
import { InMemoryBus, InMemoryContextStore, InteractionAgent, SafetyGuard } from 'fitalyagents'
import type { IStreamingLLM, IToolExecutor } from 'fitalyagents'

const llm: IStreamingLLM = {
  async *stream() {
    yield { type: 'text', text: 'Hola, te ayudo con eso.' }
    yield { type: 'end', stop_reason: 'end_turn' }
  },
}

const executor: IToolExecutor = {
  async execute(toolId, input) {
    return { toolId, input }
  },
}

const bus = new InMemoryBus()
const contextStore = new InMemoryContextStore()
const safetyGuard = new SafetyGuard({
  toolConfigs: [
    { name: 'product_search', safety: 'safe' },
    { name: 'order_create', safety: 'staged' },
    {
      name: 'refund_create',
      safety: 'restricted',
      required_role: 'supervisor',
      approval_channels: [{ type: 'voice', timeout_ms: 60_000 }],
      approval_strategy: 'sequential',
    },
  ],
})

const toolRegistry = new Map([
  [
    'product_search',
    {
      tool_id: 'product_search',
      description: 'Search the catalog',
      safety: 'safe' as const,
    },
  ],
])

const agent = new InteractionAgent({
  bus,
  llm,
  contextStore,
  toolRegistry,
  executor,
  safetyGuard,
  ttsCallback: (text, sessionId) => {
    console.log(`[${sessionId}] ${text}`)
  },
})

agent.subscribePauseResume()

const turn = await agent.handleSpeechFinal({
  session_id: 'session-1',
  text: 'Busco tenis nike',
  speaker_id: 'customer-1',
})

console.log(turn.textChunks)
```

## Governance model

`SafetyGuard` evaluates every tool call using four safety levels:

| Level        | Behavior                              |
| ------------ | ------------------------------------- |
| `safe`       | Executes immediately                  |
| `staged`     | Creates a draft first                 |
| `protected`  | Requires end-user confirmation        |
| `restricted` | Requires an authorized human approver |

Human roles support both the generic and retail naming schemes:

- `user` / `customer`
- `agent` / `staff`
- `operator` / `cashier`
- `supervisor` / `manager`
- `owner`

`HumanProfile` also accepts both `org_id` and `store_id`.

## Main building blocks

### Event bus

- `InMemoryBus` is useful for tests and single-process development
- `RedisBus` and `createBus()` are the production transport
- `StreamAgent` publishes `bus:AGENT_ERROR` when an event handler fails

### Agents

- `InteractionAgent` handles the main LLM turn and safety pipeline
- `StaffAgent` pauses customer interaction, handles privileged commands, and resumes the session
- `UIAgent` converts bus events into UI update payloads
- `AmbientAgent` enriches context from non-targeted speech

### Safety and approvals

- `InMemoryDraftStore` manages staged actions with TTL, rollback, confirm, and cancel
- `ApprovalOrchestrator` coordinates voice, webhook, and external approval channels

## Docs

- Root docs: `../../README.md`
- Governance guide: `../../docs/GOVERNANCE.md`
- Human roles: `../../docs/HUMAN-ROLES.md`
- Safety model: `../../docs/SAFETY-MODEL.md`

## License

MIT
