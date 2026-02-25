import type { Unsubscribe, IEventBus } from '../types/index.js'

// ── ApprovalRecord ────────────────────────────────────────────────────────────

export type ApprovalStatus = 'pending' | 'approved' | 'rejected' | 'timed_out'

/**
 * A pending human-approval request stored in the queue.
 */
export interface ApprovalRecord {
  /** Unique ID assigned by the order service on submission */
  submission_id: string
  /** Draft ID (order or refund) to approve/reject */
  draft_id: string
  /** Intent that triggered this approval (order_create | refund_create) */
  intent_id: string
  /** Session that originated the request */
  session_id: string
  /** Task ID from the originating TASK_PAYLOAD */
  task_id: string
  /** Current status of this approval request */
  status: ApprovalStatus
  /** Total amount (for display purposes) */
  draft_total?: number
  /** Original order ID (populated for refunds) */
  original_order_id?: string
  /** Timeout in ms after which the request auto-cancels */
  approval_timeout_ms: number
  /** When this record was created */
  created_at: number
  /** When approved/rejected/timed_out */
  resolved_at?: number
  /** Who approved (approverId from webhook) */
  approved_by?: string
  /** Reason for rejection */
  rejection_reason?: string
}

// ── IApprovalQueue ────────────────────────────────────────────────────────────

/**
 * Interface for the approval queue that mediates human approval for orders/refunds.
 *
 * Flow:
 * ```
 * bus:ORDER_PENDING_APPROVAL
 *   → start() subscriber stores record + starts timeout timer
 *
 * Webhook POST /webhook/approval { action: 'approve', draft_id, approver_id }
 *   → approve(draftId, approverId)
 *   → publishes bus:ORDER_APPROVED + bus:ACTION_COMPLETED
 *
 * Webhook POST /webhook/approval { action: 'reject', draft_id, reason }
 *   → reject(draftId, reason)
 *   → publishes bus:ORDER_APPROVAL_REJECTED + bus:ACTION_COMPLETED
 *
 * Timeout expires (approval_timeout_ms)
 *   → publishes bus:ORDER_APPROVAL_TIMEOUT + bus:ACTION_COMPLETED
 * ```
 */
export interface IApprovalQueue {
  /**
   * Start listening for `bus:ORDER_PENDING_APPROVAL` events.
   * Returns an unsubscribe function.
   */
  start(): Unsubscribe

  /**
   * Approve a pending draft.
   * Publishes `bus:ORDER_APPROVED` and `bus:ACTION_COMPLETED`.
   * Throws if the draft is not found or not in pending status.
   */
  approve(draftId: string, approverId: string): Promise<void>

  /**
   * Reject a pending draft.
   * Publishes `bus:ORDER_APPROVAL_REJECTED` and `bus:ACTION_COMPLETED`.
   * Throws if the draft is not found or not in pending status.
   */
  reject(draftId: string, reason: string): Promise<void>

  /**
   * Return all records currently in `pending` status.
   */
  getPending(): ApprovalRecord[]

  /**
   * Return a single record by draft_id, or null if not found.
   */
  getRecord(draftId: string): ApprovalRecord | null

  /**
   * Cancel all pending timers and clean up subscriptions.
   */
  dispose(): void
}

// ── ApprovalQueueDeps ─────────────────────────────────────────────────────────

export interface ApprovalQueueDeps {
  /** Event bus for receiving ORDER_PENDING_APPROVAL and publishing outcomes */
  bus: IEventBus
  /**
   * Default timeout in ms for approvals that don't specify their own.
   * Default: 300_000 (5 minutes)
   */
  defaultTimeoutMs?: number
}

// ── Approval errors ───────────────────────────────────────────────────────────

export class ApprovalNotFoundError extends Error {
  constructor(draftId: string) {
    super(`No pending approval found for draft_id: ${draftId}`)
    this.name = 'ApprovalNotFoundError'
  }
}

export class ApprovalAlreadyResolvedError extends Error {
  constructor(draftId: string, status: ApprovalStatus) {
    super(`Draft ${draftId} is already resolved with status: ${status}`)
    this.name = 'ApprovalAlreadyResolvedError'
  }
}
