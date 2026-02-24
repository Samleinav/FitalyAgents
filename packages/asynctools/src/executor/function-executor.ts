import type { IExecutor } from './types.js'

/**
 * Registry of function handlers for `ts_fn` executor type.
 * Maps tool_id → handler function.
 */
const functionHandlers = new Map<string, (input: unknown) => unknown | Promise<unknown>>()

/**
 * Register a function handler for a specific tool_id.
 * Used when tools have `executor.type === 'ts_fn'`.
 *
 * @param toolId - The tool ID to register the handler for
 * @param handler - The function to invoke when the tool is executed
 */
export function registerFunctionHandler(
  toolId: string,
  handler: (input: unknown) => unknown | Promise<unknown>,
): void {
  functionHandlers.set(toolId, handler)
}

/**
 * Get a registered function handler (for testing/internal use).
 */
export function getFunctionHandler(
  toolId: string,
): ((input: unknown) => unknown | Promise<unknown>) | undefined {
  return functionHandlers.get(toolId)
}

/**
 * Clear all registered function handlers (for testing).
 */
export function clearFunctionHandlers(): void {
  functionHandlers.clear()
}

/**
 * Executes tools by calling registered TypeScript/JavaScript functions.
 *
 * Automatically wraps synchronous functions in a Promise. Supports
 * any function signature `(input: unknown) => unknown | Promise<unknown>`.
 */
export class FunctionExecutor implements IExecutor {
  async execute(toolId: string, input: unknown, _signal?: AbortSignal): Promise<unknown> {
    const handler = functionHandlers.get(toolId)

    if (!handler) {
      throw new Error(`No function handler registered for tool "${toolId}"`)
    }

    // Extract the actual payload from the wrapped input
    const payload = (input as { __payload: unknown }).__payload

    // Automatically wraps sync results in Promise
    return Promise.resolve(handler(payload))
  }
}
