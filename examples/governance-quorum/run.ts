import {
  ApprovalOrchestrator,
  InMemoryBus,
  InMemoryPresenceManager,
  SafetyGuard,
  WebhookApprovalChannel,
  type ApprovalWebhookRequestEvent,
  type HumanProfile,
  type ToolSafetyConfig,
} from 'fitalyagents'

const STORE_ID = 'store_flagship'

const toolConfigs: ToolSafetyConfig[] = [
  {
    name: 'inventory_writeoff',
    safety: 'restricted',
    required_role: 'manager',
    approval_channels: [{ type: 'webhook', timeout_ms: 45_000 }],
    approval_strategy: 'quorum',
    quorum: {
      required: 2,
      eligible_roles: ['manager', 'owner'],
      reject_on_any_no: true,
    },
  },
]

const floorOperator: HumanProfile = {
  id: 'operator_lina',
  name: 'Lina',
  role: 'operator',
  store_id: STORE_ID,
  approval_limits: {
    payment_max: 50_000,
  },
}

const managerAna: HumanProfile = {
  id: 'manager_ana',
  name: 'Ana',
  role: 'manager',
  store_id: STORE_ID,
  approval_limits: {
    refund_max: 100_000,
    can_adjust_inventory: true,
  },
}

const ownerLuis: HumanProfile = {
  id: 'owner_luis',
  name: 'Luis',
  role: 'owner',
  store_id: STORE_ID,
  approval_limits: {
    refund_max: Infinity,
    can_adjust_inventory: true,
    can_override_price: true,
  },
}

const approvalPlans: Record<string, { approved: boolean; delayMs: number; reason?: string }> = {
  manager_ana: { approved: true, delayMs: 800 },
  owner_luis: { approved: true, delayMs: 1_400 },
}

async function main(): Promise<void> {
  const bus = new InMemoryBus()
  const guard = new SafetyGuard({ toolConfigs })
  const presenceManager = new InMemoryPresenceManager({ bus })
  presenceManager.start()

  const webhookChannel = new WebhookApprovalChannel({ bus })
  const orchestrator = new ApprovalOrchestrator({
    bus,
    channelRegistry: new Map([['webhook', webhookChannel]]),
    presenceManager,
    defaultTimeoutMs: 45_000,
  })
  orchestrator.start()

  presenceManager.update(managerAna, 'available', STORE_ID)

  const done = createCompletionPromise(bus)
  installConsoleObservers(bus)
  installMockApproverApp(bus)

  console.log('\nFitalyAgents - Governance Quorum Demo')
  console.log('====================================')
  console.log(
    'Scenario: a high-risk inventory write-off requires 2 approvals from managers or owners.',
  )
  console.log(
    'Only one approver is available at first, so the request is queued until a second approver appears.\n',
  )

  const decision = guard.evaluate(
    'inventory_writeoff',
    { amount: 52_000, sku: 'SKU-7844', reason: 'damaged inventory' },
    floorOperator,
  )

  console.log('[safety] Decision:')
  console.log(JSON.stringify(decision, null, 2))

  if (decision.allowed || decision.reason !== 'needs_approval') {
    throw new Error('This example expects a restricted action that requires approval.')
  }

  setTimeout(() => {
    console.log('\n[presence] Owner Luis became available in the same store.')
    void bus.publish('bus:HUMAN_PRESENCE_CHANGED', {
      event: 'HUMAN_PRESENCE_CHANGED',
      human_id: ownerLuis.id,
      name: ownerLuis.name,
      role: ownerLuis.role,
      status: 'available',
      store_id: ownerLuis.store_id,
      approval_limits: ownerLuis.approval_limits,
      timestamp: Date.now(),
    })
  }, 1_000)

  await bus.publish('bus:ORDER_PENDING_APPROVAL', {
    event: 'ORDER_PENDING_APPROVAL',
    request: {
      id: `approval_${Date.now()}`,
      draft_id: 'draft_inventory_7844',
      action: 'inventory_writeoff',
      amount: 52_000,
      session_id: 'session_store_floor_1',
      required_role: decision.escalate_to,
      context: {
        store_id: STORE_ID,
        sku: 'SKU-7844',
        reason: 'damaged inventory',
      },
      timeout_ms: 45_000,
      quorum: decision.quorum,
    },
    channels: decision.channels,
    strategy: 'quorum',
    approver: managerAna,
  })

  await done
  await sleep(50)

  orchestrator.dispose()
  presenceManager.dispose()
}

function installConsoleObservers(bus: InMemoryBus): void {
  bus.subscribe('bus:ORDER_QUEUED_NO_APPROVER', (payload) => {
    const event = payload as {
      required_role: string
      quorum_required?: number
      eligible_roles?: string[]
    }
    console.log('[governance] Request queued because there are not enough approvers yet.')
    console.log(
      `[governance] Required role: ${event.required_role}; quorum: ${String(event.quorum_required)} of ${event.eligible_roles?.join(', ')}`,
    )
  })

  bus.subscribe('bus:APPROVAL_WEBHOOK_REQUEST', (payload) => {
    const event = payload as ApprovalWebhookRequestEvent
    console.log(
      `[webhook] Pending approval for ${event.approver_id ?? 'unknown'} on request ${event.request_id}`,
    )
  })

  bus.subscribe('bus:APPROVAL_RESOLVED', (payload) => {
    const event = payload as {
      approved: boolean
      approver_id: string
      approvers?: string[]
      strategy?: string
      channel_used: string
    }

    console.log('\n[governance] Approval resolved:')
    console.log(
      JSON.stringify(
        {
          approved: event.approved,
          approver_id: event.approver_id,
          approvers: event.approvers,
          strategy: event.strategy,
          channel_used: event.channel_used,
        },
        null,
        2,
      ),
    )
  })

  bus.subscribe('bus:ORDER_APPROVED', (payload) => {
    const event = payload as {
      draft_id: string
      approved_by: string
      approvers?: string[]
      strategy?: string
    }

    console.log('\n[action] Write-off approved.')
    console.log(
      JSON.stringify(
        {
          draft_id: event.draft_id,
          approved_by: event.approved_by,
          approvers: event.approvers,
          strategy: event.strategy,
        },
        null,
        2,
      ),
    )
  })

  bus.subscribe('bus:ORDER_APPROVAL_TIMEOUT', (payload) => {
    const event = payload as {
      request_id: string
      partial_approvals?: number
      quorum_required?: number
    }

    console.log('\n[governance] Approval timed out:')
    console.log(
      JSON.stringify(
        {
          request_id: event.request_id,
          partial_approvals: event.partial_approvals,
          quorum_required: event.quorum_required,
        },
        null,
        2,
      ),
    )
  })
}

function installMockApproverApp(bus: InMemoryBus): void {
  bus.subscribe('bus:APPROVAL_WEBHOOK_REQUEST', (payload) => {
    const event = payload as ApprovalWebhookRequestEvent
    const approverId = event.approver_id
    if (!approverId) return

    const plan = approvalPlans[approverId]
    if (!plan) return

    console.log(
      `[approver-app] ${approverId} will ${plan.approved ? 'approve' : 'reject'} in ${plan.delayMs}ms`,
    )

    setTimeout(() => {
      void bus.publish('bus:APPROVAL_WEBHOOK_RESPONSE', {
        event: 'APPROVAL_WEBHOOK_RESPONSE',
        request_id: event.request_id,
        approved: plan.approved,
        approver_id: approverId,
        reason: plan.reason,
      })
    }, plan.delayMs)
  })
}

function createCompletionPromise(bus: InMemoryBus): Promise<void> {
  return new Promise((resolve) => {
    let finished = false

    const finish = () => {
      if (finished) return
      finished = true
      resolve()
    }

    bus.subscribe('bus:ORDER_APPROVED', finish)
    bus.subscribe('bus:ORDER_APPROVAL_TIMEOUT', finish)
    bus.subscribe('bus:APPROVAL_RESOLVED', finish)
  })
}

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms))
}

main().catch((error) => {
  console.error(error)
  process.exitCode = 1
})
