import { describe, it, expect, beforeEach, afterEach } from 'vitest'
import { InMemoryBus } from 'fitalyagents'
import { WorkAgent } from './work-agent.js'
import { MockToolExecutor } from './mock-tool-executor.js'

/**
 * Standard mock tools for the retail domain.
 */
function createRetailTools() {
    return new MockToolExecutor({
        latencyMs: 5,
        tools: [
            {
                tool_id: 'product_search',
                description: 'Search products by brand, size, color',
                handler: async (input) => ({
                    results: [
                        { name: 'Nike Air Max 90', size: input.size ?? 42, color: input.color ?? 'blue', price: 129.99 },
                        { name: 'Nike Dunk Low', size: input.size ?? 42, color: input.color ?? 'white', price: 109.99 },
                    ],
                    total: 2,
                    query: input,
                }),
            },
            {
                tool_id: 'price_check',
                description: 'Check current price with discounts',
                handler: async (input) => ({
                    brand: input.brand ?? 'Nike',
                    base_price: 129.99,
                    discount_percent: 15,
                    final_price: 110.49,
                    currency: 'USD',
                }),
            },
            {
                tool_id: 'order_query',
                description: 'Query order history',
                handler: async (input) => ({
                    orders: [
                        { order_id: 'ORD-001', status: 'delivered', total: 129.99, date: '2025-12-10' },
                    ],
                    customer_id: input.customer_id ?? 'unknown',
                }),
            },
            {
                tool_id: 'calculate',
                description: 'Simple calculation',
                handler: async (input) => ({
                    expression: input.expression ?? '0',
                    result: eval(String(input.expression ?? '0')),
                }),
            },
        ],
    })
}

describe('WorkAgent', () => {
    let bus: InMemoryBus
    let toolExecutor: MockToolExecutor
    let agent: WorkAgent

    beforeEach(async () => {
        bus = new InMemoryBus()
        toolExecutor = createRetailTools()

        agent = new WorkAgent({
            bus,
            toolExecutor,
        })

        await agent.start()
    })

    afterEach(async () => {
        await agent.shutdown()
    })

    // ── Single tool execution ─────────────────────────────────────────────

    describe('single tool execution', () => {
        it('executes product_search for product_search intent', async () => {
            const result = await agent.process({
                event: 'TASK_PAYLOAD',
                task_id: 'task_001',
                session_id: 'sess_1',
                intent_id: 'product_search',
                slots: { brand: 'Nike', size: 42, color: 'blue' },
                context_snapshot: {},
                cancel_token: null,
                timeout_ms: 8000,
                reply_to: 'queue:work-agent:outbox',
            })

            expect(result.status).toBe('completed')
            expect(result.result).toHaveProperty('results')
            const resultObj = result.result as Record<string, unknown>
            const results = resultObj.results as Array<Record<string, unknown>>
            expect(results.length).toBe(2)
            expect(results[0]).toHaveProperty('name', 'Nike Air Max 90')
        })

        it('executes price_check for price_query intent', async () => {
            const result = await agent.process({
                event: 'TASK_PAYLOAD',
                task_id: 'task_002',
                session_id: 'sess_1',
                intent_id: 'price_query',
                slots: { brand: 'Nike' },
                context_snapshot: {},
                cancel_token: null,
                timeout_ms: 8000,
                reply_to: 'queue:work-agent:outbox',
            })

            expect(result.status).toBe('completed')
            expect(result.result).toHaveProperty('final_price', 110.49)
        })

        it('executes order_query', async () => {
            const result = await agent.process({
                event: 'TASK_PAYLOAD',
                task_id: 'task_003',
                session_id: 'sess_1',
                intent_id: 'order_query',
                slots: { customer_id: 'cust_42' },
                context_snapshot: {},
                cancel_token: null,
                timeout_ms: 8000,
                reply_to: 'queue:work-agent:outbox',
            })

            expect(result.status).toBe('completed')
            const resultObj = result.result as Record<string, unknown>
            expect(resultObj.customer_id).toBe('cust_42')
        })
    })

    // ── Parallel execution (inject_when_all) ──────────────────────────────

    describe('parallel execution (inject_when_all)', () => {
        it('executes product_search + price_check in parallel', async () => {
            const result = await agent.process({
                event: 'TASK_PAYLOAD',
                task_id: 'task_parallel',
                session_id: 'sess_1',
                intent_id: 'product_search_with_price',
                slots: { brand: 'Nike', size: 42, color: 'blue' },
                context_snapshot: {},
                cancel_token: null,
                timeout_ms: 8000,
                reply_to: 'queue:work-agent:outbox',
            })

            expect(result.status).toBe('completed')

            // Both tool results should be present
            const resultObj = result.result as Record<string, unknown>
            expect(resultObj).toHaveProperty('product_search')
            expect(resultObj).toHaveProperty('price_check')
            expect(resultObj).toHaveProperty('text')

            // Product search results
            const searchResult = resultObj.product_search as Record<string, unknown>
            expect(searchResult).toHaveProperty('results')

            // Price check results
            const priceResult = resultObj.price_check as Record<string, unknown>
            expect(priceResult).toHaveProperty('final_price', 110.49)
        })

        it('both tools executed in parallel (not sequential)', async () => {
            // Use a longer latency to make timing differences observable
            const slowExecutor = new MockToolExecutor({
                latencyMs: 50,
                tools: [
                    {
                        tool_id: 'product_search',
                        description: 'Slow search',
                        handler: async () => ({ results: [] }),
                    },
                    {
                        tool_id: 'price_check',
                        description: 'Slow price',
                        handler: async () => ({ price: 99 }),
                    },
                ],
            })

            const parallelAgent = new WorkAgent({
                bus,
                toolExecutor: slowExecutor,
            })

            const start = Date.now()
            const result = await parallelAgent.process({
                event: 'TASK_PAYLOAD',
                task_id: 'task_timing',
                session_id: 'sess_1',
                intent_id: 'product_search_with_price',
                slots: {},
                context_snapshot: {},
                cancel_token: null,
                timeout_ms: 8000,
                reply_to: 'queue:work-agent:outbox',
            })
            const elapsed = Date.now() - start

            expect(result.status).toBe('completed')
            // If sequential: ~100ms. If parallel: ~50ms.
            // Allow generous margin but it should be well under 100ms
            expect(elapsed).toBeLessThan(90)
        })

        it('context_patch records parallel execution', async () => {
            const result = await agent.process({
                event: 'TASK_PAYLOAD',
                task_id: 'task_ctx',
                session_id: 'sess_1',
                intent_id: 'product_search_with_price',
                slots: {},
                context_snapshot: {},
                cancel_token: null,
                timeout_ms: 8000,
                reply_to: 'queue:work-agent:outbox',
            })

            const lastAction = result.context_patch.last_action as Record<string, unknown>
            expect(lastAction.type).toBe('WORK_COMPLETED')
            expect(lastAction.parallel).toBe(true)
            expect(lastAction.tools_executed).toEqual(['product_search', 'price_check'])
        })
    })

    // ── ACTION_COMPLETED event ────────────────────────────────────────────

    describe('ACTION_COMPLETED event', () => {
        it('publishes ACTION_COMPLETED after work is done', async () => {
            const events: unknown[] = []
            bus.subscribe('bus:ACTION_COMPLETED', (data) => events.push(data))

            await agent.process({
                event: 'TASK_PAYLOAD',
                task_id: 'task_action',
                session_id: 'sess_1',
                intent_id: 'product_search',
                slots: { brand: 'Nike' },
                context_snapshot: {},
                cancel_token: null,
                timeout_ms: 8000,
                reply_to: 'queue:work-agent:outbox',
            })

            expect(events.length).toBe(1)
            const event = events[0] as Record<string, unknown>
            expect(event.agent_id).toBe('work-agent-001')
            expect(event.intent_id).toBe('product_search')
            expect(event.session_id).toBe('sess_1')
        })
    })

    // ── Error handling ────────────────────────────────────────────────────

    describe('error handling', () => {
        it('returns failed for unknown intent', async () => {
            const result = await agent.process({
                event: 'TASK_PAYLOAD',
                task_id: 'task_err',
                session_id: 'sess_1',
                intent_id: 'unknown_intent',
                slots: {},
                context_snapshot: {},
                cancel_token: null,
                timeout_ms: 8000,
                reply_to: 'queue:work-agent:outbox',
            })

            expect(result.status).toBe('failed')
            expect(result.error).toContain('No tools mapped for intent')
        })

        it('returns failed when tool execution fails', async () => {
            const failingExecutor = new MockToolExecutor({
                tools: [
                    {
                        tool_id: 'product_search',
                        description: 'Always fails',
                        handler: async () => { throw new Error('DB connection lost') },
                    },
                ],
            })

            const failAgent = new WorkAgent({
                bus,
                toolExecutor: failingExecutor,
            })

            const result = await failAgent.process({
                event: 'TASK_PAYLOAD',
                task_id: 'task_fail',
                session_id: 'sess_1',
                intent_id: 'product_search',
                slots: {},
                context_snapshot: {},
                cancel_token: null,
                timeout_ms: 8000,
                reply_to: 'queue:work-agent:outbox',
            })

            expect(result.status).toBe('failed')
            expect(result.error).toContain('DB connection lost')
        })

        it('partial success in parallel returns completed with error info', async () => {
            const mixedExecutor = new MockToolExecutor({
                tools: [
                    {
                        tool_id: 'product_search',
                        description: 'Works',
                        handler: async () => ({ results: ['item1'] }),
                    },
                    {
                        tool_id: 'price_check',
                        description: 'Fails',
                        handler: async () => { throw new Error('Price API down') },
                    },
                ],
            })

            const mixedAgent = new WorkAgent({
                bus,
                toolExecutor: mixedExecutor,
            })

            const result = await mixedAgent.process({
                event: 'TASK_PAYLOAD',
                task_id: 'task_partial',
                session_id: 'sess_1',
                intent_id: 'product_search_with_price',
                slots: {},
                context_snapshot: {},
                cancel_token: null,
                timeout_ms: 8000,
                reply_to: 'queue:work-agent:outbox',
            })

            // Should still complete (partial success)
            expect(result.status).toBe('completed')
            const resultObj = result.result as Record<string, unknown>
            expect(resultObj.product_search).toEqual({ results: ['item1'] })
            expect(resultObj.price_check).toHaveProperty('error', 'Price API down')
        })
    })

    // ── Slot merging ──────────────────────────────────────────────────────

    describe('slot merging', () => {
        it('merges task slots into tool inputs', async () => {
            await agent.process({
                event: 'TASK_PAYLOAD',
                task_id: 'task_slots',
                session_id: 'sess_1',
                intent_id: 'product_search',
                slots: { brand: 'Adidas', size: 44, color: 'red' },
                context_snapshot: {},
                cancel_token: null,
                timeout_ms: 8000,
                reply_to: 'queue:work-agent:outbox',
            })

            // Check the executor log
            expect(toolExecutor.executionLog.length).toBe(1)
            const req = toolExecutor.executionLog[0]!.request
            expect(req.input).toMatchObject({ brand: 'Adidas', size: 44, color: 'red' })
        })
    })

    // ── Lifecycle ─────────────────────────────────────────────────────────

    describe('lifecycle', () => {
        it('publishes AGENT_DEREGISTERED on shutdown', async () => {
            const events: unknown[] = []
            bus.subscribe('bus:AGENT_DEREGISTERED', (data) => events.push(data))

            await agent.shutdown()

            expect(events.length).toBe(1)
            expect(events[0]).toHaveProperty('agent_id', 'work-agent-001')
        })
    })
})
