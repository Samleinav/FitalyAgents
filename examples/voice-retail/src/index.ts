// InteractionAgent (TEN Framework)
export { InteractionAgent, createInteractionManifest } from './agents/interaction/interaction-agent.js'
export { MockTENClient } from './agents/interaction/mock-ten-client.js'
export type {
    ITENClient,
    Gesture,
    QuickResponse,
    InteractionAgentDeps,
} from './agents/interaction/types.js'

// WorkAgent (LangChain.js)
export { WorkAgent, createWorkManifest, DEFAULT_INTENT_TOOL_MAP } from './agents/work/work-agent.js'
export { MockToolExecutor } from './agents/work/mock-tool-executor.js'
export type {
    IToolExecutor,
    WorkToolRequest,
    WorkToolResult,
    ToolHandler,
    ToolRegistration,
} from './agents/work/types.js'

// OrderAgent
export { OrderAgent, createOrderManifest } from './agents/order/order-agent.js'
export { MockOrderService } from './agents/order/mock-order-service.js'
export type {
    IOrderService,
    OrderDraft,
    SubmissionResult,
    OrderStatusResult,
    CancelResult,
} from './agents/order/types.js'
