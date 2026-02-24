/**
 * asynctools-only example
 *
 * Demonstrates AsyncAgent with a mock LLM agent that simulates:
 *  1. First turn: LLM requests 3 tool calls (async + sync + fire_forget)
 *  2. AsyncAgent dispatches them according to execution_mode
 *  3. Results are collected and re-injected
 *  4. Second turn: LLM composes a final answer
 */

import {
  AsyncAgent,
  ToolRegistry,
  ExecutorPool,
  InMemoryPendingStateTracker,
  registerFunctionHandler,
  type IInnerAgent,
  type Message,
  type AgentResponse,
} from '@fitalyagents/asynctools'

// ── Step 1: define a mock "LLM" that returns scripted responses ──────────────

class MockShoppingAgent implements IInnerAgent {
  private turn = 0

  async run(messages: Message[]): Promise<AgentResponse> {
    this.turn++
    console.log(`\n─── LLM Turn ${this.turn} (${messages.length} messages in context) ───`)

    if (this.turn === 1) {
      // First turn: request 3 tools in parallel
      console.log('  → LLM requests 3 tool calls...')
      return {
        tool_calls: [
          {
            id: 'tc_search',
            tool_id: 'product_search',
            input: { query: 'nike air max', size: 42 },
          },
          {
            id: 'tc_price',
            tool_id: 'price_checker',
            input: { sku: 'NIKE-AM90-42' },
          },
          {
            id: 'tc_log',
            tool_id: 'analytics_log',
            input: { event: 'search', user_id: 'u_123' },
          },
        ],
        stop_reason: 'tool_use',
      }
    }

    // Second turn: compose the final answer from injected results
    const toolMessages = messages.filter((m) => m.role === 'tool')
    console.log(`  → LLM received ${toolMessages.length} tool result(s), composing final answer...`)

    return {
      content:
        'Based on the search results, I found Nike Air Max in size 42 for €129.99. ' +
        'The item is in stock and ready to ship. Your search has been logged.',
      stop_reason: 'end_turn',
    }
  }
}

// ── Step 2: create the tool registry ────────────────────────────────────────

const registry = new ToolRegistry()

registry.registerMany([
  {
    tool_id: 'product_search',
    description: 'Search products by keyword and size',
    executor: { type: 'ts_fn' },
    execution_mode: 'async', // launches in background
    max_concurrent: 3,
    retry: { max_attempts: 2, backoff_ms: 100 },
    timeout_ms: 5_000,
  },
  {
    tool_id: 'price_checker',
    description: 'Get the current price for a SKU',
    executor: { type: 'ts_fn' },
    execution_mode: 'sync', // blocks until complete
    timeout_ms: 3_000,
  },
  {
    tool_id: 'analytics_log',
    description: 'Log a user event (fire and forget)',
    executor: { type: 'ts_fn' },
    execution_mode: 'fire_forget', // does NOT inject result
    timeout_ms: 2_000,
  },
])

// ── Step 3: register function handlers ──────────────────────────────────────

registerFunctionHandler('product_search', async (input) => {
  const { query, size } = input as { query: string; size: number }
  console.log(`  [product_search] Searching for "${query}" in size ${size}...`)
  await new Promise((r) => setTimeout(r, 80)) // simulate network delay
  return {
    results: [
      { name: 'Nike Air Max 90', sku: 'NIKE-AM90-42', in_stock: true },
      { name: 'Nike Air Zoom', sku: 'NIKE-AZ-42', in_stock: false },
    ],
  }
})

registerFunctionHandler('price_checker', (input) => {
  const { sku } = input as { sku: string }
  console.log(`  [price_checker] Checking price for SKU "${sku}"...`)
  // Synchronous — returns immediately
  return { sku, price: 129.99, currency: 'EUR' }
})

registerFunctionHandler('analytics_log', async (input) => {
  const { event, user_id } = input as { event: string; user_id: string }
  console.log(`  [analytics_log] Logging event "${event}" for user "${user_id}"`)
  await new Promise((r) => setTimeout(r, 20))
  return { logged: true }
})

// ── Step 4: create the AsyncAgent and run ───────────────────────────────────

async function main() {
  console.log('FitalyAgents — asynctools-only example')
  console.log('======================================\n')

  const pool = new ExecutorPool(registry)
  const tracker = new InMemoryPendingStateTracker()

  const agent = new AsyncAgent({
    inner: new MockShoppingAgent(),
    toolRegistry: registry,
    executorPool: pool,
    tracker,
    injectionStrategy: 'inject_when_all', // wait for ALL async tools
    globalTimeoutMs: 30_000,
    maxTurns: 5,
  })

  const startMs = Date.now()
  const response = await agent.run('Find me Nike Air Max shoes in size 42 and check the price.')
  const totalMs = Date.now() - startMs

  console.log('\n══════════════════════════════════════')
  console.log('FINAL RESPONSE:')
  console.log(response.content)
  console.log(`\nCompleted in ${totalMs}ms`)

  // Print execution stats
  console.log('\nExecution stats:')
  for (const tool of registry.list()) {
    const stats = pool.getStats(tool.tool_id)
    console.log(
      `  ${tool.tool_id.padEnd(20)} mode=${tool.execution_mode.padEnd(12)} ` +
        `completed=${stats.completed} failed=${stats.failed}`,
    )
  }
}

main().catch(console.error)
