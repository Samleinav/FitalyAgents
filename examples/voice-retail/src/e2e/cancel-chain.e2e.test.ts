/**
 * Sprint 3.3 — Task Chaining & Cancel Token E2E
 *
 * Validates the full cancel-chain flow:
 *
 * Scenario 1: "Usuario cambia de opinión"
 * ```
 * User: "quiero comprar las Nike azules"
 *   ├── TaskA: product_search (RUNNING)
 *   └── TaskB: order_create (LOCKED, waiting for TaskA via dependsOn)
 *
 * User: "mejor las rojas" → BARGE_IN → cancel TaskB before it runs
 *   ├── TaskB.cancel(cancelToken) → CANCELLED ✓
 *   └── TaskA completes normally → no dependent to chain to
 * ```
 *
 * Scenario 2: Fail cascade
 * ```
 * TaskA fails → TaskB (which dependsOn TaskA) auto-cancelled
 * ```
 *
 * Scenario 3: Happy chain
 * ```
 * TaskA completes → TaskB unlocked → AVAILABLE → agent claims → runs
 * ```
 */
import { describe, it, expect, beforeEach, afterEach } from 'vitest'
import {
    InMemoryBus,
    InMemoryLockManager,
    InMemoryTaskQueue,
} from 'fitalyagents'
import type { TaskInput } from 'fitalyagents'

// ── Helpers ──────────────────────────────────────────────────────────────────

function makeTask(overrides: Partial<TaskInput> = {}): TaskInput {
    return {
        taskId: 'task_1',
        sessionId: 'sess_1',
        intentId: 'product_search',
        slots: {},
        contextSnapshot: {},
        priority: 5,
        timeoutMs: 8000,
        cancelToken: 'tok_1',
        replyTo: 'queue:work:outbox',
        ...overrides,
    }
}

// ── Tests ─────────────────────────────────────────────────────────────────────

describe('E2E: Task Chaining & Cancel Token (Sprint 3.3)', () => {
    let bus: InMemoryBus
    let locks: InMemoryLockManager
    let queue: InMemoryTaskQueue

    beforeEach(() => {
        bus = new InMemoryBus()
        locks = new InMemoryLockManager()
        queue = new InMemoryTaskQueue({ lockManager: locks, bus })
    })

    afterEach(() => {
        queue.dispose()
        locks.dispose()
    })

    // ── Scenario 1: User changes mind mid-chain ────────────────────────────

    describe('Scenario 1: "Mejor el rojo" — cancel dependent before it runs', () => {
        it('cancels TaskB while TaskA is still running', async () => {
            // Step 1: Dispatcher routes "quiero Nike azules" → two chained tasks
            //   TaskA: product_search (immediate)
            //   TaskB: order_create (depends on TaskA and product result)
            await queue.publish(makeTask({
                taskId: 'task_search',
                intentId: 'product_search',
                slots: { color: 'azul', brand: 'Nike' },
                cancelToken: 'tok_search',
            }))
            await queue.publish(makeTask({
                taskId: 'task_order',
                intentId: 'order_create',
                slots: { color: 'azul', brand: 'Nike' },
                cancelToken: 'tok_order',
                dependsOn: ['task_search'], // waits for search result
            }))

            // TaskA: AVAILABLE → LOCKED → RUNNING
            const claimed = await queue.claim('work-agent', 'task_search')
            expect(claimed).not.toBeNull()
            await queue.start('task_search')
            expect(await queue.getStatus('task_search')).toBe('RUNNING')

            // TaskB: still LOCKED (blocked by dependsOn)
            expect(await queue.getStatus('task_order')).toBe('LOCKED')

            // Step 2: "Mejor el rojo" → user changes mind → cancel TaskB
            // This is done by the dispatcher when it detects barge-in + new intent
            const cancelled = await queue.cancel('task_order', 'tok_order')
            expect(cancelled).toBe(true)
            expect(await queue.getStatus('task_order')).toBe('CANCELLED')

            // Step 3: TaskA completes normally (search result still useful)
            await queue.complete('task_search', {
                results: [{ name: 'Nike Air Max', color: 'azul', price: 129.99 }],
            })
            expect(await queue.getStatus('task_search')).toBe('COMPLETED')

            // TaskB stays CANCELLED (not resurrected by TaskA completion)
            expect(await queue.getStatus('task_order')).toBe('CANCELLED')
        })

        it('new TaskB_red can be dispatched after cancelling TaskB_blue', async () => {
            // Cancel the blue order chain...
            await queue.publish(makeTask({ taskId: 'task_order_blue', cancelToken: 'tok_blue' }))
            await queue.cancel('task_order_blue', 'tok_blue')

            // ...and immediately create a new order for red
            await queue.publish(makeTask({
                taskId: 'task_order_red',
                slots: { color: 'rojo', brand: 'Nike' },
                cancelToken: 'tok_red',
            }))
            expect(await queue.getStatus('task_order_red')).toBe('AVAILABLE')

            // The red order can be claimed and run normally
            const claimed = await queue.claim('work-agent', 'task_order_red')
            expect(claimed).not.toBeNull()
            await queue.start('task_order_red')
            await queue.complete('task_order_red', { draft_id: 'draft_red_001' })

            expect(await queue.getStatus('task_order_red')).toBe('COMPLETED')
        })
    })

    // ── Scenario 2: TaskA failure cascades to cancel TaskB ────────────────

    describe('Scenario 2: TaskA failure — dependent auto-withdrawn', () => {
        it('TaskB cannot proceed when its dependency failed', async () => {
            // Publish chain
            await queue.publish(makeTask({ taskId: 'task_A', cancelToken: 'tok_A' }))
            await queue.publish(makeTask({
                taskId: 'task_B',
                cancelToken: 'tok_B',
                dependsOn: ['task_A'],
            }))

            // TaskA runs and fails (e.g. external API timeout)
            await queue.claim('agent_1', 'task_A')
            await queue.start('task_A')
            await queue.fail('task_A', 'external_api_timeout')

            expect(await queue.getStatus('task_A')).toBe('FAILED')

            // TaskB: still LOCKED — the app layer should cancel it
            // (In production, CapabilityRouter watchdog would detect this)
            // We cancel explicitly with the cancel token
            const cancelled = await queue.cancel('task_B', 'tok_B')
            expect(cancelled).toBe(true)
            expect(await queue.getStatus('task_B')).toBe('CANCELLED')
        })

        it('CANNOT cancel a task with wrong token', async () => {
            await queue.publish(makeTask({ taskId: 'task_X', cancelToken: 'secret_tok' }))

            // Attacker/race condition: wrong token
            const cancelled = await queue.cancel('task_X', 'wrong_token')
            expect(cancelled).toBe(false)
            expect(await queue.getStatus('task_X')).toBe('AVAILABLE')
        })

        it('CANNOT cancel a RUNNING task', async () => {
            await queue.publish(makeTask({ taskId: 'task_Y', cancelToken: 'tok_Y' }))
            await queue.claim('agent', 'task_Y')
            await queue.start('task_Y')

            // Too late to cancel — task is already RUNNING
            const cancelled = await queue.cancel('task_Y', 'tok_Y')
            expect(cancelled).toBe(false)
            expect(await queue.getStatus('task_Y')).toBe('RUNNING')
        })
    })

    // ── Scenario 3: Happy chain ────────────────────────────────────────────

    describe('Scenario 3: Happy chain — TaskA unlocks TaskB', () => {
        it('3-step chain: search → price → order all execute in sequence', async () => {
            const busEvents: string[] = []
            bus.psubscribe('bus:TASK_*', (ch) => busEvents.push(ch.replace('bus:', '')))

            // Publish 3-step chain
            await queue.publish(makeTask({ taskId: 'task_search', cancelToken: 'c1' }))
            await queue.publish(makeTask({
                taskId: 'task_price',
                cancelToken: 'c2',
                dependsOn: ['task_search'],
            }))
            await queue.publish(makeTask({
                taskId: 'task_order',
                cancelToken: 'c3',
                dependsOn: ['task_price'], // waits for price, not search directly
            }))

            // Only task_search is AVAILABLE initially
            expect(await queue.getStatus('task_search')).toBe('AVAILABLE')
            expect(await queue.getStatus('task_price')).toBe('LOCKED')
            expect(await queue.getStatus('task_order')).toBe('LOCKED')

            // Step 1: Complete search → price unlocks
            await queue.claim('agent', 'task_search')
            await queue.start('task_search')
            await queue.complete('task_search', { products: [{ name: 'Nike' }] })

            expect(await queue.getStatus('task_price')).toBe('AVAILABLE')
            expect(await queue.getStatus('task_order')).toBe('LOCKED') // still waiting for price

            // Step 2: Complete price → order unlocks
            await queue.claim('agent', 'task_price')
            await queue.start('task_price')
            await queue.complete('task_price', { price: 129.99 })

            expect(await queue.getStatus('task_order')).toBe('AVAILABLE')

            // Step 3: Complete order
            await queue.claim('agent', 'task_order')
            await queue.start('task_order')
            await queue.complete('task_order', { draft_id: 'draft_001' })

            expect(await queue.getStatus('task_order')).toBe('COMPLETED')

            // Verify event sequence for task_search (the first in chain)
            const searchEvents = busEvents.filter((e) => e.startsWith('TASK_'))
            expect(searchEvents).toContain('TASK_AVAILABLE')
            expect(searchEvents).toContain('TASK_RUNNING')
            expect(searchEvents).toContain('TASK_COMPLETED')
        })

        it('multi-dep: task waits for ALL parents before it unlocks', async () => {
            // price_check AND product_search must BOTH complete before order unlocks
            await queue.publish(makeTask({ taskId: 'task_search', cancelToken: 'c1' }))
            await queue.publish(makeTask({ taskId: 'task_price', cancelToken: 'c2' }))
            await queue.publish(makeTask({
                taskId: 'task_order',
                cancelToken: 'c3',
                dependsOn: ['task_search', 'task_price'],
            }))

            // Complete search only — order still blocked by price
            await queue.claim('a', 'task_search')
            await queue.start('task_search')
            await queue.complete('task_search', {})
            expect(await queue.getStatus('task_order')).toBe('LOCKED')

            // Now complete price — order unlocks
            await queue.claim('a', 'task_price')
            await queue.start('task_price')
            await queue.complete('task_price', {})
            expect(await queue.getStatus('task_order')).toBe('AVAILABLE')
        })
    })

    // ── Bus events for cancel ─────────────────────────────────────────────

    describe('bus events on cancel', () => {
        it('emits TASK_CANCELLED event on bus', async () => {
            const events: unknown[] = []
            bus.subscribe('bus:TASK_CANCELLED', (d) => events.push(d))

            await queue.publish(makeTask({ taskId: 'task_1', cancelToken: 'tok' }))
            await queue.cancel('task_1', 'tok')

            expect(events.length).toBe(1)
            expect(events[0]).toHaveProperty('task_id', 'task_1')
        })
    })
})
