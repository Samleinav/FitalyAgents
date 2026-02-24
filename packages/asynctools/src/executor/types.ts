/**
 * Common interface for all executor implementations.
 * Each executor knows how to run a specific type of tool (HTTP, function, subprocess).
 */
export interface IExecutor {
  /**
   * Execute a tool invocation.
   *
   * @param toolId  - Identifier of the tool being executed (for logging)
   * @param input   - The input payload to pass to the tool
   * @param signal  - Optional AbortSignal for timeout/cancellation
   * @returns The raw result from the tool execution
   */
  execute(toolId: string, input: unknown, signal?: AbortSignal): Promise<unknown>
}
