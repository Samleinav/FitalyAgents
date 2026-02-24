/**
 * Tool execution result from the work agent's tool executor.
 */
export interface WorkToolResult {
    tool_id: string
    status: 'completed' | 'failed'
    result?: unknown
    error?: string
    duration_ms: number
}

/**
 * A single tool request to execute.
 */
export interface WorkToolRequest {
    tool_id: string
    input: Record<string, unknown>
}

/**
 * Interface for the tool executor that the WorkAgent delegates to.
 *
 * In tests: `MockToolExecutor` with canned responses.
 * In production: LangChain.js `AgentExecutor` with `StructuredTool` instances.
 *
 * The executor handles:
 * - Tool registration and validation
 * - Parallel execution of multiple tools
 * - Timeout and error handling per tool
 */
export interface IToolExecutor {
    /**
     * Execute a single tool with the given input.
     */
    execute(request: WorkToolRequest): Promise<WorkToolResult>

    /**
     * Execute multiple tools in parallel, returning when all complete.
     * This is the `inject_when_all` pattern from asynctools.
     */
    executeParallel(requests: WorkToolRequest[]): Promise<WorkToolResult[]>

    /**
     * List available tool IDs.
     */
    availableTools(): string[]
}

/**
 * A tool handler function — the actual implementation.
 */
export type ToolHandler = (input: Record<string, unknown>) => Promise<unknown>

/**
 * Tool registration for the mock executor.
 */
export interface ToolRegistration {
    tool_id: string
    description: string
    handler: ToolHandler
}
