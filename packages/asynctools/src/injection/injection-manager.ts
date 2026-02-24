import type { IPendingStateTracker } from '../tracking/types.js'
import type { ToolResult, Message } from '../types/index.js'

/**
 * Manages the injection of async tool results back into the agent conversation.
 *
 * Watches turns for resolution (based on injection strategy) and formats
 * results as tool_result messages ready for re-injection into the LLM.
 *
 * @example
 * ```typescript
 * const manager = new InjectionManager(tracker)
 * manager.watchTurn('turn_1', (results) => {
 *   const messages = manager.formatForReinjection(results)
 *   agent.run(messages)
 * })
 * ```
 */
export class InjectionManager {
  private watchers: Map<string, ReturnType<typeof setInterval>> = new Map()

  constructor(private tracker: IPendingStateTracker) {}

  /**
   * Watch a turn for resolution. When the turn resolves (according to its
   * injection strategy), the `onReady` callback is called with the results.
   *
   * @param turnId  - The turn ID to watch
   * @param onReady - Callback invoked when the turn resolves
   * @param pollIntervalMs - How often to check resolution (default 50ms)
   */
  watchTurn(turnId: string, onReady: (results: ToolResult[]) => void, pollIntervalMs = 50): void {
    // Avoid duplicate watchers
    if (this.watchers.has(turnId)) return

    const interval = setInterval(() => {
      if (this.tracker.isResolved(turnId)) {
        clearInterval(interval)
        this.watchers.delete(turnId)
        const results = this.tracker.getResults(turnId)
        onReady(results)
      }
    }, pollIntervalMs)

    // Don't block process exit
    if (typeof interval === 'object' && 'unref' in interval) {
      interval.unref()
    }

    this.watchers.set(turnId, interval)
  }

  /**
   * Wait for a turn to resolve. Returns a Promise that resolves with the results.
   *
   * @param turnId - The turn ID to wait for
   * @param pollIntervalMs - How often to check resolution (default 50ms)
   */
  waitForResolution(turnId: string, pollIntervalMs = 50): Promise<ToolResult[]> {
    return new Promise((resolve) => {
      this.watchTurn(turnId, resolve, pollIntervalMs)
    })
  }

  /**
   * Format tool results as `Message[]` for re-injection into the LLM.
   * Each result becomes a `{ role: 'tool', content: ..., tool_call_id: ... }` message.
   */
  formatForReinjection(results: ToolResult[]): Message[] {
    return results.map((result) => ({
      role: 'tool' as const,
      content: JSON.stringify({
        status: result.status,
        result: result.result ?? null,
        error: result.error ?? null,
        duration_ms: result.duration_ms,
      }),
      tool_call_id: result.tool_call_id,
    }))
  }

  /**
   * Cancel a turn watcher and mark all pending tool calls as timed out.
   */
  cancelTurn(turnId: string): void {
    const interval = this.watchers.get(turnId)
    if (interval) {
      clearInterval(interval)
      this.watchers.delete(turnId)
    }

    // Mark all pending calls as timed out
    const pending = this.tracker.getPending(turnId)
    for (const toolCallId of pending) {
      this.tracker.markTimedOut(turnId, toolCallId)
    }
  }

  /**
   * Stop all active watchers.
   */
  dispose(): void {
    for (const interval of this.watchers.values()) {
      clearInterval(interval)
    }
    this.watchers.clear()
  }
}
