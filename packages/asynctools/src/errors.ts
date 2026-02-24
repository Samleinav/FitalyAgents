/**
 * Base error class for all FitalyAgents errors.
 * Provides a consistent `code` field for programmatic error handling.
 */
export class FitalyError extends Error {
  constructor(
    message: string,
    public readonly code: string,
  ) {
    super(message)
    this.name = this.constructor.name
  }
}

/**
 * Thrown when attempting to retrieve a tool that does not exist in the registry.
 *
 * @example
 * ```typescript
 * try {
 *   registry.getOrThrow('nonexistent_tool')
 * } catch (e) {
 *   if (e instanceof ToolNotFoundError) {
 *     console.log(e.toolId) // 'nonexistent_tool'
 *   }
 * }
 * ```
 */
export class ToolNotFoundError extends FitalyError {
  constructor(public readonly toolId: string) {
    super(`Tool not found: "${toolId}"`, 'TOOL_NOT_FOUND')
  }
}

/**
 * Thrown when a tool definition fails Zod schema validation during registration.
 * Contains the original Zod validation issues for detailed debugging.
 */
export class ToolValidationError extends FitalyError {
  constructor(
    message: string,
    public readonly issues: Array<{ path: (string | number)[]; message: string }>,
  ) {
    super(message, 'TOOL_VALIDATION_ERROR')
  }
}

/**
 * Thrown when attempting to register a tool with an ID that already exists in the registry.
 */
export class DuplicateToolError extends FitalyError {
  constructor(public readonly toolId: string) {
    super(`Tool already registered: "${toolId}"`, 'DUPLICATE_TOOL')
  }
}

/**
 * Thrown when an HTTP executor receives a non-2xx response.
 * Contains the HTTP status code and response body for debugging.
 */
export class HttpExecutorError extends FitalyError {
  constructor(
    public readonly status: number,
    public readonly body: string,
    public readonly url: string,
  ) {
    super(`HTTP executor failed: ${status} from ${url}`, 'HTTP_EXECUTOR_ERROR')
  }
}

/**
 * Thrown when a tool execution fails after all retry attempts are exhausted.
 */
export class ToolExecutionError extends FitalyError {
  constructor(
    public readonly toolId: string,
    public readonly cause: Error,
    public readonly attempt: number,
  ) {
    super(
      `Tool "${toolId}" failed after ${attempt} attempt(s): ${cause.message}`,
      'TOOL_EXECUTION_ERROR',
    )
  }
}
