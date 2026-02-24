import type { ToolRegistry } from '../registry/tool-registry.js'
import type { ToolResult, ExecutorStats } from '../types/index.js'
import type { IExecutor } from './types.js'
import { HttpExecutor } from './http-executor.js'
import { FunctionExecutor } from './function-executor.js'
import { SubprocessExecutor } from './subprocess-executor.js'
import { ToolExecutionError } from '../errors.js'

interface QueuedTask {
  resolve: (result: ToolResult) => void
  reject: (error: Error) => void
  toolId: string
  toolCallId: string
  input: unknown
}

interface ToolStats {
  executing: number
  queued: number
  completed: number
  failed: number
}

/**
 * Manages concurrent execution of tools with per-tool concurrency limits,
 * automatic retry with exponential backoff, and timeout via AbortController.
 *
 * Each tool gets its own execution queue, bounded by `max_concurrent` from
 * the ToolDefinition. Excess invocations are queued and processed FIFO.
 *
 * @example
 * ```typescript
 * const registry = new ToolRegistry()
 * registry.register({ tool_id: 'search', executor: { type: 'http', url: '...' }, max_concurrent: 3 })
 *
 * const pool = new ExecutorPool(registry)
 * const result = await pool.execute('search', 'call_1', { query: 'nike' })
 * console.log(result.status) // 'completed'
 * ```
 */
export class ExecutorPool {
  private executors: Map<string, IExecutor> = new Map()
  private queues: Map<string, QueuedTask[]> = new Map()
  private stats: Map<string, ToolStats> = new Map()

  constructor(private registry: ToolRegistry) {
    // Pre-create executors for each registered tool
    for (const tool of registry.list()) {
      this.ensureExecutor(tool.executor.type)
      this.ensureStats(tool.tool_id)
    }
  }

  /**
   * Execute a tool by its ID with automatic concurrency control, retry, and timeout.
   *
   * @param toolId     - The registered tool ID to execute
   * @param toolCallId - Unique ID for this specific invocation (for tracking)
   * @param input      - The input payload for the tool
   * @returns A `ToolResult` with status, result/error, and timing info
   */
  async execute(toolId: string, toolCallId: string, input: unknown): Promise<ToolResult> {
    const toolDef = this.registry.getOrThrow(toolId)
    this.ensureExecutor(toolDef.executor.type)
    this.ensureStats(toolId)

    const stats = this.stats.get(toolId)!

    // Check if we can execute immediately or must queue
    if (stats.executing < toolDef.max_concurrent) {
      return this.executeNow(toolId, toolCallId, input)
    }

    // Queue the task and return a promise that resolves when it runs
    return new Promise<ToolResult>((resolve, reject) => {
      const queue = this.queues.get(toolId) ?? []
      queue.push({ resolve, reject, toolId, toolCallId, input })
      this.queues.set(toolId, queue)
      stats.queued++
    })
  }

  /**
   * Get execution statistics for a specific tool.
   */
  getStats(toolId: string): ExecutorStats {
    const stats = this.stats.get(toolId)
    if (!stats) {
      return { executing: 0, queued: 0, completed: 0, failed: 0 }
    }
    return { ...stats }
  }

  // ── Private ───────────────────────────────────────────────────────────

  private async executeNow(
    toolId: string,
    toolCallId: string,
    input: unknown,
  ): Promise<ToolResult> {
    const toolDef = this.registry.getOrThrow(toolId)
    const executor = this.executors.get(toolDef.executor.type)!
    const stats = this.stats.get(toolId)!
    const startedAt = Date.now()

    stats.executing++

    try {
      const result = await this.executeWithRetry(executor, toolId, toolCallId, input)

      const completedAt = Date.now()
      stats.executing--
      stats.completed++

      this.drainQueue(toolId)

      return {
        tool_call_id: toolCallId,
        tool_id: toolId,
        status: 'completed',
        result,
        started_at: startedAt,
        completed_at: completedAt,
        duration_ms: completedAt - startedAt,
      }
    } catch (error) {
      const completedAt = Date.now()
      stats.executing--
      stats.failed++

      this.drainQueue(toolId)

      return {
        tool_call_id: toolCallId,
        tool_id: toolId,
        status: 'failed',
        error: error instanceof Error ? error.message : String(error),
        started_at: startedAt,
        completed_at: completedAt,
        duration_ms: completedAt - startedAt,
      }
    }
  }

  private async executeWithRetry(
    executor: IExecutor,
    toolId: string,
    _toolCallId: string,
    input: unknown,
  ): Promise<unknown> {
    const toolDef = this.registry.getOrThrow(toolId)
    const maxAttempts = toolDef.retry.max_attempts
    const backoffMs = toolDef.retry.backoff_ms

    let lastError: Error | null = null

    for (let attempt = 1; attempt <= maxAttempts; attempt++) {
      // Create AbortController for timeout
      const controller = new AbortController()
      const timeoutId = setTimeout(() => controller.abort(), toolDef.timeout_ms)

      try {
        // Wrap input with executor config
        const wrappedInput = {
          __executor_config: toolDef.executor,
          __payload: input,
        }

        const result = await executor.execute(toolId, wrappedInput, controller.signal)
        clearTimeout(timeoutId)
        return result
      } catch (error) {
        clearTimeout(timeoutId)
        lastError = error instanceof Error ? error : new Error(String(error))

        // Check if aborted (timeout)
        if (controller.signal.aborted) {
          lastError = new Error(`Tool "${toolId}" timed out after ${toolDef.timeout_ms}ms`)
        }

        // Don't retry if this was the last attempt
        if (attempt < maxAttempts) {
          // Exponential backoff: backoff_ms * 2^(attempt-1)
          const delay = backoffMs * Math.pow(2, attempt - 1)
          await this.sleep(delay)
        }
      }
    }

    throw new ToolExecutionError(toolId, lastError!, maxAttempts)
  }

  private drainQueue(toolId: string): void {
    const queue = this.queues.get(toolId)
    if (!queue || queue.length === 0) return

    const toolDef = this.registry.getOrThrow(toolId)
    const stats = this.stats.get(toolId)!

    while (queue.length > 0 && stats.executing < toolDef.max_concurrent) {
      const task = queue.shift()!
      stats.queued--

      // Execute asynchronously, resolve/reject the queued promise
      this.executeNow(task.toolId, task.toolCallId, task.input).then(task.resolve, task.reject)
    }
  }

  private ensureExecutor(type: string): void {
    if (this.executors.has(type)) return

    switch (type) {
      case 'http':
        this.executors.set('http', new HttpExecutor())
        break
      case 'ts_fn':
        this.executors.set('ts_fn', new FunctionExecutor())
        break
      case 'subprocess':
        this.executors.set('subprocess', new SubprocessExecutor())
        break
      default:
        throw new Error(`Unknown executor type: ${type}`)
    }
  }

  private ensureStats(toolId: string): void {
    if (!this.stats.has(toolId)) {
      this.stats.set(toolId, { executing: 0, queued: 0, completed: 0, failed: 0 })
    }
  }

  private sleep(ms: number): Promise<void> {
    return new Promise((resolve) => setTimeout(resolve, ms))
  }
}
