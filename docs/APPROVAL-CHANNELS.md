# Approval Channels

Roles define **who** can approve. Channels define **how** the approval request
reaches a human or external system.

In FitalyAgents, approval channels are configured per tool and coordinated by
`ApprovalOrchestrator`.

---

## Core Flow

When a `restricted` tool needs escalation:

```text
restricted tool detected
  -> SafetyGuard checks speaker role and limits
    -> allowed: execute directly
    -> needs_approval: publish ORDER_PENDING_APPROVAL
      -> ApprovalOrchestrator routes through one or more channels
      -> result published as APPROVAL_RESOLVED / ORDER_APPROVED / ORDER_APPROVAL_TIMEOUT
```

The same tool can use:

- `parallel` for fastest response
- `sequential` for preferred-channel fallback
- `quorum` for N-of-M approvals on high-risk actions

---

## Channel Interface

```ts
type ApprovalChannelType = 'voice' | 'webhook' | 'external_tool'

type ApprovalStrategy = 'parallel' | 'sequential' | 'quorum'

interface QuorumConfig {
  required: number
  eligible_roles: HumanRole[]
  reject_on_any_no?: boolean
}

interface ApprovalRequest {
  id: string
  draft_id: string
  action: string
  amount?: number
  session_id: string
  required_role: HumanRole
  context: Record<string, unknown>
  timeout_ms: number
  quorum?: QuorumConfig
}

interface ApprovalResponse {
  approved: boolean
  approver_id: string
  approvers?: string[]
  channel_used: string
  reason?: string
  timestamp: number
}

interface IApprovalChannel {
  id: string
  type: ApprovalChannelType
  notify(request: ApprovalRequest, approver: HumanProfile): Promise<void>
  waitForResponse(
    request: ApprovalRequest,
    timeoutMs: number,
  ): Promise<ApprovalResponse | null>
  cancel(requestId: string): void
}
```

---

## Built-In Channels

### `VoiceApprovalChannel`

Best for in-store staff who are physically present.

What it does:

- publishes `bus:APPROVAL_VOICE_REQUEST`
- waits for `bus:SPEECH_FINAL`
- checks the expected approver identity when the request is targeted
- resolves from simple yes/no language

Typical config:

```ts
{ type: 'voice', timeout_ms: 15_000 }
```

Use it when:

- the approver is on the floor
- the fastest path is spoken approval
- hands-free approval matters

### `WebhookApprovalChannel`

Best for mobile apps, remote managers, tablets, browser dashboards, or custom
bridges.

What it does:

- publishes `bus:APPROVAL_WEBHOOK_REQUEST`
- includes `approver_id` when the request targets a specific person
- waits for `bus:APPROVAL_WEBHOOK_RESPONSE`

Typical config:

```ts
{ type: 'webhook', timeout_ms: 90_000 }
```

Use it when:

- the approver is remote
- you already have a browser, mobile, or POS UI
- you want HTTP or MCP adapters around the event bus

### `ExternalToolChannel`

Best for organizations that already have their own authorization backend.

What it does:

- sends an outbound HTTP request to your external approval system
- waits for `bus:APPROVAL_EXTERNAL_RESPONSE`

Typical config:

```ts
{
  type: 'external_tool',
  timeout_ms: 60_000,
  config: {
    url: 'https://example.com/api/approvals',
    method: 'POST',
    auth: 'Bearer secret-token',
  },
}
```

Use it when:

- approvals already live in a separate backend
- you need enterprise policy enforcement outside the agent runtime
- you want FitalyAgents to plug into an existing operational workflow

---

## Coordination Strategies

### `parallel`

All configured channels launch immediately. First response wins.

```text
voice notifies
webhook notifies
employee answers voice first
-> webhook is cancelled
-> APPROVAL_RESOLVED
```

Use it when speed matters most.

### `sequential`

Channels run in order. If one times out, the next starts.

```text
voice waits 15s -> timeout
webhook starts -> approved
```

Use it when one channel is preferred and another is a fallback.

### `quorum`

Multiple eligible humans are contacted, and the request only succeeds after the
configured number of distinct approvers say yes.

```ts
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
    reject_on_any_no: true,
  },
}
```

Behavior:

- approvers receive distinct targeted requests
- `APPROVAL_RESOLVED` keeps `approver_id` for compatibility and adds
  `approvers`
- by default, any explicit rejection ends the quorum immediately
- if quorum is not reached in time, timeout events can include
  `partial_approvals`

Use it when shared accountability matters:

- large refunds
- high-value inventory write-offs
- pricing overrides above policy thresholds
- destructive operational changes

---

## Presence-Aware Routing

If you use `InMemoryPresenceManager`, approvals become availability-aware.

Single approver flow:

- the orchestrator looks for an available human with the required role or
  higher
- if none are available, it publishes `ORDER_QUEUED_NO_APPROVER`
- the request resumes when presence changes make an approver available

Quorum flow:

- the orchestrator looks for enough distinct eligible humans
- if fewer than `quorum.required` are available, the request stays queued
- once enough approvers are present, quorum notification begins

Relevant events:

```text
bus:HUMAN_PRESENCE_CHANGED
bus:ORDER_QUEUED_NO_APPROVER
bus:APPROVAL_RESOLVED
bus:ORDER_APPROVED
bus:ORDER_APPROVAL_TIMEOUT
```

---

## Tool Configuration Examples

### Fast retail approval

```ts
{
  name: 'refund_create',
  safety: 'restricted',
  required_role: 'manager',
  approval_channels: [
    { type: 'voice', timeout_ms: 15_000 },
    { type: 'webhook', timeout_ms: 90_000 },
  ],
  approval_strategy: 'parallel',
}
```

### Preferred voice with remote fallback

```ts
{
  name: 'price_override',
  safety: 'restricted',
  required_role: 'supervisor',
  approval_channels: [
    { type: 'voice', timeout_ms: 15_000 },
    { type: 'webhook', timeout_ms: 90_000 },
  ],
  approval_strategy: 'sequential',
}
```

### Shared approval for a high-risk action

```ts
{
  name: 'inventory_writeoff',
  safety: 'restricted',
  required_role: 'manager',
  approval_channels: [{ type: 'webhook', timeout_ms: 60_000 }],
  approval_strategy: 'quorum',
  quorum: {
    required: 2,
    eligible_roles: ['manager', 'owner'],
    reject_on_any_no: true,
  },
}
```

---

## Runnable Examples

- [Governance Webhook Example](../examples/governance-webhook/README.md) —
  single-approver approval through a browser or external app bridge
- [Governance Quorum Example](../examples/governance-quorum/README.md) —
  presence-aware 2-of-N approvals for high-risk actions

For the full governance model, see [Governance Guide](GOVERNANCE.md).
