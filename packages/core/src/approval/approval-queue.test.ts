import { describe, it, expect, beforeEach, afterEach } from 'vitest'
import { InMemoryBus } from '../bus/in-memory-bus.js'
import { InMemoryApprovalQueue } from './in-memory-approval-queue.js'
import { ApprovalNotFoundError, ApprovalAlreadyResolvedError } from './types.js'

// ── Helpers ───────────────────────────────────────────────────────────────────

const wait = (ms: number) => new Promise((r) => setTimeout(r, ms))

/** Publish a synthetic ORDER_PENDING_APPROVAL event to simulate OrderAgent */
async function publishPendingApproval(
  bus: InMemoryBus,
  overrides: Partial<{
    draft_id: string
    submission_id: string
    intent_id: string
    session_id: string
    task_id: string
    draft_total: number
    original_order_id: string
    approval_timeout_ms: number
  }> = {},
) {
  await bus.publish('bus:ORDER_PENDING_APPROVAL', {
    event: 'ORDER_PENDING_APPROVAL',
    draft_id: overrides.draft_id ?? 'draft_001',
    submission_id: overrides.submission_id ?? 'sub_001',
    intent_id: overrides.intent_id ?? 'order_create',
    session_id: overrides.session_id ?? 'sess_1',
    task_id: overrides.task_id ?? 'task_1',
    draft_total: overrides.draft_total ?? 99.99,
    original_order_id: overrides.original_order_id,
    approval_timeout_ms: overrides.approval_timeout_ms,
    agent_id: 'order-agent-001',
    timestamp: Date.now(),
  })
}

// ── Tests ─────────────────────────────────────────────────────────────────────

describe('InMemoryApprovalQueue', () => {
  let bus: InMemoryBus
  let queue: InMemoryApprovalQueue
  let queueUnsub: () => void

  beforeEach(() => {
    bus = new InMemoryBus()
    queue = new InMemoryApprovalQueue({ bus, defaultTimeoutMs: 5000 })
    queueUnsub = queue.start()
  })

  afterEach(() => {
    queueUnsub()
  })

  // ── Record creation ───────────────────────────────────────────────────

  it('creates a pending record when ORDER_PENDING_APPROVAL is received', async () => {
    await publishPendingApproval(bus, { draft_id: 'draft_A', draft_total: 149.99 })
    await wait(5)

    const record = queue.getRecord('draft_A')
    expect(record).not.toBeNull()
    expect(record!.status).toBe('pending')
    expect(record!.draft_total).toBe(149.99)
    expect(record!.intent_id).toBe('order_create')
  })

  it('getPending() returns only pending records', async () => {
    await publishPendingApproval(bus, { draft_id: 'draft_B1' })
    await publishPendingApproval(bus, { draft_id: 'draft_B2' })
    await wait(5)

    expect(queue.getPending().length).toBe(2)

    await queue.approve('draft_B1', 'approver_1')

    const pending = queue.getPending()
    expect(pending.length).toBe(1)
    expect(pending[0]!.draft_id).toBe('draft_B2')
  })

  // ── Approve ───────────────────────────────────────────────────────────

  it('approve() updates status to approved', async () => {
    await publishPendingApproval(bus, { draft_id: 'draft_C' })
    await wait(5)

    await queue.approve('draft_C', 'manager_alice')

    const record = queue.getRecord('draft_C')
    expect(record!.status).toBe('approved')
    expect(record!.approved_by).toBe('manager_alice')
    expect(record!.resolved_at).toBeDefined()
  })

  it('approve() publishes bus:ORDER_APPROVED', async () => {
    const events: unknown[] = []
    bus.subscribe('bus:ORDER_APPROVED', (d) => events.push(d))

    await publishPendingApproval(bus, { draft_id: 'draft_D', session_id: 'sess_D' })
    await wait(5)
    await queue.approve('draft_D', 'manager_bob')

    expect(events.length).toBe(1)
    const event = events[0] as Record<string, unknown>
    expect(event.draft_id).toBe('draft_D')
    expect(event.approved_by).toBe('manager_bob')
    expect(event.session_id).toBe('sess_D')
  })

  it('approve() publishes bus:ACTION_COMPLETED with confirmation text', async () => {
    const events: unknown[] = []
    bus.subscribe('bus:ACTION_COMPLETED', (d) => events.push(d))

    await publishPendingApproval(bus, { draft_id: 'draft_E', draft_total: 59.99 })
    await wait(5)
    await queue.approve('draft_E', 'manager_carol')

    expect(events.length).toBe(1)
    const event = events[0] as Record<string, unknown>
    const result = event.result as Record<string, unknown>
    expect(result.approved).toBe(true)
    expect(result.text).toContain('59.99')
    expect(result.text).toContain('confirmed')
  })

  // ── Reject ────────────────────────────────────────────────────────────

  it('reject() updates status to rejected and publishes ORDER_APPROVAL_REJECTED', async () => {
    const rejectedEvents: unknown[] = []
    const actionEvents: unknown[] = []
    bus.subscribe('bus:ORDER_APPROVAL_REJECTED', (d) => rejectedEvents.push(d))
    bus.subscribe('bus:ACTION_COMPLETED', (d) => actionEvents.push(d))

    await publishPendingApproval(bus, { draft_id: 'draft_F', intent_id: 'order_create' })
    await wait(5)
    await queue.reject('draft_F', 'Insufficient stock')

    const record = queue.getRecord('draft_F')
    expect(record!.status).toBe('rejected')
    expect(record!.rejection_reason).toBe('Insufficient stock')

    expect(rejectedEvents.length).toBe(1)
    expect(actionEvents.length).toBe(1)
    const action = actionEvents[0] as Record<string, unknown>
    const result = action.result as Record<string, unknown>
    expect(result.approved).toBe(false)
    expect(result.text).toContain('not approved')
  })

  // ── Timeout ───────────────────────────────────────────────────────────

  it('auto-times out after approval_timeout_ms and publishes ORDER_APPROVAL_TIMEOUT', async () => {
    const timeoutEvents: unknown[] = []
    const actionEvents: unknown[] = []
    bus.subscribe('bus:ORDER_APPROVAL_TIMEOUT', (d) => timeoutEvents.push(d))
    bus.subscribe('bus:ACTION_COMPLETED', (d) => actionEvents.push(d))

    await publishPendingApproval(bus, {
      draft_id: 'draft_G',
      approval_timeout_ms: 50, // very short for tests
    })
    await wait(5)

    expect(queue.getRecord('draft_G')!.status).toBe('pending')

    await wait(100) // wait past timeout

    expect(queue.getRecord('draft_G')!.status).toBe('timed_out')
    expect(timeoutEvents.length).toBe(1)
    expect(actionEvents.length).toBe(1)
    const action = actionEvents[0] as Record<string, unknown>
    const result = action.result as Record<string, unknown>
    expect(result.timed_out).toBe(true)
  })

  // ── Error cases ───────────────────────────────────────────────────────

  it('approve() throws ApprovalNotFoundError for unknown draft_id', async () => {
    await expect(queue.approve('nonexistent', 'someone')).rejects.toThrow(ApprovalNotFoundError)
  })

  it('approve() throws ApprovalAlreadyResolvedError on double-approve', async () => {
    await publishPendingApproval(bus, { draft_id: 'draft_H' })
    await wait(5)

    await queue.approve('draft_H', 'first_approver')
    await expect(queue.approve('draft_H', 'second_approver')).rejects.toThrow(
      ApprovalAlreadyResolvedError,
    )
  })

  // ── Refund text ───────────────────────────────────────────────────────

  it('approve() uses refund-specific confirmation text for refund_create', async () => {
    const events: unknown[] = []
    bus.subscribe('bus:ACTION_COMPLETED', (d) => events.push(d))

    await publishPendingApproval(bus, {
      draft_id: 'draft_I',
      intent_id: 'refund_create',
      draft_total: 29.99,
      original_order_id: 'ORD-888',
    })
    await wait(5)
    await queue.approve('draft_I', 'manager_dave')

    const result = (events[0] as Record<string, unknown>).result as Record<string, unknown>
    expect(result.text).toContain('refund')
    expect(result.text).toContain('29.99')
  })
})
