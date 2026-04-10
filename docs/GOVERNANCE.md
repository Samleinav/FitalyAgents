# Governance Guide — FitalyAgents

> Governance in FitalyAgents is not a layer on top of the system — it is the system.
> Every tool call passes through `SafetyGuard`. Every restricted action waits for a human.
> The bus carries the decisions. The agents enforce them.

---

## Overview

FitalyAgents governance has three coordinated layers:

```
Layer 1 — Safety Levels
  Every tool declares its risk: safe / staged / protected / restricted.
  SafetyGuard evaluates each action before it executes.

Layer 2 — Role Hierarchy
  Every human speaker has a role with configured limits.
  SafetyGuard short-circuits approval if the speaker already qualifies.

Layer 3 — Approval Channels
  When escalation is needed, ApprovalOrchestrator coordinates
  voice, webhook, and external-tool channels to reach a human approver.
```

---

## Layer 1 — Safety Levels

### The four levels

| Level        | Meaning                                                         | Dispatcher behavior                      | LLM behavior                                          |
| ------------ | --------------------------------------------------------------- | ---------------------------------------- | ----------------------------------------------------- |
| `safe`       | Read-only. No side effects.                                     | Executes speculatively on SPEECH_PARTIAL | Uses cached result directly                           |
| `staged`     | Creates a reversible draft. Never commits without confirmation. | Creates draft speculatively              | Presents draft to user, waits for confirm             |
| `protected`  | Modifies real state. Requires explicit user confirmation.       | Does not execute; marks a hint           | Asks the user: "Confirm X?"                           |
| `restricted` | High impact. Requires a human with the right role.              | Does not execute; marks a hint           | Collects context, then routes to ApprovalOrchestrator |

### Declaring safety on a tool

```typescript
import type { ToolSafetyConfig } from 'fitalyagents'

const toolConfigs: ToolSafetyConfig[] = [
  // SAFE — read-only, freely speculatable
  {
    name: 'product_search',
    safety: 'safe',
  },

  // STAGED — creates a draft; user must confirm before the real action runs
  {
    name: 'order_create',
    safety: 'staged',
  },

  // PROTECTED — modifies state; LLM must ask the user explicitly
  {
    name: 'payment_process',
    safety: 'protected',
    confirm_prompt: 'Confirm payment of {amount}?',
  },

  // RESTRICTED — requires a human approver with at least 'manager' role
  {
    name: 'refund_create',
    safety: 'restricted',
    required_role: 'manager',
    approval_channels: [
      { type: 'voice', timeout_ms: 15_000 },
      { type: 'webhook', timeout_ms: 90_000 },
    ],
    approval_strategy: 'parallel',
  },
]
```

### Using SafetyGuard

```typescript
import { SafetyGuard } from 'fitalyagents'

const guard = new SafetyGuard({ toolConfigs })

const decision = guard.evaluate('refund_create', { amount: 15_000 }, speakerProfile)

switch (decision.allowed) {
  case true:
    if (decision.execute) {
      // execute directly
    } else {
      // decision.action === 'draft' — create draft first
    }
    break

  case false:
    if (decision.reason === 'needs_confirmation') {
      // ask the user: decision.prompt
    } else {
      // decision.reason === 'needs_approval'
      // decision.escalate_to = 'manager'
      // decision.channels = [...]
      // pass to ApprovalOrchestrator
    }
    break
}
```

### SafetyDecision type

```typescript
type SafetyDecision =
  | { allowed: true; execute: true }
  | { allowed: true; execute: false; action: 'draft' }
  | { allowed: false; reason: 'needs_confirmation'; prompt?: string }
  | { allowed: false; reason: 'needs_approval'; escalate_to: HumanRole; channels: ChannelConfig[] }
```

### Dynamic safety levels

Static tool safety is the default, but production deployments can add a
`ContextualSafetyResolver` to adjust the safety level for a single evaluation.
This is useful when memory, fraud signals, customer tier, sentiment, store state,
or other session context should make an action safer or more restrictive without
changing the tool definition globally.

```typescript
import {
  SafetyGuard,
  composeContextualSafetyResolvers,
  type ContextualSafetyResolver,
} from 'fitalyagents'

const vipResolver: ContextualSafetyResolver = ({ action, context }) => {
  if (action === 'payment_process' && context?.customer_tier === 'vip') return 'safe'
  return null
}

const fraudResolver: ContextualSafetyResolver = ({ action, context }) => {
  if (action.includes('payment') && context?.fraud_signal === true) return 'restricted'
  return null
}

const guard = new SafetyGuard({
  toolConfigs,
  contextualResolver: composeContextualSafetyResolvers(fraudResolver, vipResolver),
})

const decision = await guard.evaluateAsync('payment_process', { amount: 15_000 }, speakerProfile, {
  session_id: 'session_001',
  ctx: { customer_tier: 'vip', fraud_signal: false },
})
```

`evaluate()` remains synchronous for existing code. Use `evaluateAsync()` when
the resolver may read memory, sentiment state, external fraud checks, or any
other async source.

### Sentiment-aware escalation

`SentimentGuard` can feed the contextual safety layer by turning ambient emotional
signals into session state. It listens to `bus:AMBIENT_CONTEXT`, classifies each
fragment as `positive`, `neutral`, `tense`, `frustrated`, or `angry`, keeps a
short sliding window per session, and publishes `bus:SESSION_SENTIMENT_ALERT`
when the configured threshold is reached.

```typescript
import { InMemoryContextStore, SentimentGuard } from 'fitalyagents'

const contextStore = new InMemoryContextStore()

const sentimentGuard = new SentimentGuard({
  bus,
  contextStore,
  config: {
    alertThreshold: 2,
    minAlertLevel: 'tense',
    windowSize: 5,
  },
})

await sentimentGuard.start()
```

The alert is also stored in context fields such as `sentiment_alert_level` and
`sentiment_alert_count`, so a contextual resolver can raise risk when a session
is emotionally hot:

```typescript
const sentimentResolver: ContextualSafetyResolver = ({ action, context }) => {
  if (context?.sentiment_alert_level === 'angry' && action.includes('payment')) {
    return 'restricted'
  }

  if (context?.sentiment_alert_level === 'frustrated') {
    return 'protected'
  }

  return null
}
```

---

## Layer 2 — Role Hierarchy

### The five permission levels

The runtime accepts two naming schemes for the same hierarchy:

```
user / customer         No approval permissions. Can interact with the agent.
agent / staff           No approval permissions. Can ask the agent for help.
operator / cashier      Can approve payments up to payment_max.
supervisor / manager    Can approve refunds, discounts, price overrides (within limits).
owner                   Approves everything. No restrictions.
```

Use the generic names (`user`, `agent`, `operator`, `supervisor`) in multi-tenant or non-retail systems.
Retail aliases (`customer`, `staff`, `cashier`, `manager`) remain fully supported.

### HumanProfile

```typescript
interface HumanProfile {
  id: string
  name: string
  role: HumanRole // 'user'|'customer' | 'agent'|'staff' | 'operator'|'cashier' | 'supervisor'|'manager' | 'owner'
  org_id?: string // preferred generic tenant/org identifier
  store_id?: string // legacy retail alias, still supported
  approval_limits: ApprovalLimits
  voice_embedding?: Float32Array // registered by VoiceIdentifierAgent
  is_present?: boolean // true if identified by voice recently
}

interface ApprovalLimits {
  payment_max?: number // max payment amount (undefined = no permission)
  discount_max_pct?: number // max discount percentage
  refund_max?: number // max refund amount
  can_override_price?: boolean
  can_adjust_inventory?: boolean
}
```

### Default limits

```typescript
import { defaultLimits } from 'fitalyagents'

// defaultLimits.cashier  → { payment_max: 50_000 }
// defaultLimits.manager  → { payment_max: Infinity, discount_max_pct: 30,
//                            refund_max: 100_000, can_override_price: true,
//                            can_adjust_inventory: true }
// defaultLimits.owner    → { payment_max: Infinity, discount_max_pct: 100,
//                            refund_max: Infinity, can_override_price: true,
//                            can_adjust_inventory: true }
```

Limits are per-employee and configurable.
`operator` shares the same defaults as `cashier`, and `supervisor` shares the same defaults as `manager`.
A cashier can be given a higher `payment_max` than the default.

### Short-circuit: the speaker IS the approval

The examples below use the retail aliases (`customer`, `cashier`, `manager`), but the same logic applies to `user`, `operator`, and `supervisor`.

If the speaker already holds the required role and is within their limits, `SafetyGuard` returns `{ allowed: true, execute: true }` directly — no `ApprovalOrchestrator` needed.

```
refund_create, required_role: 'manager'

speaker = customer    → NO → escalate to manager
speaker = cashier     → NO → escalate to manager (cashiers cannot approve refunds)
speaker = manager,
  amount=15k ≤ refund_max=100k  → YES → execute directly
speaker = owner       → YES → always executes directly
```

### Permission matrix

Columns below use the retail aliases. The equivalent generic levels are:
`customer=user`, `staff=agent`, `cashier=operator`, `manager=supervisor`.

| Action                  | customer | staff | cashier | manager | owner |
| ----------------------- | :------: | :---: | :-----: | :-----: | :---: |
| product_search          |   YES    |  YES  |   YES   |   YES   |  YES  |
| order_create (draft)    |   YES    |  YES  |   YES   |   YES   |  YES  |
| payment_process ≤ limit |    NO    |  NO   |   YES   |   YES   |  YES  |
| payment_process > limit |    NO    |  NO   |   NO    |   YES   |  YES  |
| refund_create ≤ 100k    |    NO    |  NO   |   NO    |   YES   |  YES  |
| refund_create > 100k    |    NO    |  NO   |   NO    |   NO    |  YES  |
| discount_apply ≤ 30%    |    NO    |  NO   |   NO    |   YES   |  YES  |
| price_override          |    NO    |  NO   |   NO    |   YES   |  YES  |
| config_agent            |    NO    |  NO   |   NO    |   NO    |  YES  |

---

## Layer 3 — Approval Channels

When `SafetyGuard` returns `needs_approval`, the action is routed to `ApprovalOrchestrator`, which coordinates one or more channels to reach a human approver.

### Setting up ApprovalOrchestrator

```typescript
import {
  ApprovalOrchestrator,
  VoiceApprovalChannel,
  WebhookApprovalChannel,
  ExternalToolChannel,
} from 'fitalyagents'

const orchestrator = new ApprovalOrchestrator({
  bus,
  channelRegistry: new Map([
    ['voice', new VoiceApprovalChannel({ bus, audioQueue })],
    ['webhook', new WebhookApprovalChannel({ bus })],
  ]),
  defaultTimeoutMs: 120_000,
})

orchestrator.start()
// Listens to bus:ORDER_PENDING_APPROVAL
// Publishes bus:APPROVAL_RESOLVED when a response arrives
// Publishes bus:ORDER_APPROVAL_TIMEOUT if all channels time out
```

### Presence-aware approval routing

`ApprovalOrchestrator` can optionally use `InMemoryPresenceManager` to route
approval requests only to humans who are currently available and whose role
satisfies the requested approval role. For example, an `owner` can cover a
`manager` request. If no eligible approver is available, the request is queued
with `bus:ORDER_QUEUED_NO_APPROVER` instead of blindly timing out.

```typescript
import { ApprovalOrchestrator, InMemoryPresenceManager } from 'fitalyagents'

const presenceManager = new InMemoryPresenceManager({ bus })
presenceManager.start()

const orchestrator = new ApprovalOrchestrator({
  bus,
  channelRegistry,
  presenceManager,
})

await bus.publish('bus:HUMAN_PRESENCE_CHANGED', {
  event: 'HUMAN_PRESENCE_CHANGED',
  human_id: 'manager_ana',
  name: 'Ana',
  role: 'manager',
  status: 'available',
  store_id: 'store_001',
  approval_limits: { refund_max: 100_000 },
  timestamp: Date.now(),
})
```

When a matching human becomes available, the orchestrator drains queued approval
requests for that role, marks the approver busy while the request is active, and
marks them available again when the approval resolves or times out.

### The three channels

#### VoiceChannel

The most natural channel for employees physically on the floor. Fitaly speaks the request out loud.

```typescript
new VoiceApprovalChannel({ bus, audioQueue })
// Publishes bus:APPROVAL_VOICE_REQUEST
// → AudioQueueService plays: "Maria, approve refund of $150 for order #4521?"
// Listens to bus:SPEECH_FINAL where VoiceIdentifierAgent confirms speaker == approver
// Detects: "yes", "approve", "ok" → approved / "no", "reject" → rejected
```

Configuration: `{ type: 'voice', timeout_ms: 15_000 }`

Best for: employee is present in the store.

#### WebhookChannel

Push notification to the employee's mobile app. Employee taps approve/reject.

```typescript
new WebhookApprovalChannel({ bus })
// Publishes bus:APPROVAL_WEBHOOK_REQUEST
// → App sends push: "Approval required — Refund $150, order #4521. Tap to approve."
// Waits for HTTP POST /webhook/approval:
//   { action: 'approve', draft_id: '...', approver_id: '...' }
```

Configuration: `{ type: 'webhook', timeout_ms: 90_000 }`

Best for: employee is not on the floor but has the app on their phone.

#### ExternalToolChannel

HTTP call to an external authorization system. The external system decides how to notify the approver.

```typescript
new ExternalToolChannel({
  bus,
  url: process.env.APPROVAL_API_URL!,
  auth: process.env.APPROVAL_API_TOKEN!,
})
// Posts approval request to external URL
// Listens to bus:APPROVAL_EXTERNAL_RESPONSE
```

Configuration:

```typescript
{
  type: 'external_tool',
  timeout_ms: 60_000,
  config: {
    url: 'https://my-pos.com/api/approvals',
    method: 'POST',
    auth: 'Bearer SECRET',
  }
}
```

Best for: store already has a POS or authorization system, WhatsApp Business integration, or any legacy system.

### Coordination strategies

#### `parallel` (recommended)

All channels launch simultaneously. First to respond wins; the rest are cancelled.

```
orchestrate(request, strategy='parallel')
  ├── VoiceChannel.notify()  ← 15s timeout
  └── WebhookChannel.notify() ← 90s timeout

  Employee responds by voice at 8s
  → VoiceChannel wins
  → WebhookChannel.cancel()
  → bus:APPROVAL_RESOLVED { approved: true, channel_used: 'voice' }
```

Use when: fastest response is the priority.

#### `sequential`

Channels are tried in order. If the first times out, the next is tried.

```
orchestrate(request, strategy='sequential')
  ├── VoiceChannel.waitForResponse(15s) → timeout (no one answered)
  └── WebhookChannel.waitForResponse(90s) → approved at 30s
```

Use when: there is a preferred channel (voice) and a fallback (app).

#### `quorum`

Multiple humans are notified in parallel, and the action only succeeds after the
configured number of distinct approvers say yes. By default, any explicit
rejection fails the quorum immediately.

```typescript
const request = {
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
    reject_on_any_no: true,
  },
}

await orchestrator.orchestrate(
  request,
  [{ type: 'webhook', timeout_ms: 60_000 }],
  'quorum',
  fallbackApprover,
)
```

With `InMemoryPresenceManager`, quorum routing waits until enough eligible
humans are available. The final `APPROVAL_RESOLVED` event keeps
`approver_id` for backwards compatibility and adds `approvers` for all quorum
participants.

Use when: high-impact operations require shared accountability, such as large
refunds, inventory write-offs, pricing overrides, or policy changes.

### Bus events emitted by the governance system

```
bus:DRAFT_CREATED            {draft_id, session_id, intent_id, summary, ttl}
bus:DRAFT_CONFIRMED          {draft_id, session_id, intent_id, items, total?}
bus:DRAFT_CANCELLED          {draft_id, session_id, reason}
bus:ORDER_PENDING_APPROVAL   {request, channels, strategy, approver}
bus:HUMAN_PRESENCE_CHANGED   {human_id, role, status, store_id?, timestamp}
bus:ORDER_QUEUED_NO_APPROVER {request_id, draft_id, session_id, required_role, quorum_required?, eligible_roles?, queued_at}
bus:SESSION_HANDOFF          {session_id, from_agent_id, to_human_id?, to_role, context_snapshot, conversation_summary, pending_draft?, memory_context?, timestamp}
bus:SESSION_RESUMED          {session_id, resumed_by, resumed_by_role?, notes?, timestamp}
bus:APPROVAL_VOICE_REQUEST   {request_id, draft_id, approver_id, prompt_text}
bus:APPROVAL_WEBHOOK_REQUEST {request_id, draft_id, approver_id?, required_role, action, amount?, session_id}
bus:APPROVAL_EXTERNAL_REQUEST  {request_id, draft_id, payload}
bus:APPROVAL_EXTERNAL_RESPONSE {request_id, approved, approver_id, reason?}
bus:APPROVAL_RESOLVED        {request_id, draft_id, session_id, approved, approver_id, approvers?, channel_used, strategy?, timestamp}
bus:ORDER_APPROVED           {draft_id, session_id, approved_by, approvers?, channel_used, strategy?}
bus:ORDER_APPROVAL_TIMEOUT   {draft_id, session_id, request_id, partial_approvals?, quorum_required?}
bus:AGENT_ERROR              {agent_id, channel, error, payload?, timestamp}
```

`StreamAgent` emits `bus:AGENT_ERROR` whenever `onEvent()` throws, so failures are observable instead of being silently swallowed.

---

## The STAGED Draft Lifecycle

STAGED tools never commit to the real action until the user explicitly confirms. This covers both the speculative dispatcher (which creates a draft on SPEECH_PARTIAL) and the LLM (which presents the draft and waits).

```
User: "add the Nike Air 42 blue"
       │
       ▼
Dispatcher: order_create detected (safety=staged) → DraftStore.create()
       │
       ▼
  [ORDER_DRAFT]  ← TTL 5 min — auto-expires if nobody confirms
  Nike Air 42 blue  $150  status:draft
       │
InteractionAgent: "I have your order ready: Nike Air 42 blue, $150. Confirm?"
       │
  ┌────┴───────────────────────┐
  │            │               │
"Yes"      "No, red"      "Add this too"
  │            │               │
  ▼            ▼               ▼
CONFIRM      UPDATE           UPDATE
→ real       color='red'     items.push(...)
  order
           Re-presents      Re-presents
           "Nike ROJO       "Nike + item
            Confirm?"        Confirm?"
```

### DraftStore API

```typescript
import { DraftStore } from 'fitalyagents'

const store = new DraftStore()

// Create a draft with auto-expiry
const draftId = await store.create(sessionId, {
  intent_id: 'order_create',
  items: [{ product: 'Nike Air', size: 42, color: 'blue', price: 150 }],
  ttl_seconds: 300,
})

// Mutate before confirming — saves history for rollback
await store.update(draftId, { items: [{ ...item, color: 'red' }] })

// Rollback to previous state
await store.rollback(draftId)

// Confirm — creates the real order, deletes the draft
const order = await store.confirm(draftId)

// Cancel — deletes draft, no real-world effect
await store.cancel(draftId)
```

---

## Putting It All Together

### Minimal setup (small store, webhook only)

```typescript
import {
  InMemoryBus,
  SafetyGuard,
  ApprovalOrchestrator,
  WebhookApprovalChannel,
  InteractionAgent,
  defaultLimits,
} from 'fitalyagents'

const bus = new InMemoryBus()

const guard = new SafetyGuard({ toolConfigs })

const orchestrator = new ApprovalOrchestrator({
  bus,
  channelRegistry: new Map([['webhook', new WebhookApprovalChannel({ bus })]]),
})

orchestrator.start()

const agent = new InteractionAgent({ bus, llm, safetyGuard: guard, sessions })
agent.start()
```

### Full setup (voice + webhook + external system)

```typescript
import {
  InMemoryBus,
  SafetyGuard,
  ApprovalOrchestrator,
  VoiceApprovalChannel,
  WebhookApprovalChannel,
  ExternalToolChannel,
  InteractionAgent,
  StaffAgent,
  UIAgent,
  InMemorySessionManager,
  InMemoryAudioQueueService,
} from 'fitalyagents'

const bus = new InMemoryBus()
const sessions = new InMemorySessionManager({ bus })
const audioQueue = new InMemoryAudioQueueService({ bus })
audioQueue.start()

const guard = new SafetyGuard({ toolConfigs })

const orchestrator = new ApprovalOrchestrator({
  bus,
  channelRegistry: new Map([
    ['voice', new VoiceApprovalChannel({ bus, audioQueue })],
    ['webhook', new WebhookApprovalChannel({ bus })],
    [
      'external_tool',
      new ExternalToolChannel({
        bus,
        url: process.env.APPROVAL_API_URL!,
        auth: process.env.APPROVAL_API_TOKEN!,
      }),
    ],
  ]),
})

orchestrator.start()

// Agents
new InteractionAgent({ bus, llm, safetyGuard: guard, sessions }).start()
new StaffAgent({ bus, llm, safetyGuard: guard }).start()
new UIAgent({ bus }).start()
```

---

## StaffAgent — Employee Override

`StaffAgent` extends the governance model to employees speaking to the system. When an employee says an activation keyword (e.g., _"fitaly"_), the InteractionAgent is paused and the StaffAgent takes control.

```
Employee: "fitaly, apply 20% discount to this order"
   │
   ▼
StaffAgent: keyword detected
   → bus:INTERACTION_PAUSE { session_id, staff_id }
   → bus:SESSION_HANDOFF { context_snapshot, conversation_summary, pending_draft?, memory_context? }
   → InteractionAgent: paused (ignores all SPEECH_FINAL)
   │
   ▼
StaffAgent: processes command with LLM
   → SafetyGuard.evaluate('discount_apply', { percentage: 20 }, managerProfile)
   → manager.discount_max_pct=30 ≥ 20 → allowed: true, execute: true
   → Executes directly
   → bus:STAFF_COMMAND { command, result }
   │
Employee: "fitaly, done"
   │
   ▼
StaffAgent: resume keyword detected
   → bus:INTERACTION_RESUME
   → bus:SESSION_RESUMED { session_id, resumed_by, notes? }
   → InteractionAgent: resumes
```

Configuration:

```typescript
const handoffBuilder = new HandoffBuilder({
  contextStore,
  draftStore,
  memoryStore, // optional; compatible with MemPalace-backed IMemoryStore
})

const staffAgent = new StaffAgent({
  bus,
  llm,
  safetyGuard: guard,
  toolRegistry,
  executor,
  handoffBuilder,
  config: {
    activationKeywords: ['fitaly', 'system'], // default
    staffRoles: ['staff', 'agent', 'cashier', 'operator', 'manager', 'supervisor', 'owner'],
    autoResumeTimeoutMs: 30_000, // auto-resume if employee goes silent
  },
})
```

`SESSION_HANDOFF` is designed for tablets, dashboards, and manager devices. It
lets the receiving human see why the handoff happened, what the customer said,
which draft is pending, and what memory or sentiment context matters before
they speak. External systems can also publish `SESSION_RESUMED`; both
`StaffAgent` and `InteractionAgent` treat it as a resume signal.

---

## See Also

- [Safety Model](SAFETY-MODEL.md) — full decision matrix, 15 concrete flow diagrams
- [Human Roles](HUMAN-ROLES.md) — role details, voice identification, scenarios
- [Approval Channels](APPROVAL-CHANNELS.md) — channel interface, configuration, examples
- [Speculative Dispatcher](DISPATCHER-SPECULATIVE.md) — how drafts are pre-created before the user finishes speaking
