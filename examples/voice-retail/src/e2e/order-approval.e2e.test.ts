/**
 * Sprint 3.2 — Order Approval E2E Test
 *
 * Full pipeline with human approval:
 *
 * ```
 * User: "I want to order Nike shoes size 42"
 *   │
 *   ├── OrderAgent.process(order_create)
 *   │     ├── createOrderDraft()
 *   │     ├── submitOrderForApproval()
 *   │     ├── bus:ORDER_PENDING_APPROVAL
 *   │     └── returns { status: 'waiting_approval' }
 *   │
 *   ├── InMemoryApprovalQueue stores pending record
 *   │
 *   ├── [200ms later] Human approves via webhook:
 *   │     ├── approvalQueue.approve(draft_id, 'manager')
 *   │     ├── bus:ORDER_APPROVED
 *   │     └── bus:ACTION_COMPLETED  ← InteractionAgent reacts
 *   │
 *   └── InteractionAgent:
 *         ├── interrupt filler audio
 *         ├── push "Your order has been confirmed!" audio
 *         └── displayGesture('happy')
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
import { createApprovalWebhookHandler } from '../approval/webhook-handler.js'

const wait = (ms: number) => new Promise((r) => setTimeout(r, ms))

describe('E2E: Order Approval Flow', () => {
    let bus: InMemoryBus
    let tenClient: MockTENClient
    let audioQueue: InMemoryAudioQueueService
    let interactionAgent: InteractionAgent
    let orderAgent: OrderAgent
    let approvalQueue: InMemoryApprovalQueue
    let played: Array<{ sessionId: string; segment: AudioSegment }>
    let audioUnsub: () => void
    let approvalUnsub: () => void

    beforeEach(async () => {
        bus = new InMemoryBus()
        played = []

        // 1. Audio Queue
        audioQueue = new InMemoryAudioQueueService({
            bus,
            onSegmentReady: async (sessionId, segment) => {
                played.push({ sessionId, segment })
            },
        })
        audioUnsub = audioQueue.start()

        // 2. TEN Client (mock)
        tenClient = new MockTENClient({
            quickResponses: {
                order_create: { text: 'Placing your order, just a moment!', gesture: 'thinking' },
            },
            latencyMs: 2,
        })

        // 3. Interaction Agent
        interactionAgent = new InteractionAgent({ bus, tenClient, audioQueue })

        // 4. Order Agent
        orderAgent = new OrderAgent({
            bus,
            orderService: new MockOrderService({ latencyMs: 5 }),
        })

        // 5. Approval Queue (listens to bus:ORDER_PENDING_APPROVAL)
        approvalQueue = new InMemoryApprovalQueue({ bus, defaultTimeoutMs: 5000 })
        approvalUnsub = approvalQueue.start()

        await interactionAgent.start()
        await orderAgent.start()
    })

    afterEach(async () => {
        audioUnsub()
        approvalUnsub()
        await interactionAgent.shutdown()
        await orderAgent.shutdown()
    })

    // ── Full approval flow ────────────────────────────────────────────────

    it('order_create → pending → approve → InteractionAgent speaks confirmation', async () => {
        const actionEvents: unknown[] = []
        const approvedEvents: unknown[] = []
        bus.subscribe('bus:ACTION_COMPLETED', (d) => actionEvents.push(d))
        bus.subscribe('bus:ORDER_APPROVED', (d) => approvedEvents.push(d))

        // Step 1: InteractionAgent receives the task (quick response while pending)
        const iaResult = await interactionAgent.process({
            event: 'TASK_PAYLOAD',
            task_id: 'e2e_order_task_1',
            session_id: 'e2e_order_sess_1',
            intent_id: 'order_create',
            slots: { product_id: 'SHOE-042', quantity: 1, price: 129.99, total: 129.99 },
            context_snapshot: {},
            cancel_token: null,
            timeout_ms: 10000,
            reply_to: 'queue:interaction-agent:outbox',
        })

        expect(iaResult.status).toBe('completed') // IA always completes fast (filler)
        expect(tenClient.getCallsFor('generateQuickResponse').length).toBeGreaterThanOrEqual(1)

        // Filler audio should have been queued
        await wait(50)
        expect(played.some((p) => p.segment.segmentId.startsWith('filler_'))).toBe(true)

        // Step 2: OrderAgent processes the task (creates draft + submits)
        const orderResult = await orderAgent.process({
            event: 'TASK_PAYLOAD',
            task_id: 'e2e_order_task_1',
            session_id: 'e2e_order_sess_1',
            intent_id: 'order_create',
            slots: { product_id: 'SHOE-042', quantity: 1, price: 129.99, total: 129.99 },
            context_snapshot: {},
            cancel_token: null,
            timeout_ms: 10000,
            reply_to: 'queue:order-agent:outbox',
        })

        expect(orderResult.status).toBe('waiting_approval')
        const orderResultData = orderResult.result as Record<string, unknown>
        const draftId = orderResultData.draft_id as string
        expect(draftId).toBeTruthy()

        // Wait for ORDER_PENDING_APPROVAL to reach the queue
        await wait(30)

        // Verify the approval is pending
        expect(approvalQueue.getPending().length).toBe(1)
        expect(approvalQueue.getRecord(draftId)?.status).toBe('pending')

        // Step 3: Human approves via simulated webhook (200ms later)
        await wait(200)
        const webhookHandler = createApprovalWebhookHandler(approvalQueue)
        let webhookStatus = 200
        let webhookResponse: unknown

        await webhookHandler(
            { body: { action: 'approve', draft_id: draftId, approver_id: 'manager_alice' } },
            {
                status(code) { webhookStatus = code; return this },
                json(data) { webhookResponse = data },
            },
        )

        expect(webhookStatus).toBe(200)
        expect((webhookResponse as Record<string, unknown>).ok).toBe(true)

        // Wait for ACTION_COMPLETED to propagate to InteractionAgent
        await wait(100)

        // Assertions
        expect(approvedEvents.length).toBe(1)
        expect(actionEvents.length).toBeGreaterThanOrEqual(1)

        // InteractionAgent should have interrupted filler and pushed real response
        const realSegments = played.filter((p) => p.segment.segmentId.startsWith('response_'))
        expect(realSegments.length).toBeGreaterThanOrEqual(1)

        // Confirmation text should mention the order
        const confirmationText = realSegments[0]!.segment.text
        expect(confirmationText.toLowerCase()).toMatch(/confirm|order|129/)

        // Happy gesture should have been displayed
        const gestures = tenClient.getCallsFor('displayGesture').map((c) => c.args[1])
        expect(gestures).toContain('happy')

        // Approval record should be resolved
        expect(approvalQueue.getRecord(draftId)?.status).toBe('approved')

        console.log('\n📊 Order Approval E2E:')
        console.log(`   Draft ID: ${draftId}`)
        console.log(`   Audio segments played: ${played.length}`)
        console.log(`   ACTION_COMPLETED events: ${actionEvents.length}`)
        console.log(`   Confirmation: "${confirmationText}"`)
    })

    // ── Rejection flow ────────────────────────────────────────────────────

    it('order_create → pending → reject → InteractionAgent speaks rejection', async () => {
        const actionEvents: unknown[] = []
        bus.subscribe('bus:ACTION_COMPLETED', (d) => actionEvents.push(d))

        // OrderAgent creates and submits draft
        const orderResult = await orderAgent.process({
            event: 'TASK_PAYLOAD',
            task_id: 'e2e_order_task_2',
            session_id: 'e2e_order_sess_2',
            intent_id: 'order_create',
            slots: { product_id: 'SHOE-099', quantity: 2, total: 259.98 },
            context_snapshot: {},
            cancel_token: null,
            timeout_ms: 10000,
            reply_to: 'queue:order-agent:outbox',
        })

        expect(orderResult.status).toBe('waiting_approval')
        const draftId = (orderResult.result as Record<string, unknown>).draft_id as string

        await wait(30)
        expect(approvalQueue.getPending().length).toBe(1)

        // Human rejects
        const webhookHandler = createApprovalWebhookHandler(approvalQueue)
        let webhookStatus = 200
        await webhookHandler(
            { body: { action: 'reject', draft_id: draftId, reason: 'Out of stock' } },
            {
                status(code) { webhookStatus = code; return this },
                json() {},
            },
        )

        expect(webhookStatus).toBe(200)
        await wait(50)

        // InteractionAgent should have spoken rejection
        const realSegments = played.filter((p) => p.segment.segmentId.startsWith('response_'))
        expect(realSegments.length).toBeGreaterThanOrEqual(1)

        const rejectionText = realSegments[0]!.segment.text
        expect(rejectionText.toLowerCase()).toMatch(/not approved|sorry/)

        expect(approvalQueue.getRecord(draftId)?.status).toBe('rejected')
    })

    // ── Timeout flow ──────────────────────────────────────────────────────

    it('order_create → pending → timeout → InteractionAgent speaks timeout message', async () => {
        const timeoutQueue = new InMemoryApprovalQueue({ bus, defaultTimeoutMs: 80 })
        const unsub = timeoutQueue.start()

        const orderResult = await orderAgent.process({
            event: 'TASK_PAYLOAD',
            task_id: 'e2e_order_task_3',
            session_id: 'e2e_order_sess_3',
            intent_id: 'order_create',
            slots: { product_id: 'SHOE-001', total: 99.99 },
            context_snapshot: {},
            cancel_token: null,
            timeout_ms: 10000,
            reply_to: 'queue:order-agent:outbox',
        })

        const draftId = (orderResult.result as Record<string, unknown>).draft_id as string
        await wait(30) // ensure record created
        expect(timeoutQueue.getRecord(draftId)?.status).toBe('pending')

        // Wait for timeout to fire
        await wait(150)

        expect(timeoutQueue.getRecord(draftId)?.status).toBe('timed_out')

        // InteractionAgent should have spoken timeout message
        const realSegments = played.filter((p) => p.segment.segmentId.startsWith('response_'))
        expect(realSegments.length).toBeGreaterThanOrEqual(1)
        const timeoutText = realSegments[0]!.segment.text
        expect(timeoutText.toLowerCase()).toMatch(/expired|try again/)

        unsub()
    })

    // ── Refund approval flow ──────────────────────────────────────────────

    it('refund_create → pending → approve → InteractionAgent speaks refund confirmation', async () => {
        const approvedEvents: unknown[] = []
        bus.subscribe('bus:ORDER_APPROVED', (d) => approvedEvents.push(d))

        const refundResult = await orderAgent.process({
            event: 'TASK_PAYLOAD',
            task_id: 'e2e_refund_task_1',
            session_id: 'e2e_refund_sess_1',
            intent_id: 'refund_create',
            slots: { order_id: 'ORD-999', refund_amount: 49.99 },
            context_snapshot: {},
            cancel_token: null,
            timeout_ms: 10000,
            reply_to: 'queue:order-agent:outbox',
        })

        expect(refundResult.status).toBe('waiting_approval')
        const draftId = (refundResult.result as Record<string, unknown>).draft_id as string

        await wait(30)

        const webhookHandler = createApprovalWebhookHandler(approvalQueue)
        await webhookHandler(
            { body: { action: 'approve', draft_id: draftId, approver_id: 'manager_carol' } },
            { status() { return this }, json() {} },
        )

        await wait(100)

        expect(approvedEvents.length).toBe(1)

        const realSegments = played.filter((p) => p.segment.segmentId.startsWith('response_'))
        expect(realSegments.length).toBeGreaterThanOrEqual(1)
        expect(realSegments[0]!.segment.text.toLowerCase()).toMatch(/refund|49/)
    })
})
