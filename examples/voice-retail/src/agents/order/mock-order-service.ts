import type {
    IOrderService,
    OrderDraft,
    SubmissionResult,
    OrderStatusResult,
    CancelResult,
    ServiceCallRecord,
} from './types.js'

/**
 * Mock Order Service — stands in for the orders microservice in tests.
 *
 * Configurable with canned responses and call recording for assertions.
 *
 * @example
 * ```typescript
 * const service = new MockOrderService({
 *   latencyMs: 5,
 *   orderStatus: { order_id: 'ORD-001', status: 'delivered', total: 99.99 },
 * })
 *
 * const draft = await service.createOrderDraft('sess_1', { items: [...] })
 * expect(service.callLog).toHaveLength(1)
 * ```
 */
export class MockOrderService implements IOrderService {
    private latencyMs: number
    private shouldFail: boolean
    private failMessage: string
    private orderStatusResult: Partial<OrderStatusResult>
    private cancelResult: Partial<CancelResult>
    private draftCounter = 0
    private submissionCounter = 0

    public callLog: ServiceCallRecord[] = []

    constructor(opts: {
        latencyMs?: number
        shouldFail?: boolean
        failMessage?: string
        orderStatus?: Partial<OrderStatusResult>
        cancelResult?: Partial<CancelResult>
    } = {}) {
        this.latencyMs = opts.latencyMs ?? 5
        this.shouldFail = opts.shouldFail ?? false
        this.failMessage = opts.failMessage ?? 'Service unavailable'
        this.orderStatusResult = opts.orderStatus ?? {}
        this.cancelResult = opts.cancelResult ?? {}
    }

    private async delay(): Promise<void> {
        await new Promise((r) => setTimeout(r, this.latencyMs))
    }

    private maybeThrow(): void {
        if (this.shouldFail) throw new Error(this.failMessage)
    }

    private nextDraftId(): string {
        return `draft_${++this.draftCounter}_${Date.now()}`
    }

    private nextSubmissionId(): string {
        return `sub_${++this.submissionCounter}_${Date.now()}`
    }

    async createOrderDraft(
        sessionId: string,
        input: Record<string, unknown>,
    ): Promise<OrderDraft> {
        await this.delay()
        this.maybeThrow()

        const result: OrderDraft = {
            draft_id: this.nextDraftId(),
            type: 'order',
            session_id: sessionId,
            status: 'draft',
            items: (input.items as OrderDraft['items']) ?? [
                { product_id: String(input.product_id ?? 'PROD-001'), quantity: Number(input.quantity ?? 1), price: Number(input.price ?? 99.99) },
            ],
            total: Number(input.total ?? 99.99),
            created_at: Date.now(),
        }

        this.callLog.push({ method: 'createOrderDraft', args: [sessionId, input], result })
        return result
    }

    async submitOrderForApproval(draftId: string): Promise<SubmissionResult> {
        await this.delay()
        this.maybeThrow()

        const result: SubmissionResult = {
            submission_id: this.nextSubmissionId(),
            draft_id: draftId,
            status: 'pending_approval',
            submitted_at: Date.now(),
        }

        this.callLog.push({ method: 'submitOrderForApproval', args: [draftId], result })
        return result
    }

    async createRefundDraft(
        sessionId: string,
        input: Record<string, unknown>,
    ): Promise<OrderDraft> {
        await this.delay()
        this.maybeThrow()

        const result: OrderDraft = {
            draft_id: this.nextDraftId(),
            type: 'refund',
            session_id: sessionId,
            status: 'draft',
            order_id: String(input.order_id ?? 'ORD-001'),
            total: Number(input.refund_amount ?? 99.99),
            created_at: Date.now(),
        }

        this.callLog.push({ method: 'createRefundDraft', args: [sessionId, input], result })
        return result
    }

    async submitRefundForApproval(draftId: string): Promise<SubmissionResult> {
        await this.delay()
        this.maybeThrow()

        const result: SubmissionResult = {
            submission_id: this.nextSubmissionId(),
            draft_id: draftId,
            status: 'pending_approval',
            submitted_at: Date.now(),
        }

        this.callLog.push({ method: 'submitRefundForApproval', args: [draftId], result })
        return result
    }

    async getOrderStatus(input: Record<string, unknown>): Promise<OrderStatusResult> {
        await this.delay()
        this.maybeThrow()

        const result: OrderStatusResult = {
            order_id: String(input.order_id ?? 'ORD-001'),
            status: 'delivered',
            total: 129.99,
            created_at: Date.now() - 86_400_000, // 1 day ago
            updated_at: Date.now() - 3_600_000, // 1 hour ago
            ...this.orderStatusResult,
        }

        this.callLog.push({ method: 'getOrderStatus', args: [input], result })
        return result
    }

    async cancelOrder(input: Record<string, unknown>): Promise<CancelResult> {
        await this.delay()
        this.maybeThrow()

        const result: CancelResult = {
            order_id: String(input.order_id ?? 'ORD-001'),
            cancelled: true,
            reason: String(input.reason ?? 'Customer request'),
            ...this.cancelResult,
        }

        this.callLog.push({ method: 'cancelOrder', args: [input], result })
        return result
    }

    reset(): void {
        this.callLog = []
        this.draftCounter = 0
        this.submissionCounter = 0
    }
}
