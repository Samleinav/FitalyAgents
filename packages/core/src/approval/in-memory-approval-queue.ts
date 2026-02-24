import type { Unsubscribe } from '../types/index.js'
import type {
    IApprovalQueue,
    ApprovalRecord,
    ApprovalQueueDeps,
} from './types.js'
import {
    ApprovalNotFoundError,
    ApprovalAlreadyResolvedError,
} from './types.js'

/**
 * In-memory ApprovalQueue.
 *
 * Mediates human approval for orders and refunds. Listens for
 * `bus:ORDER_PENDING_APPROVAL` events, stores pending approvals,
 * and publishes outcomes when a webhook calls `approve()` or `reject()`.
 *
 * In production, replace with a Redis-backed implementation that survives
 * restarts — this version is suitable for tests and single-process setups.
 *
 * @example
 * ```typescript
 * const queue = new InMemoryApprovalQueue({ bus, defaultTimeoutMs: 30_000 })
 * const unsub = queue.start()
 *
 * // Later, from a webhook handler:
 * await queue.approve('draft_1', 'manager_alice')
 * // → publishes bus:ORDER_APPROVED + bus:ACTION_COMPLETED
 * ```
 */
export class InMemoryApprovalQueue implements IApprovalQueue {
    private readonly bus: ApprovalQueueDeps['bus']
    private readonly defaultTimeoutMs: number
    private records: Map<string, ApprovalRecord> = new Map()
    private timers: Map<string, ReturnType<typeof setTimeout>> = new Map()
    private unsubs: Unsubscribe[] = []

    constructor(deps: ApprovalQueueDeps) {
        this.bus = deps.bus
        this.defaultTimeoutMs = deps.defaultTimeoutMs ?? 300_000
    }

    // ── Lifecycle ─────────────────────────────────────────────────────────

    start(): Unsubscribe {
        const unsub = this.bus.subscribe('bus:ORDER_PENDING_APPROVAL', (data) => {
            const event = data as {
                submission_id: string
                draft_id: string
                intent_id: string
                session_id: string
                task_id: string
                draft_total?: number
                original_order_id?: string
                approval_timeout_ms?: number
            }
            this.handlePendingApproval(event)
        })
        this.unsubs.push(unsub)
        return () => this.dispose()
    }

    dispose(): void {
        for (const unsub of this.unsubs) unsub()
        this.unsubs = []
        for (const timer of this.timers.values()) clearTimeout(timer)
        this.timers.clear()
        this.records.clear()
    }

    // ── Approval operations ───────────────────────────────────────────────

    async approve(draftId: string, approverId: string): Promise<void> {
        const record = this.records.get(draftId)
        if (!record) throw new ApprovalNotFoundError(draftId)
        if (record.status !== 'pending') throw new ApprovalAlreadyResolvedError(draftId, record.status)

        this.clearTimer(draftId)
        record.status = 'approved'
        record.approved_by = approverId
        record.resolved_at = Date.now()

        await this.bus.publish('bus:ORDER_APPROVED', {
            event: 'ORDER_APPROVED',
            submission_id: record.submission_id,
            draft_id: draftId,
            intent_id: record.intent_id,
            session_id: record.session_id,
            task_id: record.task_id,
            approved_by: approverId,
            draft_total: record.draft_total,
            original_order_id: record.original_order_id,
            timestamp: Date.now(),
        })

        await this.bus.publish('bus:ACTION_COMPLETED', {
            event: 'ACTION_COMPLETED',
            task_id: record.task_id,
            session_id: record.session_id,
            intent_id: record.intent_id,
            agent_id: 'approval-queue',
            result: {
                approved: true,
                draft_id: draftId,
                approved_by: approverId,
                draft_total: record.draft_total,
                text: record.intent_id === 'refund_create'
                    ? `Your refund of $${record.draft_total?.toFixed(2) ?? '0.00'} has been approved.`
                    : `Your order has been confirmed! Total: $${record.draft_total?.toFixed(2) ?? '0.00'}.`,
            },
            timestamp: Date.now(),
        })
    }

    async reject(draftId: string, reason: string): Promise<void> {
        const record = this.records.get(draftId)
        if (!record) throw new ApprovalNotFoundError(draftId)
        if (record.status !== 'pending') throw new ApprovalAlreadyResolvedError(draftId, record.status)

        this.clearTimer(draftId)
        record.status = 'rejected'
        record.rejection_reason = reason
        record.resolved_at = Date.now()

        await this.bus.publish('bus:ORDER_APPROVAL_REJECTED', {
            event: 'ORDER_APPROVAL_REJECTED',
            submission_id: record.submission_id,
            draft_id: draftId,
            intent_id: record.intent_id,
            session_id: record.session_id,
            task_id: record.task_id,
            reason,
            timestamp: Date.now(),
        })

        await this.bus.publish('bus:ACTION_COMPLETED', {
            event: 'ACTION_COMPLETED',
            task_id: record.task_id,
            session_id: record.session_id,
            intent_id: record.intent_id,
            agent_id: 'approval-queue',
            result: {
                approved: false,
                draft_id: draftId,
                reason,
                text: `Sorry, your ${record.intent_id === 'refund_create' ? 'refund' : 'order'} was not approved. ${reason}`,
            },
            timestamp: Date.now(),
        })
    }

    // ── Queries ───────────────────────────────────────────────────────────

    getPending(): ApprovalRecord[] {
        return [...this.records.values()].filter((r) => r.status === 'pending')
    }

    getRecord(draftId: string): ApprovalRecord | null {
        return this.records.get(draftId) ?? null
    }

    // ── Private ───────────────────────────────────────────────────────────

    private handlePendingApproval(event: {
        submission_id: string
        draft_id: string
        intent_id: string
        session_id: string
        task_id: string
        draft_total?: number
        original_order_id?: string
        approval_timeout_ms?: number
    }): void {
        const timeoutMs = event.approval_timeout_ms ?? this.defaultTimeoutMs

        const record: ApprovalRecord = {
            submission_id: event.submission_id,
            draft_id: event.draft_id,
            intent_id: event.intent_id,
            session_id: event.session_id,
            task_id: event.task_id,
            status: 'pending',
            draft_total: event.draft_total,
            original_order_id: event.original_order_id,
            approval_timeout_ms: timeoutMs,
            created_at: Date.now(),
        }

        this.records.set(event.draft_id, record)

        // Start auto-timeout timer
        const timer = setTimeout(() => {
            void this.handleTimeout(event.draft_id)
        }, timeoutMs)

        this.timers.set(event.draft_id, timer)
    }

    private async handleTimeout(draftId: string): Promise<void> {
        const record = this.records.get(draftId)
        if (!record || record.status !== 'pending') return

        record.status = 'timed_out'
        record.resolved_at = Date.now()
        this.timers.delete(draftId)

        await this.bus.publish('bus:ORDER_APPROVAL_TIMEOUT', {
            event: 'ORDER_APPROVAL_TIMEOUT',
            draft_id: draftId,
            intent_id: record.intent_id,
            session_id: record.session_id,
            task_id: record.task_id,
            timestamp: Date.now(),
        })

        await this.bus.publish('bus:ACTION_COMPLETED', {
            event: 'ACTION_COMPLETED',
            task_id: record.task_id,
            session_id: record.session_id,
            intent_id: record.intent_id,
            agent_id: 'approval-queue',
            result: {
                approved: false,
                draft_id: draftId,
                timed_out: true,
                text: `Your ${record.intent_id === 'refund_create' ? 'refund' : 'order'} request expired without a response. Please try again.`,
            },
            timestamp: Date.now(),
        })
    }

    private clearTimer(draftId: string): void {
        const timer = this.timers.get(draftId)
        if (timer) {
            clearTimeout(timer)
            this.timers.delete(draftId)
        }
    }
}
