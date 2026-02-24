import { describe, it, expect, beforeEach, afterEach } from 'vitest'
import { InMemoryBus } from 'fitalyagents'
import { OrderAgent } from './order-agent.js'
import { MockOrderService } from './mock-order-service.js'

describe('OrderAgent', () => {
    let bus: InMemoryBus
    let orderService: MockOrderService
    let agent: OrderAgent

    beforeEach(async () => {
        bus = new InMemoryBus()
        orderService = new MockOrderService({ latencyMs: 5 })
        agent = new OrderAgent({ bus, orderService })
        await agent.start()
    })

    afterEach(async () => {
        await agent.shutdown()
    })

    // ── Manifest ──────────────────────────────────────────────────────────

    describe('manifest', () => {
        it('requires_human_approval is true', () => {
            expect(agent.manifest.requires_human_approval).toBe(true)
        })

        it('has correct capabilities', () => {
            expect(agent.manifest.capabilities).toEqual(
                expect.arrayContaining(['ORDER_CREATE', 'ORDER_CANCEL', 'REFUND_CREATE', 'ORDER_STATUS']),
            )
        })

        it('scope is order_management', () => {
            expect(agent.manifest.scope).toBe('order_management')
        })
    })

    // ── order_create ──────────────────────────────────────────────────────

    describe('order_create intent', () => {
        it('creates draft and returns waiting_approval', async () => {
            const result = await agent.process({
                event: 'TASK_PAYLOAD',
                task_id: 'task_create_1',
                session_id: 'sess_1',
                intent_id: 'order_create',
                slots: { product_id: 'PROD-042', quantity: 2, price: 59.99, total: 119.98 },
                context_snapshot: {},
                cancel_token: null,
                timeout_ms: 10000,
                reply_to: 'queue:order-agent:outbox',
            })

            expect(result.status).toBe('waiting_approval')
            expect(result.result).toHaveProperty('draft_id')
            expect(result.result).toHaveProperty('submission_id')
            expect(result.result).toHaveProperty('total', 119.98)
        })

        it('calls createOrderDraft then submitOrderForApproval', async () => {
            await agent.process({
                event: 'TASK_PAYLOAD',
                task_id: 'task_create_2',
                session_id: 'sess_1',
                intent_id: 'order_create',
                slots: { product_id: 'PROD-001', quantity: 1, price: 99.99 },
                context_snapshot: {},
                cancel_token: null,
                timeout_ms: 10000,
                reply_to: 'queue:order-agent:outbox',
            })

            const methods = orderService.callLog.map((c) => c.method)
            expect(methods).toEqual(['createOrderDraft', 'submitOrderForApproval'])
        })

        it('patches context with current_order pending_approval', async () => {
            const result = await agent.process({
                event: 'TASK_PAYLOAD',
                task_id: 'task_create_3',
                session_id: 'sess_1',
                intent_id: 'order_create',
                slots: {},
                context_snapshot: {},
                cancel_token: null,
                timeout_ms: 10000,
                reply_to: 'queue:order-agent:outbox',
            })

            const currentOrder = result.context_patch.current_order as Record<string, unknown>
            expect(currentOrder.status).toBe('pending_approval')
            expect(currentOrder.type).toBe('order')
        })

        it('publishes bus:ORDER_PENDING_APPROVAL', async () => {
            const events: unknown[] = []
            bus.subscribe('bus:ORDER_PENDING_APPROVAL', (d) => events.push(d))

            await agent.process({
                event: 'TASK_PAYLOAD',
                task_id: 'task_create_4',
                session_id: 'sess_1',
                intent_id: 'order_create',
                slots: {},
                context_snapshot: {},
                cancel_token: null,
                timeout_ms: 10000,
                reply_to: 'queue:order-agent:outbox',
            })

            expect(events.length).toBe(1)
            const event = events[0] as Record<string, unknown>
            expect(event.intent_id).toBe('order_create')
            expect(event.session_id).toBe('sess_1')
            expect(event.agent_id).toBe('order-agent-001')
            expect(event).toHaveProperty('draft_id')
            expect(event).toHaveProperty('submission_id')
        })
    })

    // ── refund_create ─────────────────────────────────────────────────────

    describe('refund_create intent', () => {
        it('creates refund draft and returns waiting_approval', async () => {
            const result = await agent.process({
                event: 'TASK_PAYLOAD',
                task_id: 'task_refund_1',
                session_id: 'sess_2',
                intent_id: 'refund_create',
                slots: { order_id: 'ORD-123', refund_amount: 49.99 },
                context_snapshot: {},
                cancel_token: null,
                timeout_ms: 10000,
                reply_to: 'queue:order-agent:outbox',
            })

            expect(result.status).toBe('waiting_approval')
            const resultObj = result.result as Record<string, unknown>
            expect(resultObj.original_order_id).toBe('ORD-123')
            expect(resultObj.refund_amount).toBe(49.99)
        })

        it('publishes bus:ORDER_PENDING_APPROVAL with refund intent', async () => {
            const events: unknown[] = []
            bus.subscribe('bus:ORDER_PENDING_APPROVAL', (d) => events.push(d))

            await agent.process({
                event: 'TASK_PAYLOAD',
                task_id: 'task_refund_2',
                session_id: 'sess_2',
                intent_id: 'refund_create',
                slots: { order_id: 'ORD-456' },
                context_snapshot: {},
                cancel_token: null,
                timeout_ms: 10000,
                reply_to: 'queue:order-agent:outbox',
            })

            expect(events.length).toBe(1)
            const event = events[0] as Record<string, unknown>
            expect(event.intent_id).toBe('refund_create')
            expect(event).toHaveProperty('original_order_id', 'ORD-456')
        })
    })

    // ── order_status ──────────────────────────────────────────────────────

    describe('order_status intent', () => {
        it('returns order status with completed status', async () => {
            const svc = new MockOrderService({
                orderStatus: { order_id: 'ORD-777', status: 'shipped', total: 89.99 },
            })
            const statusAgent = new OrderAgent({ bus, orderService: svc })

            const result = await statusAgent.process({
                event: 'TASK_PAYLOAD',
                task_id: 'task_status_1',
                session_id: 'sess_3',
                intent_id: 'order_status',
                slots: { order_id: 'ORD-777' },
                context_snapshot: {},
                cancel_token: null,
                timeout_ms: 10000,
                reply_to: 'queue:order-agent:outbox',
            })

            expect(result.status).toBe('completed')
            const resultObj = result.result as Record<string, unknown>
            expect(resultObj.order_id).toBe('ORD-777')
            expect(resultObj.status).toBe('shipped')
        })

        it('publishes bus:ACTION_COMPLETED for status queries', async () => {
            const events: unknown[] = []
            bus.subscribe('bus:ACTION_COMPLETED', (d) => events.push(d))

            await agent.process({
                event: 'TASK_PAYLOAD',
                task_id: 'task_status_2',
                session_id: 'sess_3',
                intent_id: 'order_status',
                slots: { order_id: 'ORD-001' },
                context_snapshot: {},
                cancel_token: null,
                timeout_ms: 10000,
                reply_to: 'queue:order-agent:outbox',
            })

            expect(events.length).toBe(1)
            const event = events[0] as Record<string, unknown>
            expect(event.intent_id).toBe('order_status')
            expect(event.agent_id).toBe('order-agent-001')
        })
    })

    // ── order_cancel ──────────────────────────────────────────────────────

    describe('order_cancel intent', () => {
        it('cancels order and returns completed', async () => {
            const result = await agent.process({
                event: 'TASK_PAYLOAD',
                task_id: 'task_cancel_1',
                session_id: 'sess_4',
                intent_id: 'order_cancel',
                slots: { order_id: 'ORD-333', reason: 'Changed my mind' },
                context_snapshot: {},
                cancel_token: null,
                timeout_ms: 10000,
                reply_to: 'queue:order-agent:outbox',
            })

            expect(result.status).toBe('completed')
            const resultObj = result.result as Record<string, unknown>
            expect(resultObj.cancelled).toBe(true)
            expect(resultObj.order_id).toBe('ORD-333')
        })

        it('publishes bus:ACTION_COMPLETED on cancel', async () => {
            const events: unknown[] = []
            bus.subscribe('bus:ACTION_COMPLETED', (d) => events.push(d))

            await agent.process({
                event: 'TASK_PAYLOAD',
                task_id: 'task_cancel_2',
                session_id: 'sess_4',
                intent_id: 'order_cancel',
                slots: { order_id: 'ORD-444' },
                context_snapshot: {},
                cancel_token: null,
                timeout_ms: 10000,
                reply_to: 'queue:order-agent:outbox',
            })

            expect(events.length).toBe(1)
            const event = events[0] as Record<string, unknown>
            expect(event.intent_id).toBe('order_cancel')
        })
    })

    // ── Error handling ────────────────────────────────────────────────────

    describe('error handling', () => {
        it('returns failed for unknown intent', async () => {
            const result = await agent.process({
                event: 'TASK_PAYLOAD',
                task_id: 'task_err_1',
                session_id: 'sess_5',
                intent_id: 'unknown_intent',
                slots: {},
                context_snapshot: {},
                cancel_token: null,
                timeout_ms: 10000,
                reply_to: 'queue:order-agent:outbox',
            })

            expect(result.status).toBe('failed')
            expect(result.error).toContain('Unknown intent for OrderAgent')
        })

        it('returns failed when order service throws', async () => {
            const failingSvc = new MockOrderService({
                shouldFail: true,
                failMessage: 'Orders DB unreachable',
            })
            const failAgent = new OrderAgent({ bus, orderService: failingSvc })

            const result = await failAgent.process({
                event: 'TASK_PAYLOAD',
                task_id: 'task_err_2',
                session_id: 'sess_5',
                intent_id: 'order_create',
                slots: {},
                context_snapshot: {},
                cancel_token: null,
                timeout_ms: 10000,
                reply_to: 'queue:order-agent:outbox',
            })

            expect(result.status).toBe('failed')
            expect(result.error).toContain('Orders DB unreachable')
        })
    })

    // ── Lifecycle ─────────────────────────────────────────────────────────

    describe('lifecycle', () => {
        it('publishes AGENT_DEREGISTERED on shutdown', async () => {
            const events: unknown[] = []
            bus.subscribe('bus:AGENT_DEREGISTERED', (d) => events.push(d))

            await agent.shutdown()

            expect(events.length).toBe(1)
            expect(events[0]).toHaveProperty('agent_id', 'order-agent-001')
        })
    })
})
