import { NexusAgent } from 'fitalyagents'
import type {
    TaskPayloadEvent,
    TaskResultEvent,
    AgentManifest,
    IEventBus,
} from 'fitalyagents'
import type { IToolExecutor, WorkToolRequest, WorkToolResult } from './types.js'

// ── Intent → Tool mapping ───────────────────────────────────────────────────

/**
 * Maps an intent_id to the set of tools required to fulfill it.
 * Multiple tools in the array execute in PARALLEL (inject_when_all).
 */
export type IntentToolMap = Record<string, WorkToolRequest[]>

/**
 * Default intent-to-tool mapping for the retail domain.
 */
export const DEFAULT_INTENT_TOOL_MAP: IntentToolMap = {
    product_search: [
        { tool_id: 'product_search', input: {} },
    ],
    price_query: [
        { tool_id: 'price_check', input: {} },
    ],
    product_search_with_price: [
        { tool_id: 'product_search', input: {} },
        { tool_id: 'price_check', input: {} },
    ],
    order_query: [
        { tool_id: 'order_query', input: {} },
    ],
    calculate: [
        { tool_id: 'calculate', input: {} },
    ],
}

// ── Manifest ────────────────────────────────────────────────────────────────

export function createWorkManifest(
    overrides: Partial<AgentManifest> = {},
): AgentManifest {
    return {
        agent_id: 'work-agent-001',
        display_name: 'Work Agent',
        description:
            'Backend work agent handling product searches, price checks, order queries, and calculations. Uses parallel tool execution for multi-tool intents. Powered by LangChain.js for tool orchestration.',
        version: '1.0.0',
        domain: 'customer_facing',
        scope: 'commerce',
        capabilities: ['PRODUCT_SEARCH', 'PRICE_CHECK', 'ORDER_QUERY', 'CALC_SIMPLE'],
        context_mode: 'stateless',
        context_access: {
            read: ['user_preferences', 'current_order'],
            write: ['last_action'],
            forbidden: ['conversation_history', 'internal_metrics'],
        },
        async_tools: ['product_search', 'price_check', 'order_query', 'calculate'],
        input_channel: 'queue:work-agent:inbox',
        output_channel: 'queue:work-agent:outbox',
        priority: 6,
        max_concurrent: 5,
        timeout_ms: 8000,
        heartbeat_interval_ms: 3000,
        role: null,
        accepts_from: ['*'],
        requires_human_approval: false,
        ...overrides,
    }
}

// ── WorkAgent ───────────────────────────────────────────────────────────────

export interface WorkAgentOptions {
    bus: IEventBus
    toolExecutor: IToolExecutor
    intentToolMap?: IntentToolMap
    manifest?: Partial<AgentManifest>
}

/**
 * WorkAgent — the backend worker for domain-specific tasks.
 *
 * Responsibilities:
 * 1. **Tool Orchestration** — Execute tools based on intent
 * 2. **Parallel Execution** — Run multiple tools simultaneously (inject_when_all)
 * 3. **Result Aggregation** — Combine results from parallel tools
 * 4. **ACTION_COMPLETED** — Notify the system when work is done
 *
 * Architecture:
 * - Extends `NexusAgent` for lifecycle (register, heartbeat, inbox)
 * - Uses `IToolExecutor` (LangChain.js in production) for tool execution
 * - Intent → Tool mapping is configurable
 *
 * Flow:
 * ```
 * TASK_PAYLOAD (intent: product_search_with_price)
 *   ├── Resolve intent → [product_search, price_check]
 *   ├── executeParallel([product_search, price_check])  ← inject_when_all
 *   │     ├── product_search: 400ms ────┐
 *   │     └── price_check:   350ms ─────┤ wait for BOTH
 *   │                                   ↓
 *   ├── Aggregate results
 *   ├── Publish ACTION_COMPLETED
 *   └── Return TaskResult with combined data
 * ```
 */
export class WorkAgent extends NexusAgent {
    private readonly toolExecutor: IToolExecutor
    private readonly intentToolMap: IntentToolMap

    constructor(options: WorkAgentOptions) {
        super({
            bus: options.bus,
            manifest: createWorkManifest(options.manifest),
        })
        this.toolExecutor = options.toolExecutor
        this.intentToolMap = options.intentToolMap ?? DEFAULT_INTENT_TOOL_MAP
    }

    /**
     * Process a task:
     * 1. Resolve intent → tool requests
     * 2. Merge task slots into tool inputs
     * 3. Execute tools (parallel if multiple)
     * 4. Aggregate results
     * 5. Publish ACTION_COMPLETED
     */
    async process(task: TaskPayloadEvent): Promise<TaskResultEvent> {
        const { session_id, intent_id, task_id, slots } = task

        // 1. Resolve intent to tool requests
        const templateRequests = this.intentToolMap[intent_id]
        if (!templateRequests || templateRequests.length === 0) {
            return {
                event: 'TASK_RESULT',
                task_id,
                session_id,
                status: 'failed',
                error: `No tools mapped for intent: ${intent_id}`,
                context_patch: {},
                completed_at: Date.now(),
            }
        }

        // 2. Merge task slots into each tool's input
        const requests: WorkToolRequest[] = templateRequests.map((tmpl) => ({
            tool_id: tmpl.tool_id,
            input: { ...tmpl.input, ...slots },
        }))

        // 3. Execute tools
        let results: WorkToolResult[]
        if (requests.length === 1) {
            results = [await this.toolExecutor.execute(requests[0]!)]
        } else {
            // PARALLEL execution — inject_when_all
            results = await this.toolExecutor.executeParallel(requests)
        }

        // 4. Check for failures
        const failures = results.filter((r) => r.status === 'failed')
        if (failures.length === results.length) {
            // All tools failed
            return {
                event: 'TASK_RESULT',
                task_id,
                session_id,
                status: 'failed',
                error: failures.map((f) => `${f.tool_id}: ${f.error}`).join('; '),
                context_patch: {},
                completed_at: Date.now(),
            }
        }

        // 5. Aggregate results
        const aggregated = this.aggregateResults(intent_id, results)

        // 6. Publish ACTION_COMPLETED for InteractionAgent to pick up
        await this.bus.publish('bus:ACTION_COMPLETED', {
            event: 'ACTION_COMPLETED',
            task_id,
            session_id,
            intent_id,
            agent_id: this.manifest.agent_id,
            result: aggregated,
            timestamp: Date.now(),
        })

        return {
            event: 'TASK_RESULT',
            task_id,
            session_id,
            status: 'completed',
            result: aggregated,
            context_patch: {
                last_action: {
                    type: 'WORK_COMPLETED',
                    intent_id,
                    tools_executed: results.map((r) => r.tool_id),
                    parallel: requests.length > 1,
                    total_duration_ms: Math.max(...results.map((r) => r.duration_ms)),
                    timestamp: Date.now(),
                },
            },
            completed_at: Date.now(),
        }
    }

    // ── Result aggregation ────────────────────────────────────────────────

    /**
     * Aggregate results from multiple tools into a single response.
     * Override for custom aggregation logic per intent.
     */
    protected aggregateResults(
        _intentId: string,
        results: WorkToolResult[],
    ): Record<string, unknown> {
        if (results.length === 1) {
            return {
                tool_id: results[0]!.tool_id,
                ...(results[0]!.result as Record<string, unknown> ?? {}),
            }
        }

        // Multi-tool: create a map of tool_id → result
        const combined: Record<string, unknown> = {}
        for (const r of results) {
            if (r.status === 'completed') {
                combined[r.tool_id] = r.result
            } else {
                combined[r.tool_id] = { error: r.error }
            }
        }

        // Generate a text summary for InteractionAgent
        const completedTools = results.filter((r) => r.status === 'completed')
        combined.text = `Completed ${completedTools.length} of ${results.length} tasks.`

        return combined
    }
}
