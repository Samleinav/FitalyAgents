import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest'
import { InMemoryBus } from '../bus/in-memory-bus.js'
import { InMemoryPresenceManager } from '../presence/in-memory-presence-manager.js'
import { ApprovalOrchestrator } from './approval-orchestrator.js'
import type { IEventBus } from '../types/index.js'
import type {
  IApprovalChannel,
  ApprovalRequest,
  ApprovalResponse,
  HumanProfile,
} from './channels/types.js'

// ── Mock channel factory ──────────────────────────────────────────────────────

function createMockChannel(
  type: string,
  response: ApprovalResponse | null,
  delay: number,
): IApprovalChannel {
  const cancelFn = vi.fn()
  return {
    id: type,
    type: type as 'voice' | 'webhook' | 'external_tool',
    notify: vi.fn().mockResolvedValue(undefined),
    waitForResponse: vi.fn().mockImplementation(
      () =>
        new Promise<ApprovalResponse | null>((resolve) => {
          if (delay === 0) {
            resolve(response)
          } else {
            setTimeout(() => resolve(response), delay)
          }
        }),
    ),
    cancel: cancelFn,
  }
}

function createQuorumChannel(
  type: string,
  responses: Record<string, { approved: boolean | null; delay: number }>,
): IApprovalChannel {
  return {
    id: type,
    type: type as 'voice' | 'webhook' | 'external_tool',
    notify: vi.fn().mockResolvedValue(undefined),
    waitForResponse: vi.fn().mockImplementation(
      (request: ApprovalRequest) =>
        new Promise<ApprovalResponse | null>((resolve) => {
          const approverId = request.context.quorum_approver_id as string
          const configured = responses[approverId]
          const finish = () => {
            if (!configured || configured.approved === null) {
              resolve(null)
              return
            }

            resolve({
              approved: configured.approved,
              approver_id: approverId,
              channel_used: type,
              timestamp: Date.now(),
            })
          }

          if (!configured || configured.delay === 0) {
            finish()
          } else {
            setTimeout(finish, configured.delay)
          }
        }),
    ),
    cancel: vi.fn(),
  }
}

function makeRequest(overrides?: Partial<ApprovalRequest>): ApprovalRequest {
  return {
    id: 'req_001',
    draft_id: 'draft_001',
    action: 'refund_create',
    amount: 15_000,
    session_id: 'session-1',
    required_role: 'manager',
    context: {},
    timeout_ms: 120_000,
    ...overrides,
  }
}

function addPresentManager(
  presenceManager: InMemoryPresenceManager,
  id: string,
  storeId = 'store_001',
): void {
  presenceManager.update(
    {
      id,
      name: id,
      role: 'manager',
      store_id: storeId,
      approval_limits: { refund_max: 100_000 },
    },
    'available',
    storeId,
  )
}

function makeApprover(): HumanProfile {
  return {
    id: 'emp_carlos',
    name: 'Don Carlos',
    role: 'manager',
    store_id: 'store_001',
    approval_limits: { refund_max: 100_000 },
  }
}

describe('ApprovalOrchestrator', () => {
  let bus: IEventBus

  beforeEach(() => {
    vi.useFakeTimers()
    bus = new InMemoryBus()
  })

  afterEach(() => {
    vi.useRealTimers()
  })

  // ── parallel strategy ──────────────────────────────────────────────

  describe('parallel strategy', () => {
    it('first channel to respond wins, others are cancelled', async () => {
      // Voice responds immediately, webhook never responds
      const voiceChannel = createMockChannel(
        'voice',
        {
          approved: true,
          approver_id: 'emp_carlos',
          channel_used: 'voice',
          timestamp: Date.now(),
        },
        0,
      )

      const webhookChannel = createMockChannel('webhook', null, 0)

      const orchestrator = new ApprovalOrchestrator({
        bus,
        channelRegistry: new Map([
          ['voice', voiceChannel],
          ['webhook', webhookChannel],
        ]),
      })

      const result = await orchestrator.orchestrate(
        makeRequest(),
        [
          { type: 'voice', timeout_ms: 15_000 },
          { type: 'webhook', timeout_ms: 90_000 },
        ],
        'parallel',
        makeApprover(),
      )

      expect(result).not.toBeNull()
      expect(result!.approved).toBe(true)
      expect(result!.channel_used).toBe('voice')

      // Both channels should be cancelled (winner too, for cleanup)
      expect(voiceChannel.cancel).toHaveBeenCalled()
      expect(webhookChannel.cancel).toHaveBeenCalled()

      orchestrator.dispose()
    })

    it('publishes APPROVAL_RESOLVED on success', async () => {
      const events: unknown[] = []
      bus.subscribe('bus:APPROVAL_RESOLVED', (data) => events.push(data))

      const voiceChannel = createMockChannel(
        'voice',
        {
          approved: true,
          approver_id: 'emp_carlos',
          channel_used: 'voice',
          timestamp: Date.now(),
        },
        0,
      )

      const orchestrator = new ApprovalOrchestrator({
        bus,
        channelRegistry: new Map([['voice', voiceChannel]]),
      })

      await orchestrator.orchestrate(
        makeRequest(),
        [{ type: 'voice', timeout_ms: 15_000 }],
        'parallel',
        makeApprover(),
      )

      expect(events).toHaveLength(1)
      expect(events[0]).toMatchObject({
        event: 'APPROVAL_RESOLVED',
        session_id: 'session-1',
        approved: true,
        channel_used: 'voice',
      })

      orchestrator.dispose()
    })

    it('publishes ORDER_APPROVED when approved', async () => {
      const events: unknown[] = []
      bus.subscribe('bus:ORDER_APPROVED', (data) => events.push(data))

      const voiceChannel = createMockChannel(
        'voice',
        {
          approved: true,
          approver_id: 'emp_carlos',
          channel_used: 'voice',
          timestamp: Date.now(),
        },
        0,
      )

      const orchestrator = new ApprovalOrchestrator({
        bus,
        channelRegistry: new Map([['voice', voiceChannel]]),
      })

      await orchestrator.orchestrate(
        makeRequest(),
        [{ type: 'voice', timeout_ms: 15_000 }],
        'parallel',
        makeApprover(),
      )

      expect(events).toHaveLength(1)
      expect(events[0]).toMatchObject({
        event: 'ORDER_APPROVED',
        draft_id: 'draft_001',
        approved_by: 'emp_carlos',
      })

      orchestrator.dispose()
    })

    it('publishes ORDER_APPROVAL_TIMEOUT when all channels timeout', async () => {
      const events: unknown[] = []
      bus.subscribe('bus:ORDER_APPROVAL_TIMEOUT', (data) => events.push(data))

      // Both channels return null (simulating timeout)
      const voiceChannel = createMockChannel('voice', null, 0)
      const webhookChannel = createMockChannel('webhook', null, 0)

      const orchestrator = new ApprovalOrchestrator({
        bus,
        channelRegistry: new Map([
          ['voice', voiceChannel],
          ['webhook', webhookChannel],
        ]),
      })

      const result = await orchestrator.orchestrate(
        makeRequest(),
        [
          { type: 'voice', timeout_ms: 15_000 },
          { type: 'webhook', timeout_ms: 90_000 },
        ],
        'parallel',
        makeApprover(),
      )

      expect(result).toBeNull()
      expect(events).toHaveLength(1)
      expect(events[0]).toMatchObject({
        event: 'ORDER_APPROVAL_TIMEOUT',
        draft_id: 'draft_001',
      })

      orchestrator.dispose()
    })

    it('waits for a later approval instead of letting the first timeout win', async () => {
      const voiceChannel = createMockChannel('voice', null, 10)
      const webhookChannel = createMockChannel(
        'webhook',
        {
          approved: true,
          approver_id: 'emp_maria',
          channel_used: 'webhook',
          timestamp: Date.now(),
        },
        20,
      )

      const orchestrator = new ApprovalOrchestrator({
        bus,
        channelRegistry: new Map([
          ['voice', voiceChannel],
          ['webhook', webhookChannel],
        ]),
      })

      const resultPromise = orchestrator.orchestrate(
        makeRequest(),
        [
          { type: 'voice', timeout_ms: 15_000 },
          { type: 'webhook', timeout_ms: 90_000 },
        ],
        'parallel',
        makeApprover(),
      )

      await vi.advanceTimersByTimeAsync(10)
      await vi.advanceTimersByTimeAsync(10)

      await expect(resultPromise).resolves.toMatchObject({
        approved: true,
        channel_used: 'webhook',
      })

      orchestrator.dispose()
    })

    it('treats a channel wait failure as a timeout and keeps other channels alive', async () => {
      const voiceChannel: IApprovalChannel = {
        id: 'voice',
        type: 'voice',
        notify: vi.fn().mockResolvedValue(undefined),
        waitForResponse: vi.fn(() => {
          throw new Error('voice channel failed')
        }),
        cancel: vi.fn(),
      }
      const webhookChannel = createMockChannel(
        'webhook',
        {
          approved: true,
          approver_id: 'emp_maria',
          channel_used: 'webhook',
          timestamp: Date.now(),
        },
        0,
      )

      const orchestrator = new ApprovalOrchestrator({
        bus,
        channelRegistry: new Map([
          ['voice', voiceChannel],
          ['webhook', webhookChannel],
        ]),
      })

      const result = await orchestrator.orchestrate(
        makeRequest(),
        [
          { type: 'voice', timeout_ms: 15_000 },
          { type: 'webhook', timeout_ms: 90_000 },
        ],
        'parallel',
        makeApprover(),
      )

      expect(result).toMatchObject({
        approved: true,
        channel_used: 'webhook',
      })

      orchestrator.dispose()
    })

    it('treats a channel notify failure as a timeout and keeps other channels alive', async () => {
      const voiceChannel: IApprovalChannel = {
        id: 'voice',
        type: 'voice',
        notify: vi.fn().mockRejectedValue(new Error('voice notify failed')),
        waitForResponse: vi.fn().mockResolvedValue(null),
        cancel: vi.fn(),
      }
      const webhookChannel = createMockChannel(
        'webhook',
        {
          approved: true,
          approver_id: 'emp_maria',
          channel_used: 'webhook',
          timestamp: Date.now(),
        },
        0,
      )

      const orchestrator = new ApprovalOrchestrator({
        bus,
        channelRegistry: new Map([
          ['voice', voiceChannel],
          ['webhook', webhookChannel],
        ]),
      })

      const result = await orchestrator.orchestrate(
        makeRequest(),
        [
          { type: 'voice', timeout_ms: 15_000 },
          { type: 'webhook', timeout_ms: 90_000 },
        ],
        'parallel',
        makeApprover(),
      )

      expect(result).toMatchObject({
        approved: true,
        channel_used: 'webhook',
      })
      expect(voiceChannel.cancel).toHaveBeenCalledWith('req_001')

      orchestrator.dispose()
    })
  })

  // ── sequential strategy ────────────────────────────────────────────

  describe('sequential strategy', () => {
    it('tries channels in order, uses first responder', async () => {
      const voiceChannel = createMockChannel('voice', null, 0) // timeout (returns null)
      const webhookChannel = createMockChannel(
        'webhook',
        {
          approved: true,
          approver_id: 'emp_maria',
          channel_used: 'webhook',
          timestamp: Date.now(),
        },
        0,
      )

      const orchestrator = new ApprovalOrchestrator({
        bus,
        channelRegistry: new Map([
          ['voice', voiceChannel],
          ['webhook', webhookChannel],
        ]),
      })

      const result = await orchestrator.orchestrate(
        makeRequest(),
        [
          { type: 'voice', timeout_ms: 15_000 },
          { type: 'webhook', timeout_ms: 90_000 },
        ],
        'sequential',
        makeApprover(),
      )

      expect(result).not.toBeNull()
      expect(result!.channel_used).toBe('webhook')

      // Voice should have been notified first
      expect(voiceChannel.notify).toHaveBeenCalledOnce()
      expect(webhookChannel.notify).toHaveBeenCalledOnce()

      orchestrator.dispose()
    })

    it('returns null if all channels timeout', async () => {
      const events: unknown[] = []
      bus.subscribe('bus:ORDER_APPROVAL_TIMEOUT', (data) => events.push(data))

      const voiceChannel = createMockChannel('voice', null, 0)
      const webhookChannel = createMockChannel('webhook', null, 0)

      const orchestrator = new ApprovalOrchestrator({
        bus,
        channelRegistry: new Map([
          ['voice', voiceChannel],
          ['webhook', webhookChannel],
        ]),
      })

      const result = await orchestrator.orchestrate(
        makeRequest(),
        [
          { type: 'voice', timeout_ms: 15_000 },
          { type: 'webhook', timeout_ms: 90_000 },
        ],
        'sequential',
        makeApprover(),
      )

      expect(result).toBeNull()
      expect(events).toHaveLength(1)

      orchestrator.dispose()
    })

    it('treats a channel wait failure as a timeout before trying the next channel', async () => {
      const voiceChannel: IApprovalChannel = {
        id: 'voice',
        type: 'voice',
        notify: vi.fn().mockResolvedValue(undefined),
        waitForResponse: vi.fn(() => {
          throw new Error('voice channel failed')
        }),
        cancel: vi.fn(),
      }
      const webhookChannel = createMockChannel(
        'webhook',
        {
          approved: true,
          approver_id: 'emp_maria',
          channel_used: 'webhook',
          timestamp: Date.now(),
        },
        0,
      )

      const orchestrator = new ApprovalOrchestrator({
        bus,
        channelRegistry: new Map([
          ['voice', voiceChannel],
          ['webhook', webhookChannel],
        ]),
      })

      const result = await orchestrator.orchestrate(
        makeRequest(),
        [
          { type: 'voice', timeout_ms: 15_000 },
          { type: 'webhook', timeout_ms: 90_000 },
        ],
        'sequential',
        makeApprover(),
      )

      expect(result).toMatchObject({
        approved: true,
        channel_used: 'webhook',
      })
      expect(voiceChannel.cancel).toHaveBeenCalledWith('req_001')

      orchestrator.dispose()
    })
  })

  // ── quorum strategy ─────────────────────────────────────────────

  describe('quorum strategy', () => {
    it('resolves when the required number of distinct approvers approve', async () => {
      const events: unknown[] = []
      bus.subscribe('bus:APPROVAL_RESOLVED', (data) => events.push(data))

      const presenceManager = new InMemoryPresenceManager()
      addPresentManager(presenceManager, 'manager_ana')
      addPresentManager(presenceManager, 'manager_ben')
      addPresentManager(presenceManager, 'manager_cora')

      const webhookChannel = createQuorumChannel('webhook', {
        manager_ana: { approved: true, delay: 5 },
        manager_ben: { approved: true, delay: 10 },
        manager_cora: { approved: true, delay: 30 },
      })

      const orchestrator = new ApprovalOrchestrator({
        bus,
        channelRegistry: new Map([['webhook', webhookChannel]]),
        presenceManager,
      })

      const resultPromise = orchestrator.orchestrate(
        makeRequest({
          context: { store_id: 'store_001' },
          quorum: {
            required: 2,
            eligible_roles: ['manager', 'owner'],
          },
        }),
        [{ type: 'webhook', timeout_ms: 60_000 }],
        'quorum',
        makeApprover(),
      )

      await vi.advanceTimersByTimeAsync(10)

      await expect(resultPromise).resolves.toMatchObject({
        approved: true,
        approver_id: 'manager_ana',
        approvers: ['manager_ana', 'manager_ben'],
      })
      expect(events).toHaveLength(1)
      expect(events[0]).toMatchObject({
        event: 'APPROVAL_RESOLVED',
        session_id: 'session-1',
        approved: true,
        approvers: ['manager_ana', 'manager_ben'],
        strategy: 'quorum',
      })
      expect(webhookChannel.notify).toHaveBeenCalledTimes(3)
      expect(webhookChannel.cancel).toHaveBeenCalled()
      expect(presenceManager.getStatus('manager_ana')).toBe('available')

      orchestrator.dispose()
    })

    it('rejects immediately when any approver rejects by default', async () => {
      const resolvedEvents: unknown[] = []
      const approvedEvents: unknown[] = []
      bus.subscribe('bus:APPROVAL_RESOLVED', (data) => resolvedEvents.push(data))
      bus.subscribe('bus:ORDER_APPROVED', (data) => approvedEvents.push(data))

      const presenceManager = new InMemoryPresenceManager()
      addPresentManager(presenceManager, 'manager_ana')
      addPresentManager(presenceManager, 'manager_ben')
      addPresentManager(presenceManager, 'manager_cora')

      const webhookChannel = createQuorumChannel('webhook', {
        manager_ana: { approved: true, delay: 5 },
        manager_ben: { approved: false, delay: 10 },
        manager_cora: { approved: true, delay: 30 },
      })

      const orchestrator = new ApprovalOrchestrator({
        bus,
        channelRegistry: new Map([['webhook', webhookChannel]]),
        presenceManager,
      })

      const resultPromise = orchestrator.orchestrate(
        makeRequest({
          context: { store_id: 'store_001' },
          quorum: {
            required: 2,
            eligible_roles: ['manager'],
          },
        }),
        [{ type: 'webhook', timeout_ms: 60_000 }],
        'quorum',
        makeApprover(),
      )

      await vi.advanceTimersByTimeAsync(10)

      await expect(resultPromise).resolves.toMatchObject({
        approved: false,
        approver_id: 'manager_ben',
      })
      expect(resolvedEvents[0]).toMatchObject({
        event: 'APPROVAL_RESOLVED',
        approved: false,
        approver_id: 'manager_ben',
        strategy: 'quorum',
      })
      expect(approvedEvents).toHaveLength(0)

      orchestrator.dispose()
    })

    it('continues after a rejection when reject_on_any_no is false', async () => {
      const approvedEvents: unknown[] = []
      bus.subscribe('bus:ORDER_APPROVED', (data) => approvedEvents.push(data))

      const presenceManager = new InMemoryPresenceManager()
      addPresentManager(presenceManager, 'manager_ana')
      addPresentManager(presenceManager, 'manager_ben')
      addPresentManager(presenceManager, 'manager_cora')

      const webhookChannel = createQuorumChannel('webhook', {
        manager_ana: { approved: true, delay: 5 },
        manager_ben: { approved: false, delay: 10 },
        manager_cora: { approved: true, delay: 15 },
      })

      const orchestrator = new ApprovalOrchestrator({
        bus,
        channelRegistry: new Map([['webhook', webhookChannel]]),
        presenceManager,
      })

      const resultPromise = orchestrator.orchestrate(
        makeRequest({
          context: { store_id: 'store_001' },
          quorum: {
            required: 2,
            eligible_roles: ['manager'],
            reject_on_any_no: false,
          },
        }),
        [{ type: 'webhook', timeout_ms: 60_000 }],
        'quorum',
        makeApprover(),
      )

      await vi.advanceTimersByTimeAsync(15)

      await expect(resultPromise).resolves.toMatchObject({
        approved: true,
        approvers: ['manager_ana', 'manager_cora'],
      })
      expect(approvedEvents[0]).toMatchObject({
        event: 'ORDER_APPROVED',
        approvers: ['manager_ana', 'manager_cora'],
        strategy: 'quorum',
      })

      orchestrator.dispose()
    })

    it('ignores quorum responses from the wrong approver', async () => {
      const timeoutEvents: unknown[] = []
      bus.subscribe('bus:ORDER_APPROVAL_TIMEOUT', (data) => timeoutEvents.push(data))

      const presenceManager = new InMemoryPresenceManager()
      addPresentManager(presenceManager, 'manager_ana')
      addPresentManager(presenceManager, 'manager_ben')

      const webhookChannel: IApprovalChannel = {
        id: 'webhook',
        type: 'webhook',
        notify: vi.fn().mockResolvedValue(undefined),
        waitForResponse: vi.fn().mockImplementation((request: ApprovalRequest) => {
          const approverId = request.context.quorum_approver_id as string
          return Promise.resolve({
            approved: true,
            approver_id: approverId === 'manager_ben' ? 'manager_ana' : approverId,
            channel_used: 'webhook',
            timestamp: Date.now(),
          })
        }),
        cancel: vi.fn(),
      }

      const orchestrator = new ApprovalOrchestrator({
        bus,
        channelRegistry: new Map([['webhook', webhookChannel]]),
        presenceManager,
      })

      const resultPromise = orchestrator.orchestrate(
        makeRequest({
          context: { store_id: 'store_001' },
          quorum: {
            required: 2,
            eligible_roles: ['manager'],
          },
        }),
        [{ type: 'webhook', timeout_ms: 60_000 }],
        'quorum',
        makeApprover(),
      )

      await expect(resultPromise).resolves.toBeNull()
      expect(timeoutEvents[0]).toMatchObject({
        event: 'ORDER_APPROVAL_TIMEOUT',
        partial_approvals: 1,
        quorum_required: 2,
      })

      orchestrator.dispose()
    })

    it('publishes timeout with partial approval count when quorum is not reached', async () => {
      const timeoutEvents: unknown[] = []
      bus.subscribe('bus:ORDER_APPROVAL_TIMEOUT', (data) => timeoutEvents.push(data))

      const presenceManager = new InMemoryPresenceManager()
      addPresentManager(presenceManager, 'manager_ana')
      addPresentManager(presenceManager, 'manager_ben')
      addPresentManager(presenceManager, 'manager_cora')

      const webhookChannel = createQuorumChannel('webhook', {
        manager_ana: { approved: true, delay: 5 },
        manager_ben: { approved: null, delay: 10 },
        manager_cora: { approved: null, delay: 10 },
      })

      const orchestrator = new ApprovalOrchestrator({
        bus,
        channelRegistry: new Map([['webhook', webhookChannel]]),
        presenceManager,
      })

      const resultPromise = orchestrator.orchestrate(
        makeRequest({
          context: { store_id: 'store_001' },
          quorum: {
            required: 2,
            eligible_roles: ['manager'],
          },
        }),
        [{ type: 'webhook', timeout_ms: 60_000 }],
        'quorum',
        makeApprover(),
      )

      await vi.advanceTimersByTimeAsync(10)

      await expect(resultPromise).resolves.toBeNull()
      expect(timeoutEvents).toHaveLength(1)
      expect(timeoutEvents[0]).toMatchObject({
        event: 'ORDER_APPROVAL_TIMEOUT',
        partial_approvals: 1,
        quorum_required: 2,
      })

      orchestrator.dispose()
    })

    it('queues quorum approvals until enough approvers are present', async () => {
      const queuedEvents: unknown[] = []
      bus.subscribe('bus:ORDER_QUEUED_NO_APPROVER', (data) => queuedEvents.push(data))

      const presenceManager = new InMemoryPresenceManager({ bus })
      presenceManager.start()
      addPresentManager(presenceManager, 'manager_ana')

      const webhookChannel = createQuorumChannel('webhook', {
        manager_ana: { approved: true, delay: 0 },
        manager_ben: { approved: true, delay: 0 },
      })

      const orchestrator = new ApprovalOrchestrator({
        bus,
        channelRegistry: new Map([['webhook', webhookChannel]]),
        presenceManager,
      })
      orchestrator.start()

      const resultPromise = orchestrator.orchestrate(
        makeRequest({
          context: { store_id: 'store_001' },
          quorum: {
            required: 2,
            eligible_roles: ['manager'],
          },
        }),
        [{ type: 'webhook', timeout_ms: 60_000 }],
        'quorum',
        makeApprover(),
      )

      await Promise.resolve()
      await Promise.resolve()

      expect(queuedEvents).toHaveLength(1)
      expect(queuedEvents[0]).toMatchObject({
        event: 'ORDER_QUEUED_NO_APPROVER',
        quorum_required: 2,
        eligible_roles: ['manager'],
      })

      await bus.publish('bus:HUMAN_PRESENCE_CHANGED', {
        event: 'HUMAN_PRESENCE_CHANGED',
        human_id: 'manager_ben',
        name: 'Ben',
        role: 'manager',
        status: 'available',
        store_id: 'store_001',
        approval_limits: { refund_max: 100_000 },
        timestamp: Date.now(),
      })

      await expect(resultPromise).resolves.toMatchObject({
        approved: true,
        approvers: ['manager_ana', 'manager_ben'],
      })

      orchestrator.dispose()
      presenceManager.dispose()
    })
  })

  // ── presence manager ─────────────────────────────────────────────

  describe('presence manager', () => {
    it('routes approval to an available human and marks them free afterwards', async () => {
      const presenceManager = new InMemoryPresenceManager()
      presenceManager.update(
        {
          id: 'manager_ana',
          name: 'Ana',
          role: 'manager',
          store_id: 'store_001',
          approval_limits: { refund_max: 100_000 },
        },
        'available',
        'store_001',
      )

      const voiceChannel = createMockChannel(
        'voice',
        {
          approved: true,
          approver_id: 'manager_ana',
          channel_used: 'voice',
          timestamp: Date.now(),
        },
        0,
      )

      const orchestrator = new ApprovalOrchestrator({
        bus,
        channelRegistry: new Map([['voice', voiceChannel]]),
        presenceManager,
      })

      const result = await orchestrator.orchestrate(
        makeRequest({ context: { store_id: 'store_001' } }),
        [{ type: 'voice', timeout_ms: 15_000 }],
        'parallel',
        makeApprover(),
      )

      expect(result?.approved).toBe(true)
      expect(voiceChannel.notify).toHaveBeenCalledWith(
        expect.objectContaining({ id: 'req_001' }),
        expect.objectContaining({ id: 'manager_ana' }),
      )
      expect(presenceManager.getStatus('manager_ana')).toBe('available')

      orchestrator.dispose()
    })

    it('queues approvals when no required approver is available and drains on presence', async () => {
      const events: unknown[] = []
      bus.subscribe('bus:ORDER_QUEUED_NO_APPROVER', (data) => events.push(data))

      const presenceManager = new InMemoryPresenceManager({ bus })
      presenceManager.start()

      const voiceChannel = createMockChannel(
        'voice',
        {
          approved: true,
          approver_id: 'manager_ana',
          channel_used: 'voice',
          timestamp: Date.now(),
        },
        0,
      )

      const orchestrator = new ApprovalOrchestrator({
        bus,
        channelRegistry: new Map([['voice', voiceChannel]]),
        presenceManager,
      })
      orchestrator.start()

      const resultPromise = orchestrator.orchestrate(
        makeRequest({ context: { store_id: 'store_001' } }),
        [{ type: 'voice', timeout_ms: 15_000 }],
        'parallel',
        makeApprover(),
      )

      await Promise.resolve()
      await Promise.resolve()

      expect(events).toHaveLength(1)
      expect(events[0]).toMatchObject({
        event: 'ORDER_QUEUED_NO_APPROVER',
        request_id: 'req_001',
        required_role: 'manager',
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

      await expect(resultPromise).resolves.toMatchObject({
        approved: true,
        approver_id: 'manager_ana',
      })
      expect(presenceManager.getStatus('manager_ana')).toBe('available')

      orchestrator.dispose()
      presenceManager.dispose()
    })

    it('does not queue a request that has no configured channels', async () => {
      const queuedEvents: unknown[] = []
      const timeoutEvents: unknown[] = []
      bus.subscribe('bus:ORDER_QUEUED_NO_APPROVER', (data) => queuedEvents.push(data))
      bus.subscribe('bus:ORDER_APPROVAL_TIMEOUT', (data) => timeoutEvents.push(data))

      const presenceManager = new InMemoryPresenceManager()
      const orchestrator = new ApprovalOrchestrator({
        bus,
        channelRegistry: new Map(),
        presenceManager,
      })

      const result = await orchestrator.orchestrate(
        makeRequest({ context: { store_id: 'store_001' } }),
        [],
        'parallel',
        makeApprover(),
      )

      expect(result).toBeNull()
      expect(queuedEvents).toHaveLength(0)
      expect(timeoutEvents).toHaveLength(1)

      orchestrator.dispose()
    })
  })

  // ── edge cases ─────────────────────────────────────────────────────

  describe('edge cases', () => {
    it('publishes timeout when no channels configured', async () => {
      const events: unknown[] = []
      bus.subscribe('bus:ORDER_APPROVAL_TIMEOUT', (data) => events.push(data))

      const orchestrator = new ApprovalOrchestrator({
        bus,
        channelRegistry: new Map(),
      })

      const result = await orchestrator.orchestrate(makeRequest(), [], 'parallel', makeApprover())

      expect(result).toBeNull()
      expect(events).toHaveLength(1)

      orchestrator.dispose()
    })

    it('skips unknown channel types gracefully', async () => {
      const voiceChannel = createMockChannel(
        'voice',
        {
          approved: true,
          approver_id: 'emp_carlos',
          channel_used: 'voice',
          timestamp: Date.now(),
        },
        0,
      )

      const orchestrator = new ApprovalOrchestrator({
        bus,
        channelRegistry: new Map([['voice', voiceChannel]]),
      })

      const result = await orchestrator.orchestrate(
        makeRequest(),
        [
          { type: 'external_tool', timeout_ms: 60_000 }, // not in registry
          { type: 'voice', timeout_ms: 15_000 },
        ],
        'sequential',
        makeApprover(),
      )

      expect(result).not.toBeNull()
      expect(result!.channel_used).toBe('voice')

      orchestrator.dispose()
    })
  })
})
