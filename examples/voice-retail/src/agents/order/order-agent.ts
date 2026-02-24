import { NexusAgent } from 'fitalyagents'
import type {
    TaskPayloadEvent,
    TaskResultEvent,
    AgentManifest,
    IEventBus,
} from 'fitalyagents'
import type { IOrderService } from './types.js'

// ── Manifest ─────────────────────────────────────────────────────────────────

export function createOrderManifest(
    overrides: Partial<AgentManifest> = {},
): AgentManifest {
    return {
        agent_id: 'order-agent-001',
        display_name: 'Order Agent',
        description:
            'Order management agent handling order creation, cancellation, refunds, and status queries. All mutating operations require human approval before execution.',
        version: '1.0.0',
        domain: 'customer_facing',
        scope: 'order_management',
        capabilities: ['ORDER_CREATE', 'ORDER_CANCEL', 'REFUND_CREATE', 'ORDER_STATUS'],
        context_mode: 'stateful',
        context_access: {
            read: ['current_order', 'conversation_history', 'user_preferences'],
            write: ['current_order', 'last_action'],
            forbidden: ['internal_metrics', 'agent_debug'],
        },
        async_tools: [
            'order_create_draft',
            'order_submit_for_approval',
            'refund_create_draft',
            'refund_submit_for_approval',
            'order_status_query',
        ],
        input_channel: 'queue:order-agent:inbox',
        output_channel: 'queue:order-agent:outbox',
        priority: 7,
        max_concurrent: 3,
        timeout_ms: 10000,
        heartbeat_interval_ms: 3000,
        role: null,
        accepts_from: ['*'],
        requires_human_approval: true,
        ...overrides,
    }
}

// ── OrderAgent ────────────────────────────────────────────────────────────────

export interface OrderAgentOptions {
    bus: IEventBus
    orderService: IOrderService
    manifest?: Partial<AgentManifest>
}

/**
 * OrderAgent — the order management agent for the retail domain.
 *
 * Responsibilities:
 * 1. **Order Creation** — Draft → submit for human approval (never charges directly)
 * 2. **Refund Creation** — Draft → submit for human approval
 * 3. **Order Status** — Query order status, resolves immediately
 * 4. **Order Cancel** — Cancel pre-running orders, resolves immediately
 *
 * Architecture:
 * - Extends `NexusAgent` for lifecycle (register, heartbeat, inbox)
 * - `requires_human_approval: true` in manifest — CapabilityRouter aware
 * - All mutating operations complete fast: draft → submit → `waiting_approval`
 * - Publishes `bus:ORDER_PENDING_APPROVAL` for the ApprovalQueue (Sprint 3.2)
 * - Query/cancel operations publish `bus:ACTION_COMPLETED` directly
 *
 * Flow (order_create):
 * ```
 * TASK_PAYLOAD (intent: order_create)
 *   ├── createOrderDraft(session_id, slots)  → draft_id
 *   ├── submitOrderForApproval(draft_id)     → submission_id
 *   ├── publish bus:ORDER_PENDING_APPROVAL
 *   └── return TaskResult { status: 'waiting_approval' }
 * ```
 *
 * Flow (order_status):
 * ```
 * TASK_PAYLOAD (intent: order_status)
 *   ├── getOrderStatus(slots)               → order data
 *   ├── publish bus:ACTION_COMPLETED
 *   └── return TaskResult { status: 'completed' }
 * ```
 */
export class OrderAgent extends NexusAgent {
    private readonly orderService: IOrderService

    constructor(options: OrderAgentOptions) {
        super({
            bus: options.bus,
            manifest: createOrderManifest(options.manifest),
        })
        this.orderService = options.orderService
    }

    /**
     * Process an order-related task.
     * Routes to the appropriate handler based on intent_id.
     */
    async process(task: TaskPayloadEvent): Promise<TaskResultEvent> {
        const { intent_id } = task

        switch (intent_id) {
            case 'order_create':
                return this.handleOrderCreate(task)
            case 'order_cancel':
                return this.handleOrderCancel(task)
            case 'refund_create':
                return this.handleRefundCreate(task)
            case 'order_status':
                return this.handleOrderStatus(task)
            default:
                return {
                    event: 'TASK_RESULT',
                    task_id: task.task_id,
                    session_id: task.session_id,
                    status: 'failed',
                    error: `Unknown intent for OrderAgent: ${intent_id}`,
                    context_patch: {},
                    completed_at: Date.now(),
                }
        }
    }

    // ── Intent handlers ───────────────────────────────────────────────────

    /**
     * Create a draft order and submit for human approval.
     * Returns immediately with `waiting_approval` status.
     */
    private async handleOrderCreate(task: TaskPayloadEvent): Promise<TaskResultEvent> {
        const { task_id, session_id, slots } = task

        try {
            const draft = await this.orderService.createOrderDraft(session_id, slots)
            const submission = await this.orderService.submitOrderForApproval(draft.draft_id)

            await this.bus.publish('bus:ORDER_PENDING_APPROVAL', {
                event: 'ORDER_PENDING_APPROVAL',
                task_id,
                session_id,
                intent_id: 'order_create',
                agent_id: this.manifest.agent_id,
                draft_id: draft.draft_id,
                submission_id: submission.submission_id,
                draft_total: draft.total,
                timestamp: Date.now(),
            })

            return {
                event: 'TASK_RESULT',
                task_id,
                session_id,
                status: 'waiting_approval',
                result: {
                    draft_id: draft.draft_id,
                    submission_id: submission.submission_id,
                    total: draft.total,
                    items: draft.items,
                },
                context_patch: {
                    current_order: {
                        draft_id: draft.draft_id,
                        submission_id: submission.submission_id,
                        type: 'order',
                        status: 'pending_approval',
                        total: draft.total,
                        created_at: draft.created_at,
                    },
                    last_action: {
                        type: 'ORDER_CREATE_SUBMITTED',
                        draft_id: draft.draft_id,
                        timestamp: Date.now(),
                    },
                },
                completed_at: Date.now(),
            }
        } catch (err) {
            return this.buildFailure(task_id, session_id, err)
        }
    }

    /**
     * Cancel an existing order.
     * Resolves immediately and publishes ACTION_COMPLETED.
     */
    private async handleOrderCancel(task: TaskPayloadEvent): Promise<TaskResultEvent> {
        const { task_id, session_id, slots } = task

        try {
            const result = await this.orderService.cancelOrder(slots)

            await this.bus.publish('bus:ACTION_COMPLETED', {
                event: 'ACTION_COMPLETED',
                task_id,
                session_id,
                intent_id: 'order_cancel',
                agent_id: this.manifest.agent_id,
                result,
                timestamp: Date.now(),
            })

            return {
                event: 'TASK_RESULT',
                task_id,
                session_id,
                status: 'completed',
                result,
                context_patch: {
                    current_order: null,
                    last_action: {
                        type: 'ORDER_CANCELLED',
                        order_id: result.order_id,
                        timestamp: Date.now(),
                    },
                },
                completed_at: Date.now(),
            }
        } catch (err) {
            return this.buildFailure(task_id, session_id, err)
        }
    }

    /**
     * Create a draft refund and submit for human approval.
     * Returns immediately with `waiting_approval` status.
     */
    private async handleRefundCreate(task: TaskPayloadEvent): Promise<TaskResultEvent> {
        const { task_id, session_id, slots } = task

        try {
            const draft = await this.orderService.createRefundDraft(session_id, slots)
            const submission = await this.orderService.submitRefundForApproval(draft.draft_id)

            await this.bus.publish('bus:ORDER_PENDING_APPROVAL', {
                event: 'ORDER_PENDING_APPROVAL',
                task_id,
                session_id,
                intent_id: 'refund_create',
                agent_id: this.manifest.agent_id,
                draft_id: draft.draft_id,
                submission_id: submission.submission_id,
                draft_total: draft.total,
                original_order_id: draft.order_id,
                timestamp: Date.now(),
            })

            return {
                event: 'TASK_RESULT',
                task_id,
                session_id,
                status: 'waiting_approval',
                result: {
                    draft_id: draft.draft_id,
                    submission_id: submission.submission_id,
                    refund_amount: draft.total,
                    original_order_id: draft.order_id,
                },
                context_patch: {
                    current_order: {
                        draft_id: draft.draft_id,
                        submission_id: submission.submission_id,
                        type: 'refund',
                        status: 'pending_approval',
                        total: draft.total,
                        order_id: draft.order_id,
                        created_at: draft.created_at,
                    },
                    last_action: {
                        type: 'REFUND_CREATE_SUBMITTED',
                        draft_id: draft.draft_id,
                        timestamp: Date.now(),
                    },
                },
                completed_at: Date.now(),
            }
        } catch (err) {
            return this.buildFailure(task_id, session_id, err)
        }
    }

    /**
     * Query order status. Resolves immediately, publishes ACTION_COMPLETED.
     */
    private async handleOrderStatus(task: TaskPayloadEvent): Promise<TaskResultEvent> {
        const { task_id, session_id, slots } = task

        try {
            const result = await this.orderService.getOrderStatus(slots)

            await this.bus.publish('bus:ACTION_COMPLETED', {
                event: 'ACTION_COMPLETED',
                task_id,
                session_id,
                intent_id: 'order_status',
                agent_id: this.manifest.agent_id,
                result,
                timestamp: Date.now(),
            })

            return {
                event: 'TASK_RESULT',
                task_id,
                session_id,
                status: 'completed',
                result,
                context_patch: {
                    last_action: {
                        type: 'ORDER_STATUS_QUERIED',
                        order_id: result.order_id,
                        order_status: result.status,
                        timestamp: Date.now(),
                    },
                },
                completed_at: Date.now(),
            }
        } catch (err) {
            return this.buildFailure(task_id, session_id, err)
        }
    }

    // ── Helpers ───────────────────────────────────────────────────────────

    private buildFailure(
        task_id: string,
        session_id: string,
        err: unknown,
    ): TaskResultEvent {
        const message = err instanceof Error ? err.message : String(err)
        return {
            event: 'TASK_RESULT',
            task_id,
            session_id,
            status: 'failed',
            error: message,
            context_patch: {},
            completed_at: Date.now(),
        }
    }
}
