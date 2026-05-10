import { AsyncLocalStorage } from 'node:async_hooks'
import type Database from 'better-sqlite3'
import type { HumanRole, IEventBus, InteractionToolDef, IToolExecutor } from 'fitalyagents'
import type { StoreConfig } from '../config/schema.js'
import type {
  ApprovalRepository,
  CustomerRepository,
  DraftRepository,
  EmployeeRepository,
  OrderRepository,
  SessionRepository,
  WebhookRepository,
} from '../storage/repositories/index.js'

export interface StoreToolExecutionContext {
  session_id: string
  store_id: string
  speaker_id?: string
  role?: HumanRole | null
}

export interface IStoreTool extends InteractionToolDef {
  execute(input: unknown, context: StoreToolExecutionContext): Promise<unknown>
}

export interface StoreRepositories {
  customers: CustomerRepository
  employees: EmployeeRepository
  drafts: DraftRepository
  orders: OrderRepository
  approvals: ApprovalRepository
  sessions: SessionRepository
  webhooks: WebhookRepository
}

export interface ToolRegistryDeps {
  bus: IEventBus
  db: Database.Database
  storeId: string
  repositories: StoreRepositories
  approvalOrchestrator?: unknown
  approvalsConfig?: StoreConfig['approvals']
  employees?: StoreConfig['employees']
  policies?: StoreConfig['policies']
}

export class ToolRegistry implements IToolExecutor {
  private readonly tools = new Map<string, IStoreTool>()
  private readonly contextStore = new AsyncLocalStorage<StoreToolExecutionContext>()

  constructor(private readonly deps: ToolRegistryDeps) {}

  register(tool: IStoreTool): void {
    this.tools.set(tool.tool_id, tool)
  }

  get(toolId: string): IStoreTool | undefined {
    return this.tools.get(toolId)
  }

  list(): IStoreTool[] {
    return [...this.tools.values()]
  }

  toInteractionToolDefs(): Map<string, InteractionToolDef> {
    return new Map(
      this.list().map((tool) => [
        tool.tool_id,
        {
          tool_id: tool.tool_id,
          description: tool.description,
          safety: tool.safety,
          required_role: tool.required_role,
          confirm_prompt: tool.confirm_prompt,
          quorum: tool.quorum,
          input_schema: tool.input_schema,
        },
      ]),
    )
  }

  runWithContext<T>(context: StoreToolExecutionContext, run: () => Promise<T>): Promise<T>
  runWithContext<T>(context: StoreToolExecutionContext, run: () => T): T
  runWithContext<T>(context: StoreToolExecutionContext, run: () => Promise<T> | T): Promise<T> | T {
    return this.contextStore.run(context, run)
  }

  async execute(toolId: string, input: unknown): Promise<unknown> {
    const tool = this.tools.get(toolId)
    if (!tool) {
      throw new Error(`Unknown tool: ${toolId}`)
    }

    const context = this.contextStore.getStore() ?? {
      session_id: 'store-runtime',
      store_id: this.deps.storeId,
    }
    const result = await tool.execute(input, context)

    await this.deps.bus.publish('bus:TOOL_RESULT', {
      event: 'TOOL_RESULT',
      tool_id: tool.tool_id,
      tool_name: tool.tool_id,
      session_id: context.session_id,
      store_id: context.store_id,
      speaker_id: context.speaker_id,
      role: context.role,
      input,
      result,
      timestamp: Date.now(),
    })

    return result
  }
}
