import { randomUUID } from 'node:crypto'
import type { ToolRegistry } from '../registry/tool-registry.js'
import type { ExecutorPool } from '../executor/executor-pool.js'
import type { IPendingStateTracker } from '../tracking/types.js'
import { InjectionManager } from '../injection/injection-manager.js'
import type {
  IInnerAgent,
  Message,
  AgentResponse,
  InjectionStrategy,
  ToolCallRequest,
} from '../types/index.js'

export interface AsyncAgentOptions {
  /** The inner LLM agent to wrap. Must implement `run(messages: Message[]): Promise<AgentResponse>`. */
  inner: IInnerAgent
  /** Tool registry with all available tools. */
  toolRegistry: ToolRegistry
  /** Executor pool for running tools. */
  executorPool: ExecutorPool
  /** State tracker for managing pending tool calls. */
  tracker: IPendingStateTracker
  /** When to inject async results back. Default: 'inject_when_all'. */
  injectionStrategy?: InjectionStrategy
  /** Maximum time for the entire agent run. Default: 60000ms. */
  globalTimeoutMs?: number
  /** Maximum number of tool-use loops to prevent infinite recursion. Default: 10. */
  maxTurns?: number
}

/**
 * AsyncAgent wraps any LLM agent to add async parallel tool execution.
 *
 * It intercepts `tool_calls` from the LLM response, dispatches them according
 * to their `execution_mode`, waits for results based on the injection strategy,
 * and re-injects results for the LLM to continue.
 *
 * @example
 * ```typescript
 * const agent = new AsyncAgent({
 *   inner: myOpenAIAgent,
 *   toolRegistry: registry,
 *   executorPool: pool,
 *   tracker: new InMemoryPendingStateTracker(),
 *   injectionStrategy: 'inject_when_all',
 *   globalTimeoutMs: 30000,
 * })
 *
 * const response = await agent.run('Search for Nike shoes in size 42')
 * console.log(response.content) // "I found 3 Nike shoes..."
 * ```
 */
export class AsyncAgent {
  private inner: IInnerAgent
  private toolRegistry: ToolRegistry
  private executorPool: ExecutorPool
  private tracker: IPendingStateTracker
  private injectionManager: InjectionManager
  private strategy: InjectionStrategy
  private globalTimeoutMs: number
  private maxTurns: number

  constructor(options: AsyncAgentOptions) {
    this.inner = options.inner
    this.toolRegistry = options.toolRegistry
    this.executorPool = options.executorPool
    this.tracker = options.tracker
    this.injectionManager = new InjectionManager(options.tracker)
    this.strategy = options.injectionStrategy ?? 'inject_when_all'
    this.globalTimeoutMs = options.globalTimeoutMs ?? 60_000
    this.maxTurns = options.maxTurns ?? 10
  }

  /**
   * Run the agent with the given user message or conversation history.
   * Handles the full tool-call loop: detect → dispatch → wait → re-inject → repeat.
   *
   * @param input - User message string or existing message array
   * @returns The final AgentResponse after all tool calls are resolved
   */
  async run(input: string | Message[]): Promise<AgentResponse> {
    const messages: Message[] =
      typeof input === 'string' ? [{ role: 'user', content: input }] : [...input]

    let turnsLeft = this.maxTurns

    // Global timeout
    const controller = new AbortController()
    const globalTimer = setTimeout(() => controller.abort(), this.globalTimeoutMs)
    if (typeof globalTimer === 'object' && 'unref' in globalTimer) {
      globalTimer.unref()
    }

    try {
      while (turnsLeft > 0) {
        // Check global timeout
        if (controller.signal.aborted) {
          return {
            content: 'Agent run timed out.',
            stop_reason: 'max_tokens',
          }
        }

        // Call the inner agent
        const response = await this.inner.run(messages)

        // If no tool calls, we're done
        if (!response.tool_calls || response.tool_calls.length === 0) {
          return response
        }

        // Add assistant message with tool_calls to history
        if (response.content) {
          messages.push({ role: 'assistant', content: response.content })
        }

        // Process tool calls based on their execution mode
        const turnId = randomUUID()
        const asyncCalls: ToolCallRequest[] = []
        const syncResults: Message[] = []

        for (const toolCall of response.tool_calls) {
          const toolDef = this.toolRegistry.get(toolCall.tool_id)
          const mode = toolDef?.execution_mode ?? 'async'

          switch (mode) {
            case 'sync': {
              // Execute immediately and block
              const result = await this.executorPool.execute(
                toolCall.tool_id,
                toolCall.id,
                toolCall.input,
              )
              syncResults.push({
                role: 'tool',
                content: JSON.stringify({
                  status: result.status,
                  result: result.result ?? null,
                  error: result.error ?? null,
                  duration_ms: result.duration_ms,
                }),
                tool_call_id: toolCall.id,
              })
              break
            }

            case 'async':
            case 'deferred':
              asyncCalls.push(toolCall)
              break

            case 'fire_forget':
              // Launch but don't track or inject
              this.executorPool.execute(toolCall.tool_id, toolCall.id, toolCall.input).catch(() => {
                /* intentionally swallowed */
              })
              break
          }
        }

        // Add sync results immediately
        messages.push(...syncResults)

        // Handle async calls via the tracker
        if (asyncCalls.length > 0) {
          this.tracker.createTurn(turnId, 'async-agent', this.strategy, this.globalTimeoutMs)

          for (const toolCall of asyncCalls) {
            this.tracker.addPending(turnId, toolCall.id, toolCall.tool_id, toolCall.input)
            this.tracker.markRunning(turnId, toolCall.id)

            // Launch execution in background
            this.executorPool
              .execute(toolCall.tool_id, toolCall.id, toolCall.input)
              .then((result) => {
                if (result.status === 'completed') {
                  this.tracker.markCompleted(turnId, toolCall.id, result)
                } else {
                  this.tracker.markFailed(turnId, toolCall.id, result.error ?? 'Unknown error')
                }
              })
              .catch((err) => {
                this.tracker.markFailed(
                  turnId,
                  toolCall.id,
                  err instanceof Error ? err.message : String(err),
                )
              })
          }

          // Wait for resolution
          const results = await this.injectionManager.waitForResolution(turnId)
          const resultMessages = this.injectionManager.formatForReinjection(results)
          messages.push(...resultMessages)

          // Cleanup
          this.tracker.deleteTurn(turnId)
        }

        // If we only had sync results and no async, continue loop
        // (the sync results are already in messages)
        turnsLeft--
      }

      // Exhausted max turns
      return {
        content: 'Agent reached maximum number of tool-use turns.',
        stop_reason: 'max_tokens',
      }
    } finally {
      clearTimeout(globalTimer)
      this.injectionManager.dispose()
    }
  }

  /**
   * Create an AsyncAgent from a raw function.
   */
  static fromFunction(
    fn: (messages: Message[]) => Promise<AgentResponse>,
    options: Omit<AsyncAgentOptions, 'inner'>,
  ): AsyncAgent {
    return new AsyncAgent({
      ...options,
      inner: { run: fn },
    })
  }
}
