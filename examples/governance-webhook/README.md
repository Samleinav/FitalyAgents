# Governance Webhook Example

Demonstrates the full RESTRICTED action flow: an agent triggers an action that requires human authorization, the request is surfaced via HTTP, a human approves or rejects it, and the agent receives the result.

No Redis required — uses `InMemoryBus`.

If you need multiple human approvals instead of a single approver, see
[Governance Quorum Example](../governance-quorum/README.md).

---

## What this shows

```
Customer says: "I want a refund for order #4521"
        │
        ▼
LLM identifies: refund_create { amount: 150 }
        │
        ▼
SafetyGuard.evaluate('refund_create', { amount: 150 }, customer)
  → { allowed: false, reason: 'needs_approval', escalate_to: 'manager' }
        │
        ▼
bus:ORDER_PENDING_APPROVAL published
        │
        ▼
ApprovalOrchestrator → WebhookApprovalChannel.notify()
  → publishes bus:APPROVAL_WEBHOOK_REQUEST
        │
        ▼
Approval Bridge HTTP Server receives it
  → stores pending request
  → (optional) forwards as HTTP POST to external system
        │
        ▼
Human opens http://localhost:3456
  → sees the pending request
  → clicks Approve or Reject
        │
        ▼
POST /approve { request_id, approver_id }
  → bridge publishes bus:APPROVAL_WEBHOOK_RESPONSE
        │
        ▼
WebhookApprovalChannel resolves
  → ApprovalOrchestrator publishes bus:APPROVAL_RESOLVED
        │
        ▼
Agent executes the refund (or skips it if rejected)
```

---

## Run

```bash
cd examples/governance-webhook
pnpm install
pnpm start
```

Then open **http://localhost:3456** in your browser and click **Approve** or **Reject**.

Or use curl directly:

```bash
# Get the request_id from the console output, then:

# Approve
curl -X POST http://localhost:3456/approve \
  -H "Content-Type: application/json" \
  -d '{ "request_id": "req_XXXX", "approver_id": "manager_001" }'

# Reject
curl -X POST http://localhost:3456/reject \
  -H "Content-Type: application/json" \
  -d '{ "request_id": "req_XXXX", "reason": "Amount too high" }'
```

---

## The Approval Bridge

[src/approval-server.ts](src/approval-server.ts) is the adapter between FitalyAgents and any external system.

### What it exposes

| Endpoint | Description |
|---|---|
| `GET /` | Approver web UI |
| `GET /pending` | JSON list of pending approval requests |
| `POST /approve` | `{ request_id, approver_id }` — approve and trigger action |
| `POST /reject` | `{ request_id, reason? }` — reject and cancel action |

### What an external system needs to implement

That's it. Any app — mobile, web, POS, or an existing authorization system — only needs those three interactions:

```
1. Poll GET /pending
   or receive a push POST (see push mode below)

2. Show the pending approval to an authorized user

3. POST /approve or /reject when they decide
```

The external system never touches the event bus directly.

---

## Connecting your existing system

### Option A — Pull (polling)

Your system polls `GET /pending` on whatever interval makes sense:

```typescript
// Your existing system — any language, any framework
const pending = await fetch('http://localhost:3456/pending').then(r => r.json())

for (const req of pending) {
  // Show to approver in your UI
  // When they decide:
  await fetch('http://localhost:3456/approve', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ request_id: req.request_id, approver_id: 'emp_001' }),
  })
}
```

### Option B — Push (FitalyAgents calls your system)

Enable `externalPushUrl` in [src/index.ts](src/index.ts):

```typescript
createApprovalServer(bus, {
  port: PORT,
  externalPushUrl: 'https://my-app.com/api/approval-requests',
})
```

FitalyAgents will POST to your URL with:

```json
{
  "request_id": "req_1234",
  "action": "refund_create",
  "amount": 150,
  "required_role": "manager",
  "session_id": "sess_001",
  "approve_url": "http://localhost:3456/approve",
  "reject_url":  "http://localhost:3456/reject"
}
```

Your system shows it to the approver. When they decide, POST to `approve_url` or `reject_url`. Done.

### Option C — Your system already handles approvals

If you have an existing authorization system, use `ExternalToolChannel` instead of `WebhookApprovalChannel`:

```typescript
import { ExternalToolChannel } from 'fitalyagents'

const orchestrator = new ApprovalOrchestrator({
  bus,
  channelRegistry: new Map([
    ['external_tool', new ExternalToolChannel({
      bus,
      url:  'https://my-auth-system.com/api/approvals',
      auth: `Bearer ${process.env.AUTH_TOKEN}`,
    })],
  ]),
})
```

FitalyAgents calls your API directly. Your system is responsible for reaching the approver. When a decision is made, your system publishes back to `bus:APPROVAL_EXTERNAL_RESPONSE`.

---

## Files

```
governance-webhook/
  src/
    index.ts            Main demo — sets up bus, guard, orchestrator, simulates flow
    approval-server.ts  HTTP bridge — bus:APPROVAL_WEBHOOK_REQUEST <-> HTTP
  public/
    index.html          Approver web UI — polls /pending, approve/reject buttons
  package.json
  tsconfig.json
  README.md
```

---

## Key concepts

- **`SafetyGuard`** — evaluates every action against the speaker's role and limits
- **`WebhookApprovalChannel`** — listens to `bus:APPROVAL_WEBHOOK_REQUEST`, waits for `bus:APPROVAL_WEBHOOK_RESPONSE`
- **`ApprovalOrchestrator`** — coordinates one or more channels; publishes `bus:APPROVAL_RESOLVED`
- The bridge HTTP server is just a Node `http.createServer` — no framework dependency

See [docs/GOVERNANCE.md](../../docs/GOVERNANCE.md) for the full governance reference.
