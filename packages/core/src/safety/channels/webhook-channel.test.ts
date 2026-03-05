import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest'
import { InMemoryBus } from '../../bus/in-memory-bus.js'
import { WebhookApprovalChannel } from './webhook-channel.js'
import type { IEventBus } from '../../types/index.js'
import type { ApprovalRequest, HumanProfile } from './types.js'

function makeRequest(overrides?: Partial<ApprovalRequest>): ApprovalRequest {
  return {
    id: 'req_001',
    draft_id: 'draft_001',
    action: 'refund_create',
    amount: 15_000,
    session_id: 'session-1',
    required_role: 'manager',
    context: {},
    timeout_ms: 90_000,
    ...overrides,
  }
}

function makeApprover(): HumanProfile {
  return {
    id: 'emp_carlos',
    name: 'Don Carlos',
    role: 'manager',
    store_id: 'store_001',
    approval_limits: {},
  }
}

describe('WebhookApprovalChannel', () => {
  let bus: IEventBus
  let channel: WebhookApprovalChannel

  beforeEach(() => {
    vi.useFakeTimers()
    bus = new InMemoryBus()
    channel = new WebhookApprovalChannel({ bus })
  })

  afterEach(() => {
    vi.useRealTimers()
  })

  describe('notify()', () => {
    it('publishes APPROVAL_WEBHOOK_REQUEST', async () => {
      const events: unknown[] = []
      bus.subscribe('bus:APPROVAL_WEBHOOK_REQUEST', (data) => events.push(data))

      await channel.notify(makeRequest(), makeApprover())

      expect(events).toHaveLength(1)
      expect(events[0]).toMatchObject({
        event: 'APPROVAL_WEBHOOK_REQUEST',
        request_id: 'req_001',
        draft_id: 'draft_001',
        required_role: 'manager',
        amount: 15_000,
      })
    })
  })

  describe('waitForResponse()', () => {
    it('resolves when matching APPROVAL_WEBHOOK_RESPONSE arrives', async () => {
      const request = makeRequest()
      const promise = channel.waitForResponse(request, 90_000)

      await bus.publish('bus:APPROVAL_WEBHOOK_RESPONSE', {
        request_id: 'req_001',
        approved: true,
        approver_id: 'emp_carlos',
      })

      const result = await promise
      expect(result).not.toBeNull()
      expect(result!.approved).toBe(true)
      expect(result!.channel_used).toBe('webhook')
    })

    it('ignores responses with different request_id', async () => {
      const request = makeRequest()
      const promise = channel.waitForResponse(request, 5_000)

      await bus.publish('bus:APPROVAL_WEBHOOK_RESPONSE', {
        request_id: 'different_req',
        approved: true,
        approver_id: 'emp_carlos',
      })

      vi.advanceTimersByTime(5_000)
      const result = await promise
      expect(result).toBeNull()
    })

    it('returns null on timeout', async () => {
      const request = makeRequest()
      const promise = channel.waitForResponse(request, 5_000)

      vi.advanceTimersByTime(5_000)
      const result = await promise
      expect(result).toBeNull()
    })

    it('includes rejection reason', async () => {
      const request = makeRequest()
      const promise = channel.waitForResponse(request, 90_000)

      await bus.publish('bus:APPROVAL_WEBHOOK_RESPONSE', {
        request_id: 'req_001',
        approved: false,
        approver_id: 'emp_carlos',
        reason: 'monto incorrecto',
      })

      const result = await promise
      expect(result!.approved).toBe(false)
      expect(result!.reason).toBe('monto incorrecto')
    })
  })

  describe('cancel()', () => {
    it('resolves with null when cancelled', async () => {
      const request = makeRequest()
      const promise = channel.waitForResponse(request, 90_000)

      channel.cancel(request.id)

      const result = await promise
      expect(result).toBeNull()
    })
  })
})
