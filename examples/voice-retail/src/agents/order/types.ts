/**
 * A draft order (or refund) created before human approval.
 */
export interface OrderDraft {
    draft_id: string
    type: 'order' | 'refund'
    session_id: string
    status: 'draft'
    items?: Array<{ product_id: string; quantity: number; price: number }>
    total?: number
    order_id?: string // for refunds: the original order being refunded
    created_at: number
}

/**
 * Result of submitting a draft for approval.
 */
export interface SubmissionResult {
    submission_id: string
    draft_id: string
    status: 'pending_approval'
    submitted_at: number
}

/**
 * Result of querying an order's status.
 */
export interface OrderStatusResult {
    order_id: string
    status: 'pending' | 'confirmed' | 'processing' | 'shipped' | 'delivered' | 'cancelled' | 'refunded'
    items?: Array<{ name: string; quantity: number; price: number }>
    total?: number
    created_at?: number
    updated_at?: number
    tracking_number?: string
}

/**
 * Result of cancelling an order.
 */
export interface CancelResult {
    order_id: string
    cancelled: boolean
    reason?: string
}

/**
 * Interface for the order service that OrderAgent delegates to.
 *
 * In tests: `MockOrderService` with canned responses.
 * In production: HTTP client calling the orders microservice.
 */
export interface IOrderService {
    /**
     * Create a draft order from cart/slot data.
     * Does NOT charge the customer yet.
     */
    createOrderDraft(
        sessionId: string,
        input: Record<string, unknown>,
    ): Promise<OrderDraft>

    /**
     * Submit a draft order for human approval.
     * Returns a submission ID used to correlate the approval webhook.
     */
    submitOrderForApproval(
        draftId: string,
    ): Promise<SubmissionResult>

    /**
     * Create a draft refund for an existing order.
     */
    createRefundDraft(
        sessionId: string,
        input: Record<string, unknown>,
    ): Promise<OrderDraft>

    /**
     * Submit a draft refund for human approval.
     */
    submitRefundForApproval(
        draftId: string,
    ): Promise<SubmissionResult>

    /**
     * Query the status of an order.
     */
    getOrderStatus(
        input: Record<string, unknown>,
    ): Promise<OrderStatusResult>

    /**
     * Cancel an order (only if pre-running / not yet shipped).
     */
    cancelOrder(
        input: Record<string, unknown>,
    ): Promise<CancelResult>
}

/**
 * A service call record used in MockOrderService for test assertions.
 */
export interface ServiceCallRecord {
    method: string
    args: unknown[]
    result: unknown
}
