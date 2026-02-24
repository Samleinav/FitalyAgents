import { describe, it, expect, beforeEach, afterEach } from 'vitest'
import { AsyncAgent } from './async-agent.js'
import { ToolRegistry } from '../registry/tool-registry.js'
import { ExecutorPool } from '../executor/executor-pool.js'
import { InMemoryPendingStateTracker } from '../tracking/in-memory-tracker.js'
import { registerFunctionHandler, clearFunctionHandlers } from '../executor/function-executor.js'
import type { IInnerAgent, Message, AgentResponse } from '../types/index.js'

// ── Mock LLM Agent ──────────────────────────────────────────────────────────

class MockLLM implements IInnerAgent {
  private responses: AgentResponse[]
  private callIndex = 0

  constructor(responses: AgentResponse[]) {
    this.responses = responses
  }

  async run(_messages: Message[]): Promise<AgentResponse> {
    const response = this.responses[this.callIndex] ?? {
      content: 'No more responses',
      stop_reason: 'end_turn' as const,
    }
    this.callIndex++
    return response
  }

  get callCount(): number {
    return this.callIndex
  }
}

// ── Tests ───────────────────────────────────────────────────────────────────

describe('AsyncAgent', () => {
  let registry: ToolRegistry
  let pool: ExecutorPool
  let tracker: InMemoryPendingStateTracker

  beforeEach(() => {
    registry = new ToolRegistry()
    clearFunctionHandlers()
  })

  afterEach(() => {
    clearFunctionHandlers()
  })

  function createAgent(
    llm: IInnerAgent,
    opts?: { strategy?: 'inject_when_all' | 'inject_when_ready'; globalTimeoutMs?: number },
  ): AsyncAgent {
    pool = new ExecutorPool(registry)
    tracker = new InMemoryPendingStateTracker()
    return new AsyncAgent({
      inner: llm,
      toolRegistry: registry,
      executorPool: pool,
      tracker,
      injectionStrategy: opts?.strategy ?? 'inject_when_all',
      globalTimeoutMs: opts?.globalTimeoutMs ?? 30_000,
    })
  }

  // ── Simple: No tool calls ──────────────────────────────────────────────

  it('returns response directly when no tool calls', async () => {
    const llm = new MockLLM([{ content: 'Hello!', stop_reason: 'end_turn' }])
    const agent = createAgent(llm)

    const response = await agent.run('hi')
    expect(response.content).toBe('Hello!')
    expect(response.stop_reason).toBe('end_turn')
  })

  // ── 2 async tools, inject_when_all ──────────────────────────────────────

  it('handles 2 parallel async tool calls with inject_when_all', async () => {
    registry.register({
      tool_id: 'search',
      executor: { type: 'ts_fn' },
      execution_mode: 'async',
    })
    registry.register({
      tool_id: 'inventory',
      executor: { type: 'ts_fn' },
      execution_mode: 'async',
    })

    registerFunctionHandler('search', async () => {
      await new Promise((r) => setTimeout(r, 30))
      return { products: ['Nike Air Max'] }
    })
    registerFunctionHandler('inventory', async () => {
      await new Promise((r) => setTimeout(r, 20))
      return { stock: 42 }
    })

    const llm = new MockLLM([
      // First call: LLM requests 2 tools
      {
        tool_calls: [
          { id: 'tc_1', tool_id: 'search', input: { query: 'nike' } },
          { id: 'tc_2', tool_id: 'inventory', input: { sku: 'AM90' } },
        ],
        stop_reason: 'tool_use',
      },
      // Second call: LLM gets results and responds
      {
        content: 'Found Nike Air Max with 42 in stock.',
        stop_reason: 'end_turn',
      },
    ])

    const agent = createAgent(llm)
    const response = await agent.run('Find Nike shoes')

    expect(response.content).toBe('Found Nike Air Max with 42 in stock.')
    expect(llm.callCount).toBe(2)
  })

  // ── Sync tool ─────────────────────────────────────────────────────────

  it('handles sync tool call — blocks and injects immediately', async () => {
    registry.register({
      tool_id: 'calc',
      executor: { type: 'ts_fn' },
      execution_mode: 'sync',
    })

    registerFunctionHandler('calc', (input) => {
      const { a, b } = input as { a: number; b: number }
      return { result: a + b }
    })

    const llm = new MockLLM([
      {
        tool_calls: [{ id: 'tc_calc', tool_id: 'calc', input: { a: 5, b: 3 } }],
        stop_reason: 'tool_use',
      },
      {
        content: 'The sum is 8.',
        stop_reason: 'end_turn',
      },
    ])

    const agent = createAgent(llm)
    const response = await agent.run('What is 5+3?')

    expect(response.content).toBe('The sum is 8.')
    expect(llm.callCount).toBe(2)
  })

  // ── fire_forget ───────────────────────────────────────────────────────

  it('fire_forget tool executes but result is NOT injected', async () => {
    let logExecuted = false

    registry.register({
      tool_id: 'log_event',
      executor: { type: 'ts_fn' },
      execution_mode: 'fire_forget',
    })

    registerFunctionHandler('log_event', () => {
      logExecuted = true
      return { logged: true }
    })

    const llm = new MockLLM([
      {
        tool_calls: [{ id: 'tc_log', tool_id: 'log_event', input: { event: 'search' } }],
        stop_reason: 'tool_use',
      },
      // LLM is called again immediately without waiting for log_event
      {
        content: 'Done! Event was logged.',
        stop_reason: 'end_turn',
      },
    ])

    const agent = createAgent(llm)
    const response = await agent.run('Log this search')

    expect(response.content).toBe('Done! Event was logged.')
    // Allow the fire_forget to complete
    await new Promise((r) => setTimeout(r, 50))
    expect(logExecuted).toBe(true)
  })

  // ── Mixed modes ───────────────────────────────────────────────────────

  it('handles mixed modes: 1 sync, 1 async, 1 fire_forget', async () => {
    let fireForgetDone = false

    registry.register({
      tool_id: 'sync_calc',
      executor: { type: 'ts_fn' },
      execution_mode: 'sync',
    })
    registry.register({
      tool_id: 'async_search',
      executor: { type: 'ts_fn' },
      execution_mode: 'async',
    })
    registry.register({
      tool_id: 'ff_log',
      executor: { type: 'ts_fn' },
      execution_mode: 'fire_forget',
    })

    registerFunctionHandler('sync_calc', () => ({ sum: 10 }))
    registerFunctionHandler('async_search', async () => {
      await new Promise((r) => setTimeout(r, 20))
      return { found: true }
    })
    registerFunctionHandler('ff_log', () => {
      fireForgetDone = true
      return {}
    })

    const llm = new MockLLM([
      {
        tool_calls: [
          { id: 'tc_sync', tool_id: 'sync_calc', input: {} },
          { id: 'tc_async', tool_id: 'async_search', input: { q: 'test' } },
          { id: 'tc_ff', tool_id: 'ff_log', input: { action: 'mixed' } },
        ],
        stop_reason: 'tool_use',
      },
      {
        content: 'All done: sum=10, found=true, logged.',
        stop_reason: 'end_turn',
      },
    ])

    const agent = createAgent(llm)
    const response = await agent.run('Do everything')

    expect(response.content).toBe('All done: sum=10, found=true, logged.')
    await new Promise((r) => setTimeout(r, 50))
    expect(fireForgetDone).toBe(true)
  })

  // ── Tool failure ──────────────────────────────────────────────────────

  it('continues gracefully when a tool fails', async () => {
    registry.register({
      tool_id: 'good_tool',
      executor: { type: 'ts_fn' },
      execution_mode: 'async',
    })
    registry.register({
      tool_id: 'bad_tool',
      executor: { type: 'ts_fn' },
      execution_mode: 'async',
    })

    registerFunctionHandler('good_tool', () => ({ ok: true }))
    registerFunctionHandler('bad_tool', () => {
      throw new Error('Connection refused')
    })

    const llm = new MockLLM([
      {
        tool_calls: [
          { id: 'tc_good', tool_id: 'good_tool', input: {} },
          { id: 'tc_bad', tool_id: 'bad_tool', input: {} },
        ],
        stop_reason: 'tool_use',
      },
      {
        content: 'One tool succeeded, one failed. Continuing.',
        stop_reason: 'end_turn',
      },
    ])

    const agent = createAgent(llm)
    const response = await agent.run('Try both')

    expect(response.content).toBe('One tool succeeded, one failed. Continuing.')
    expect(llm.callCount).toBe(2)
  })
})
