/**
 * Governance Webhook Example
 *
 * Demonstrates a RESTRICTED action flow end-to-end using only an in-memory bus
 * (no Redis required).
 *
 * What this shows:
 *   1. SafetyGuard evaluates a RESTRICTED action — customer has no permission
 *   2. ApprovalOrchestrator routes to WebhookApprovalChannel
 *   3. WebhookApprovalChannel publishes bus:APPROVAL_WEBHOOK_REQUEST
 *   4. The approval-server bridge picks it up and serves an approval UI
 *   5. A human visits http://localhost:3456 and approves/rejects
 *   6. The bridge publishes bus:APPROVAL_WEBHOOK_RESPONSE
 *   7. WebhookApprovalChannel resolves → ApprovalOrchestrator publishes APPROVAL_RESOLVED
 *   8. The action executes (or is rejected)
 *
 * The external system (app / web app / POS / existing system) only needs to:
 *   - Receive the notification (via GET /pending poll or a push POST to its URL)
 *   - POST { request_id, approver_id } to /approve
 *   - or POST { request_id, reason }   to /reject
 */

import {
  InMemoryBus,
  SafetyGuard,
  WebhookApprovalChannel,
  ApprovalOrchestrator,
  type HumanProfile,
  type ToolSafetyConfig,
} from 'fitalyagents'
import { createApprovalServer } from './approval-server.js'

const PORT = 3456

// ── Tool configs — declare safety level per action ────────────────────────────

const toolConfigs: ToolSafetyConfig[] = [
  {
    name: 'product_search',
    safety: 'safe',
  },
  {
    name: 'order_create',
    safety: 'staged',
  },
  {
    name: 'payment_process',
    safety: 'protected',
    confirm_prompt: 'Confirm payment of {amount}?',
  },
  {
    // RESTRICTED: requires a human with 'manager' role to approve
    name: 'refund_create',
    safety: 'restricted',
    required_role: 'manager',
    approval_channels: [{ type: 'webhook', timeout_ms: 120_000 }],
    approval_strategy: 'parallel',
  },
]

// ── Simulated speakers ────────────────────────────────────────────────────────

const customer: HumanProfile = {
  id: 'customer_001',
  name: 'Carlos',
  role: 'customer',
  store_id: 'store_1',
  approval_limits: {},
}

// The approver (manager) exists in the system — they will respond via the web UI
const manager: HumanProfile = {
  id: 'manager_001',
  name: 'Maria',
  role: 'manager',
  store_id: 'store_1',
  approval_limits: {
    payment_max: Infinity,
    refund_max: 100_000,
    discount_max_pct: 30,
    can_override_price: true,
  },
}

// ── Main ──────────────────────────────────────────────────────────────────────

async function main() {
  // 1. Create bus (in-memory — no Redis needed for this demo)
  const bus = new InMemoryBus()

  // 2. SafetyGuard — knows which tools require what level of authorization
  const guard = new SafetyGuard({ toolConfigs })

  // 3. WebhookApprovalChannel — bridges bus events to/from HTTP
  const webhookChannel = new WebhookApprovalChannel({ bus })

  // 4. ApprovalOrchestrator — coordinates channels when a RESTRICTED action is triggered
  const orchestrator = new ApprovalOrchestrator({
    bus,
    channelRegistry: new Map([['webhook', webhookChannel]]),
    defaultTimeoutMs: 120_000,
  })
  orchestrator.start()

  // 5. Start the approval bridge HTTP server
  //    This is all an external system needs to implement on their side:
  //      GET  /pending → list pending approvals
  //      POST /approve → { request_id, approver_id }
  //      POST /reject  → { request_id, reason }
  //
  //    Optionally pass externalPushUrl to also forward requests via HTTP POST
  //    to an existing system (mobile app, POS, etc.)
  createApprovalServer(bus, {
    port: PORT,
    // externalPushUrl: 'https://my-app.com/api/approval-requests',
  })

  // 6. Listen for the final resolution
  bus.subscribe('bus:APPROVAL_RESOLVED', (data) => {
    const ev = data as { approved: boolean; approver_id: string; channel_used: string }
    console.log('\n──────────────────────────────────────────')
    if (ev.approved) {
      console.log(`[governance] APPROVED by ${ev.approver_id} via ${ev.channel_used}`)
      console.log('[governance] Executing refund_create...')
      console.log('[governance] Refund of $150 for order #4521 processed.')
    } else {
      console.log(`[governance] REJECTED via ${ev.channel_used}`)
      console.log('[governance] No refund was created.')
    }
    console.log('──────────────────────────────────────────\n')
    console.log('Demo complete. Press Ctrl+C to exit.')
  })

  bus.subscribe('bus:ORDER_APPROVAL_TIMEOUT', () => {
    console.log('\n[governance] Approval timed out — no action taken.')
    console.log('Demo complete. Press Ctrl+C to exit.')
  })

  // ── Simulate the flow ────────────────────────────────────────────────────────

  console.log('\n══════════════════════════════════════════')
  console.log('  FitalyAgents — Governance Webhook Demo')
  console.log('══════════════════════════════════════════\n')

  // Step 1: Customer triggers a refund
  console.log('[demo] Customer says: "I want a refund for order #4521"')
  console.log('[demo] LLM identifies intent: refund_create { amount: 150, order_id: "#4521" }\n')

  // Step 2: SafetyGuard evaluates — customer has no permission
  const decision = guard.evaluate('refund_create', { amount: 150 }, customer)
  console.log('[SafetyGuard] Decision:', JSON.stringify(decision, null, 2))

  if (decision.allowed) {
    // Would execute directly (e.g. manager calling it themselves)
    console.log('[governance] Executing directly.')
    return
  }

  if (decision.reason !== 'needs_approval') {
    // PROTECTED — would ask the user for confirmation first
    console.log(`[governance] Needs user confirmation: ${decision.prompt ?? ''}`)
    return
  }

  // Step 3: Needs approval — publish to the bus so the orchestrator handles it
  console.log(`\n[governance] Escalating to role: "${decision.escalate_to}"`)
  console.log('[governance] Publishing bus:ORDER_PENDING_APPROVAL...\n')

  await bus.publish('bus:ORDER_PENDING_APPROVAL', {
    event: 'ORDER_PENDING_APPROVAL',
    // ApprovalRequest
    request: {
      id: `req_${Date.now()}`,
      draft_id: 'draft_4521',
      action: 'refund_create',
      amount: 150,
      session_id: 'sess_001',
      required_role: decision.escalate_to,
      context: { order_id: '#4521', customer: customer.name },
      timeout_ms: 120_000,
    },
    channels: decision.channels,
    strategy: 'parallel',
    // The approver that the orchestrator will notify (looked up by the agent in real usage)
    approver: manager,
  })

  // Step 4: The approval bridge received bus:APPROVAL_WEBHOOK_REQUEST
  //         and logged a link to the web UI (see console above)
  //         Open http://localhost:3456 to approve or reject.
}

main().catch((err) => {
  console.error('[error]', err)
  process.exit(1)
})
