import type {
    IToolExecutor,
    WorkToolRequest,
    WorkToolResult,
    ToolRegistration,
    ToolHandler,
} from './types.js'

/**
 * Mock Tool Executor — stands in for LangChain.js `AgentExecutor` in tests.
 *
 * In production, this would be replaced by a LangChain.js integration:
 * ```typescript
 * // Production LangChain executor (future Sprint)
 * import { AgentExecutor, createOpenAIToolsAgent } from 'langchain/agents'
 * import { StructuredTool } from '@langchain/core/tools'
 * import { ChatAnthropic } from '@langchain/anthropic'
 * ```
 *
 * The mock version registers tool handlers directly and executes them
 * with configurable latency to simulate real tool execution.
 *
 * @example
 * ```typescript
 * const executor = new MockToolExecutor({
 *   latencyMs: 50,
 *   tools: [
 *     {
 *       tool_id: 'product_search',
 *       description: 'Search products',
 *       handler: async (input) => ({ results: ['Nike Air Max'] }),
 *     },
 *   ],
 * })
 *
 * const result = await executor.execute({
 *   tool_id: 'product_search',
 *   input: { brand: 'Nike', size: 42 },
 * })
 * ```
 */
export class MockToolExecutor implements IToolExecutor {
    private tools: Map<string, ToolHandler> = new Map()
    private latencyMs: number
    public executionLog: Array<{ request: WorkToolRequest; result: WorkToolResult }> = []

    constructor(opts: {
        tools?: ToolRegistration[]
        latencyMs?: number
    } = {}) {
        this.latencyMs = opts.latencyMs ?? 10

        for (const tool of opts.tools ?? []) {
            this.tools.set(tool.tool_id, tool.handler)
        }
    }

    /**
     * Register a tool handler.
     */
    registerTool(registration: ToolRegistration): void {
        this.tools.set(registration.tool_id, registration.handler)
    }

    async execute(request: WorkToolRequest): Promise<WorkToolResult> {
        const handler = this.tools.get(request.tool_id)
        const start = Date.now()

        if (!handler) {
            const result: WorkToolResult = {
                tool_id: request.tool_id,
                status: 'failed',
                error: `Unknown tool: ${request.tool_id}`,
                duration_ms: 0,
            }
            this.executionLog.push({ request, result })
            return result
        }

        // Simulate latency
        await new Promise((r) => setTimeout(r, this.latencyMs))

        try {
            const output = await handler(request.input)
            const result: WorkToolResult = {
                tool_id: request.tool_id,
                status: 'completed',
                result: output,
                duration_ms: Date.now() - start,
            }
            this.executionLog.push({ request, result })
            return result
        } catch (err) {
            const result: WorkToolResult = {
                tool_id: request.tool_id,
                status: 'failed',
                error: err instanceof Error ? err.message : String(err),
                duration_ms: Date.now() - start,
            }
            this.executionLog.push({ request, result })
            return result
        }
    }

    /**
     * Execute multiple tools in parallel (inject_when_all pattern).
     * All tools start simultaneously and we wait for all to complete.
     */
    async executeParallel(requests: WorkToolRequest[]): Promise<WorkToolResult[]> {
        return Promise.all(requests.map((r) => this.execute(r)))
    }

    availableTools(): string[] {
        return [...this.tools.keys()]
    }

    reset(): void {
        this.executionLog = []
    }
}
