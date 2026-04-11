# Governance Quorum Example

Runnable example showing presence-aware `quorum` approvals for a high-risk
action.

This demo uses:

- `SafetyGuard` to classify `inventory_writeoff` as `restricted`
- `ApprovalOrchestrator` with `approval_strategy: 'quorum'`
- `InMemoryPresenceManager` so the request waits until enough eligible humans
  are available
- `WebhookApprovalChannel` to simulate remote approver devices

## Run

```bash
pnpm --filter fitalyagents build
pnpm --filter governance-quorum-example run run
```

## What It Shows

- a store operator triggers a write-off they cannot authorize themselves
- the tool requires `2` approvals from `manager` or `owner`
- only one approver is initially present, so the request emits
  `ORDER_QUEUED_NO_APPROVER`
- when a second eligible approver becomes available, the quorum starts
- each approver receives a distinct webhook request with their own
  `approver_id`
- the final `APPROVAL_RESOLVED` event includes `approvers` and
  `strategy: 'quorum'`

## Why This Matters

Single-approver flows are enough for routine refunds or overrides. Quorum
approvals are for actions where shared accountability matters, such as:

- large write-offs
- high-value refunds
- pricing overrides above policy limits
- destructive operational changes

## Try Variations

- Change `required: 2` to `required: 3` to see the request stay queued longer.
- Set `reject_on_any_no: false` to model a "two yes votes still win" policy.
- Change one approval plan in [`run.ts`](run.ts)
  to `approved: false` to watch the default fast-reject behavior.

See [Governance Guide](../../docs/GOVERNANCE.md) and
[Approval Channels](../../docs/APPROVAL-CHANNELS.md) for the full model.
