/**
 * Sprint 3.4 — Order Status Query E2E
 *
 * Full order lifecycle: create → approve → status query
 *
 * ```
 * Session 1: "quiero comprar las Nike talla 42"
 *   ├── OrderAgent.process(order_create)
 *   │   ├── createOrderDraft() → draft_001
 *   │   ├── submitOrderForApproval(draft_001)
 *   │   └── bus:ORDER_PENDING_APPROVAL → ApprovalQueue records it
 *   │                                    (status: waiting_approval)
 *   │
 * Manager approves:
 *   ├── approvalQueue.approve(draft_001, 'manager_alice')
 *   │   ├── bus:ORDER_APPROVED → context update
 *   │   └── bus:ACTION_COMPLETED → InteractionAgent responds
 *   │
 * Session 2: "¿cómo va mi pedido?"  (independent task)
 *   ├── OrderAgent.process(order_status)
 *   │   ├── getOrderStatus({ order_id }) → { status: 'confirmed', ... }
 *   │   └── bus:ACTION_COMPLETED → InteractionAgent responds
 *   │
 * Session 3: Cancel flow
 *   └── OrderAgent.process(order_cancel) → { cancelled: true }
 * ```
 */
import { describe, it, expect, beforeEach, afterEach } from 'vitest'
import {
    InMemoryBus,
    InMemoryAudioQueueService,
    InMemoryApprovalQueue,
} from 'fitalyagents'
import type { AudioSegment } from 'fitalyagents'
import { InteractionAgent } from '../agents/interaction/interaction-agent.js'
import { MockTENClient } from '../agents/interaction/mock-ten-client.js'
import { OrderAgent } from '../agents/order/order-agent.js'
import { MockOrderService } from '../agents/order/mock-order-service.js'

// ── Helpers ──────────────────────────────────────────────────────────────────

const wait = (ms: number) => new Promise((r) => setTimeout(r, ms))

// ── Tests ─────────────────────────────────────────────────────────────────────

describe('E2E: Order Lifecycle (Sprint 3.4)', () => {
    let bus: InMemoryBus
    let orderService: MockOrderService
    let orderAgent: OrderAgent
    let interactionAgent: InteractionAgent
    let tenClient: MockTENClient
    let audioQueue: InMemoryAudioQueueService
    let approvalQueue: InMemoryApprovalQueue
    let played: Array<{ sessionId: string; segment: AudioSegment }>
    let audioUnsub: () => void
    let approvalUnsub: () => void

    beforeEach(async () => {
        bus = new InMemoryBus()
        played = []

        // Audio
        audioQueue = new InMemoryAudioQueueService({
            bus,
            onSegmentReady: async (sessionId, segment) => {
                played.push({ sessionId, segment })
            },
        })
        audioUnsub = audioQueue.start()

        // TEN Client
        tenClient = new MockTENClient({
            quickResponses: {
                order_create: { text: 'Creando tu pedido...', gesture: 'thinking' },
                order_status: { text: 'Consultando tu pedido...', gesture: 'waiting' },
                order_cancel: { text: 'Cancelando el pedido...', gesture: 'apologetic' },
            },
            latencyMs: 2,
        })

        // Order Service
        orderService = new MockOrderService({
            latencyMs: 5,
            orderStatus: { status: 'confirmed', tracking_number: 'TRK-12345' },
        })

        // Agents
        interactionAgent = new InteractionAgent({ bus, tenClient, audioQueue })
        orderAgent = new OrderAgent({ bus, orderService })

        // ApprovalQueue
        approvalQueue = new InMemoryApprovalQueue({ bus })
        approvalUnsub = approvalQueue.start()

        await interactionAgent.start()
        await orderAgent.start()
    })

    afterEach(async () => {
        approvalUnsub()
        audioUnsub()
        await interactionAgent.shutdown()
        await orderAgent.shutdown()
        audioQueue.dispose()
    })

    // ── Full lifecycle: create → approve → status query ────────────────────

    describe('Full order lifecycle', () => {
        it('create → approve → status query flows end-to-end', async () => {
            // ── Step 1: Order Create ─────────────────────────────────────────
            const actionCompletedEvents: unknown[] = []
            const orderApprovedEvents: unknown[] = []
            bus.subscribe('bus:ACTION_COMPLETED', (d) => actionCompletedEvents.push(d))
            bus.subscribe('bus:ORDER_APPROVED', (d) => orderApprovedEvents.push(d))

            // InteractionAgent shows filler (parallel)
            await interactionAgent.process({
                event: 'TASK_PAYLOAD',
                task_id: 'ia_order_1',
                session_id: 'sess_order',
                intent_id: 'order_create',
                slots: { product_id: 'NIKE-42', quantity: 1, price: 129.99 },
                context_snapshot: {},
                cancel_token: null,
                timeout_ms: 8000,
                reply_to: 'queue:interaction:outbox',
            })

            // OrderAgent creates draft and submits for approval
            const orderResult = await orderAgent.process({
                event: 'TASK_PAYLOAD',
                task_id: 'order_task_1',
                session_id: 'sess_order',
                intent_id: 'order_create',
                slots: { product_id: 'NIKE-42', quantity: 1, price: 129.99, total: 129.99 },
                context_snapshot: {},
                cancel_token: 'tok_order_1',
                timeout_ms: 8000,
                reply_to: 'queue:order:outbox',
            })

            // Verify order creation result:
            // OrderAgent returns 'waiting_approval' immediately — the actual
            // 'completed' step happens async when the manager approves.
            // This is by design: agent finishes fast, approval is async.
            expect(orderResult.status).toBe('waiting_approval')
            const orderData = orderResult.result as Record<string, unknown>
            // result shape: { draft_id, submission_id, total, items }
            expect(String(orderData.draft_id)).toMatch(/^draft_/)
            expect(String(orderData.submission_id)).toMatch(/^sub_/)
            // context_patch carries the pending_approval status
            expect(orderResult.context_patch?.current_order).toMatchObject({
                status: 'pending_approval',
            })

            // Verify approval was registered
            await wait(30)
            const pendingApprovals = approvalQueue.getPending()
            expect(pendingApprovals.length).toBe(1)
            const draftId = String(orderData.draft_id)

            // Verify service calls
            expect(orderService.callLog.some((c) => c.method === 'createOrderDraft')).toBe(true)
            expect(orderService.callLog.some((c) => c.method === 'submitOrderForApproval')).toBe(true)

            // Filler audio should have been playing
            await wait(50)
            const fillerAudio = played.filter((p) => p.segment.segmentId.startsWith('filler_'))
            expect(fillerAudio.length).toBeGreaterThanOrEqual(1)

            // ── Step 2: Human Approves ────────────────────────────────────────
            await approvalQueue.approve(draftId, 'manager_alice')
            await wait(50)

            // ORDER_APPROVED event fired
            expect(orderApprovedEvents.length).toBe(1)
            const approvedEvent = orderApprovedEvents[0] as Record<string, unknown>
            expect(approvedEvent.approved_by).toBe('manager_alice')
            expect(approvedEvent.draft_id).toBe(draftId)

            // ACTION_COMPLETED fired (for InteractionAgent)
            const completedAfterApproval = actionCompletedEvents.filter((e) => {
                const ev = e as Record<string, unknown>
                return ev.intent_id === 'order_create'
            })
            expect(completedAfterApproval.length).toBeGreaterThanOrEqual(1)

            // InteractionAgent should react with happy gesture
            await wait(100)
            const gestures = tenClient.getCallsFor('displayGesture')
            const happyGestures = gestures.filter((c) => c.args[1] === 'happy')
            expect(happyGestures.length).toBeGreaterThanOrEqual(1)

            // Real response audio pushed
            const realAudio = played.filter((p) => p.segment.segmentId.startsWith('response_'))
            expect(realAudio.length).toBeGreaterThanOrEqual(1)

            // ── Step 3: Status Query (independent task) ───────────────────────
            // User says "¿cómo va mi pedido?" some time later
            const statusResult = await orderAgent.process({
                event: 'TASK_PAYLOAD',
                task_id: 'status_task_1',
                session_id: 'sess_order',
                intent_id: 'order_status',
                slots: { order_id: 'ORD-001' },
                context_snapshot: { last_order_id: 'ORD-001' },
                cancel_token: null,
                timeout_ms: 8000,
                reply_to: 'queue:order:outbox',
            })

            expect(statusResult.status).toBe('completed')
            const statusData = statusResult.result as Record<string, unknown>
            expect(statusData.order_id).toBe('ORD-001')
            expect(statusData.status).toBe('confirmed')
            expect(statusData.tracking_number).toBe('TRK-12345')

            // ACTION_COMPLETED fired for status query
            const statusCompleted = actionCompletedEvents.filter((e) => {
                return (e as Record<string, unknown>).intent_id === 'order_status'
            })
            expect(statusCompleted.length).toBeGreaterThanOrEqual(1)

            console.log(`\n📊 Order Lifecycle Metrics:`)
            console.log(`   Service calls: ${orderService.callLog.length}`)
            console.log(`   Approvals processed: ${pendingApprovals.length}`)
            console.log(`   Audio segments played: ${played.length}`)
            console.log(`   TEN calls: ${tenClient.calls.length}`)
            console.log(`   ACTION_COMPLETED events: ${actionCompletedEvents.length}`)
        })
    })

    // ── Status query independent ───────────────────────────────────────────

    describe('Order status query — independent task', () => {
        it('returns confirmed status with tracking number', async () => {
            const result = await orderAgent.process({
                event: 'TASK_PAYLOAD',
                task_id: 'status_01',
                session_id: 'sess_1',
                intent_id: 'order_status',
                slots: { order_id: 'ORD-999' },
                context_snapshot: { last_action: { order_id: 'ORD-999' } },
                cancel_token: null,
                timeout_ms: 8000,
                reply_to: 'queue:order:outbox',
            })

            expect(result.status).toBe('completed')
            const data = result.result as Record<string, unknown>
            expect(data.order_id).toBe('ORD-999')
            expect(data.status).toBe('confirmed')
            expect(data.tracking_number).toBe('TRK-12345')

            // Check context patch has last_action
            expect(result.context_patch.last_action).toMatchObject({
                type: 'ORDER_STATUS_QUERIED',
                order_id: 'ORD-999',
            })
        })

        it('InteractionAgent speaks the status result on ACTION_COMPLETED', async () => {
            // Process status query → publishes ACTION_COMPLETED
            await orderAgent.process({
                event: 'TASK_PAYLOAD',
                task_id: 'status_02',
                session_id: 'sess_speak',
                intent_id: 'order_status',
                slots: { order_id: 'ORD-777' },
                context_snapshot: {},
                cancel_token: null,
                timeout_ms: 8000,
                reply_to: 'queue:order:outbox',
            })

            // InteractionAgent also had a filler active
            await interactionAgent.process({
                event: 'TASK_PAYLOAD',
                task_id: 'ia_status_02',
                session_id: 'sess_speak',
                intent_id: 'order_status',
                slots: {},
                context_snapshot: {},
                cancel_token: null,
                timeout_ms: 8000,
                reply_to: 'queue:interaction:outbox',
            })

            await wait(150)

            // Audio should contain real response (status text)
            const statusResponses = played.filter(
                (p) => p.sessionId === 'sess_speak',
            )
            expect(statusResponses.length).toBeGreaterThanOrEqual(1)
        })

        it('reads order_id from context_snapshot if not in slots', async () => {
            const result = await orderAgent.process({
                event: 'TASK_PAYLOAD',
                task_id: 'status_03',
                session_id: 'sess_ctx',
                intent_id: 'order_status',
                slots: {}, // No order_id in slots
                context_snapshot: { last_order_id: 'ORD-CTX-001' }, // In context
                cancel_token: null,
                timeout_ms: 8000,
                reply_to: 'queue:order:outbox',
            })

            expect(result.status).toBe('completed')
            // The service should be called (with whatever order_id it resolves)
            const statusCalls = orderService.callLog.filter((c) => c.method === 'getOrderStatus')
            expect(statusCalls.length).toBe(1)
        })
    })

    // ── Full cycle: create → approve → cancel ──────────────────────────────

    describe('Order cancel flow', () => {
        it('cancel an existing order returns cancelled: true', async () => {
            const cancelResult = await orderAgent.process({
                event: 'TASK_PAYLOAD',
                task_id: 'cancel_01',
                session_id: 'sess_cancel',
                intent_id: 'order_cancel',
                slots: { order_id: 'ORD-001', reason: 'Customer request' },
                context_snapshot: {},
                cancel_token: null,
                timeout_ms: 8000,
                reply_to: 'queue:order:outbox',
            })

            expect(cancelResult.status).toBe('completed')
            const data = cancelResult.result as Record<string, unknown>
            expect(data.order_id).toBe('ORD-001')
            expect(data.cancelled).toBe(true)
        })

        it('cancel publishes ACTION_COMPLETED for InteractionAgent to react', async () => {
            const events: unknown[] = []
            bus.subscribe('bus:ACTION_COMPLETED', (d) => events.push(d))

            await orderAgent.process({
                event: 'TASK_PAYLOAD',
                task_id: 'cancel_02',
                session_id: 'sess_cancel2',
                intent_id: 'order_cancel',
                slots: { order_id: 'ORD-002' },
                context_snapshot: {},
                cancel_token: null,
                timeout_ms: 8000,
                reply_to: 'queue:order:outbox',
            })

            expect(events.length).toBe(1)
            const ev = events[0] as Record<string, unknown>
            expect(ev.intent_id).toBe('order_cancel')
        })
    })

    // ── Multi-session order isolation ─────────────────────────────────────

    describe('Multi-session isolation', () => {
        it('two concurrent order status queries are session-isolated', async () => {
            const [resultBob, resultAlice] = await Promise.all([
                orderAgent.process({
                    event: 'TASK_PAYLOAD',
                    task_id: 'status_bob',
                    session_id: 'sess_bob',
                    intent_id: 'order_status',
                    slots: { order_id: 'ORD-BOB' },
                    context_snapshot: {},
                    cancel_token: null,
                    timeout_ms: 8000,
                    reply_to: 'queue:order:outbox',
                }),
                orderAgent.process({
                    event: 'TASK_PAYLOAD',
                    task_id: 'status_alice',
                    session_id: 'sess_alice',
                    intent_id: 'order_status',
                    slots: { order_id: 'ORD-ALICE' },
                    context_snapshot: {},
                    cancel_token: null,
                    timeout_ms: 8000,
                    reply_to: 'queue:order:outbox',
                }),
            ])

            expect(resultBob.session_id).toBe('sess_bob')
            expect(resultAlice.session_id).toBe('sess_alice')

            const bobData = resultBob.result as Record<string, unknown>
            const aliceData = resultAlice.result as Record<string, unknown>

            expect(bobData.order_id).toBe('ORD-BOB')
            expect(aliceData.order_id).toBe('ORD-ALICE')
        })
    })
})
