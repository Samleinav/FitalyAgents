import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest'
import { InMemoryBus } from '../../bus/in-memory-bus.js'
import { ExternalToolChannel } from './external-tool-channel.js'
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
    timeout_ms: 60_000,
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

describe('ExternalToolChannel', () => {
  let bus: IEventBus
  let channel: ExternalToolChannel
  let mockFetch: ReturnType<typeof vi.fn>

  beforeEach(() => {
    vi.useFakeTimers()
    bus = new InMemoryBus()
    mockFetch = vi.fn().mockResolvedValue({ ok: true })
    channel = new ExternalToolChannel({
      bus,
      config: {
        url: 'https://example.com/api/approval',
        method: 'POST',
        auth: 'Bearer SECRET_TOKEN',
      },
      fetchFn: mockFetch as typeof globalThis.fetch,
    })
  })

  afterEach(() => {
    vi.useRealTimers()
  })

  describe('notify()', () => {
    it('calls HTTP endpoint with correct payload', async () => {
      const request = makeRequest()
      await channel.notify(request, makeApprover())

      expect(mockFetch).toHaveBeenCalledOnce()
      expect(mockFetch).toHaveBeenCalledWith(
        'https://example.com/api/approval',
        expect.objectContaining({
          method: 'POST',
          headers: expect.objectContaining({
            'Content-Type': 'application/json',
            Authorization: 'Bearer SECRET_TOKEN',
          }),
        }),
      )

      const body = JSON.parse(mockFetch.mock.calls[0][1].body)
      expect(body).toMatchObject({
        request_id: 'req_001',
        draft_id: 'draft_001',
        action: 'refund_create',
        amount: 15_000,
      })
    })

    it('publishes bus:APPROVAL_EXTERNAL_REQUEST', async () => {
      const events: unknown[] = []
      bus.subscribe('bus:APPROVAL_EXTERNAL_REQUEST', (data) => events.push(data))

      await channel.notify(makeRequest(), makeApprover())

      expect(events).toHaveLength(1)
      expect(events[0]).toMatchObject({
        event: 'APPROVAL_EXTERNAL_REQUEST',
        request_id: 'req_001',
      })
    })
  })

  describe('waitForResponse()', () => {
    it('resolves when matching APPROVAL_EXTERNAL_RESPONSE arrives', async () => {
      const request = makeRequest()
      const promise = channel.waitForResponse(request, 60_000)

      await bus.publish('bus:APPROVAL_EXTERNAL_RESPONSE', {
        request_id: 'req_001',
        approved: true,
        approver_id: 'ext_user_123',
      })

      const result = await promise
      expect(result).not.toBeNull()
      expect(result!.approved).toBe(true)
      expect(result!.approver_id).toBe('ext_user_123')
      expect(result!.channel_used).toBe('external_tool')
    })

    it('ignores responses with different request_id', async () => {
      const request = makeRequest()
      const promise = channel.waitForResponse(request, 5_000)

      await bus.publish('bus:APPROVAL_EXTERNAL_RESPONSE', {
        request_id: 'different_req',
        approved: true,
        approver_id: 'ext_user_123',
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
  })

  describe('cancel()', () => {
    it('resolves with null when cancelled', async () => {
      const request = makeRequest()
      const promise = channel.waitForResponse(request, 60_000)

      channel.cancel(request.id)

      const result = await promise
      expect(result).toBeNull()
    })
  })
})
