# fitalyagents

Event-driven multi-agent framework with built-in governance.

This package contains the core runtime:

- `InMemoryBus`, `RedisBus`, `createBus`
- `InteractionAgent`, `StaffAgent`, `UIAgent`, `AmbientAgent`, `SentimentGuard`, `ContextBuilderAgent`, `ProactiveAgent`, `AvatarAgent`
- `SafetyGuard`, `InMemoryDraftStore`, `ApprovalOrchestrator`, `HandoffBuilder`
- `InMemoryContextStore`, `InMemoryPresenceManager`, `InMemorySessionManager`, `TargetGroupBridge`
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

`SafetyGuard` can also take a `ContextualSafetyResolver` for dynamic risk
adjustment. A resolver can lower a verified VIP payment to `safe`, raise a
fraud-flagged payment to `restricted`, or react to session sentiment without
changing the static tool config globally. Existing synchronous `evaluate()`
calls keep working; use `evaluateAsync()` when the resolver reads async context.

## Main building blocks

### Event bus

- `InMemoryBus` is useful for tests and single-process development
- `RedisBus` and `createBus()` are the production transport
- `StreamAgent` publishes `bus:AGENT_ERROR` when an event handler fails

### Agents

- `InteractionAgent` handles the main LLM turn and safety pipeline
- `StaffAgent` pauses customer interaction, publishes handoff context, handles privileged commands, and resumes the session
- `UIAgent` converts bus events into UI update payloads
- `AmbientAgent` enriches context from non-targeted speech
- `SentimentGuard` detects tense/frustrated/angry ambient signals and publishes session alerts
- `AvatarAgent` renders bus events into visual/speech commands through an `IAvatarRenderer`

### Sentiment guard

`SentimentGuard` subscribes to `bus:AMBIENT_CONTEXT`, classifies the emotional
level, stores recent sentiment state in `IContextStore`, and publishes
`bus:SESSION_SENTIMENT_ALERT` after a configurable run of tense, frustrated, or
angry samples. `ProactiveAgent` listens to those alerts and emits
`sentiment_alert` triggers so an interaction agent can suggest a human handoff,
soften tone, or route a risky action through dynamic safety.

```ts
import { InMemoryBus, InMemoryContextStore, SentimentGuard } from 'fitalyagents'

const bus = new InMemoryBus()
const contextStore = new InMemoryContextStore()

const sentimentGuard = new SentimentGuard({
  bus,
  contextStore,
  config: { alertThreshold: 2, minAlertLevel: 'tense' },
})

await sentimentGuard.start()
```

### Session handoff

`HandoffBuilder` creates a structured context packet for the human taking over a
session. It can include the current context snapshot, recent conversation turns,
a pending draft, and optional memory hits. When passed to `StaffAgent`, the
agent publishes `bus:SESSION_HANDOFF` immediately after pausing the
`InteractionAgent`.

```ts
import { HandoffBuilder, InMemoryContextStore, StaffAgent } from 'fitalyagents'

const contextStore = new InMemoryContextStore()
const handoffBuilder = new HandoffBuilder({ contextStore })

const staffAgent = new StaffAgent({
  bus,
  llm,
  safetyGuard,
  toolRegistry,
  executor,
  handoffBuilder,
})
```

### Avatar rendering

`AvatarAgent` is a pure renderer: it does not call an LLM, choose tools, approve
actions, or modify response text. It listens to bus events such as
`bus:RESPONSE_START`, `bus:AVATAR_SPEAK`, `bus:RESPONSE_END`,
`bus:TARGET_GROUP_CHANGED`, and `bus:APPROVAL_RESOLVED`, then sends visual
commands to an `IAvatarRenderer`.

```ts
import {
  AvatarAgent,
  InMemoryBus,
  MockAvatarRenderer,
  retailProfessionalAvatarProfile,
} from 'fitalyagents'

const bus = new InMemoryBus()
const renderer = new MockAvatarRenderer()

const avatar = new AvatarAgent({
  bus,
  renderer,
  presentationProfile: retailProfessionalAvatarProfile,
})

await avatar.start()
```

Presentation profiles tune body language without changing the agent's decisions.
The retail professional profile uses subtle motion, focused and reassuring
expressions, queue acknowledgement, open-palm response gestures, and
confirmation gestures for approvals. Custom profiles can override
`stateExpressionMap`, `intentExpressionMap`, and `eventGestureMap`.

For visual deployments, swap `MockAvatarRenderer` for `AIRIRenderer`:

```ts
import { AIRIRenderer } from 'fitalyagents'

const renderer = new AIRIRenderer({ url: 'ws://localhost:6006' })
```

### Safety and approvals

- `InMemoryDraftStore` manages staged actions with TTL, rollback, confirm, and cancel
- `ApprovalOrchestrator` coordinates voice, webhook, external, sequential, parallel, and quorum approvals
- `InMemoryPresenceManager` tracks available, busy, offline, and on-break humans for same-or-higher-role approval routing

```ts
import { ApprovalOrchestrator, InMemoryPresenceManager } from 'fitalyagents'
import type { ApprovalRequest } from 'fitalyagents'

const presenceManager = new InMemoryPresenceManager({ bus })
presenceManager.start()

const approvals = new ApprovalOrchestrator({
  bus,
  channelRegistry,
  presenceManager,
})

const request: ApprovalRequest = {
  id: 'approval_001',
  draft_id: 'draft_001',
  action: 'inventory_writeoff',
  amount: 50_000,
  session_id: 'session-1',
  required_role: 'manager',
  context: { store_id: 'store_001' },
  timeout_ms: 120_000,
  quorum: {
    required: 2,
    eligible_roles: ['manager', 'owner'],
  },
}

await approvals.orchestrate(request, [{ type: 'webhook', timeout_ms: 60_000 }], 'quorum', {
  id: 'fallback_manager',
  name: 'Fallback Manager',
  role: 'manager',
  store_id: 'store_001',
  approval_limits: {},
})
```

## Docs

- Root docs: `../../README.md`
- Governance guide: `../../docs/GOVERNANCE.md`
- Human roles: `../../docs/HUMAN-ROLES.md`
- Safety model: `../../docs/SAFETY-MODEL.md`

## License

MIT
