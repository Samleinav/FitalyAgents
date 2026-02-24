import type {
  ICapabilityRouter,
  RouteResult,
  RouteRequirements,
  TaskAvailableEvent,
  CapabilityRouterDeps,
} from './types.js'
import type { AgentManifest, Unsubscribe } from '../types/index.js'

/**
 * CapabilityRouter selects the best agent for a given task using
 * the 7-step selection algorithm.
 *
 * Steps:
 * 1. Filter by domain
 * 2. Filter by scope (optional)
 * 3. Filter capabilities ⊇ required
 * 4. Filter accepts_from (caller must be allowed)
 * 5. Filter current_load < max_concurrent
 * 6. Sort priority DESC, load ASC
 * 7. Pick top candidate
 *
 * @example
 * ```typescript
 * const router = new CapabilityRouter({ registry, lockManager, taskQueue, contextStore, bus, dispatcherAgentId: 'dispatcher' })
 * const unsub = router.start()  // auto-route on TASK_AVAILABLE
 *
 * // Or route manually:
 * const result = await router.route({ capabilities: ['SEARCH'], callerAgentId: 'dispatcher' })
 * ```
 */
export class CapabilityRouter implements ICapabilityRouter {
  private readonly registry: CapabilityRouterDeps['registry']
  private readonly lockManager: CapabilityRouterDeps['lockManager']
  private readonly taskQueue: CapabilityRouterDeps['taskQueue']
  private readonly contextStore: CapabilityRouterDeps['contextStore']
  private readonly bus: CapabilityRouterDeps['bus']
  private readonly dispatcherAgentId: string
  private unsub: Unsubscribe | null = null

  constructor(deps: CapabilityRouterDeps) {
    this.registry = deps.registry
    this.lockManager = deps.lockManager
    this.taskQueue = deps.taskQueue
    this.contextStore = deps.contextStore
    this.bus = deps.bus
    this.dispatcherAgentId = deps.dispatcherAgentId
  }

  // ── 7-step routing algorithm ──────────────────────────────────────────

  async route(requirements: RouteRequirements): Promise<RouteResult | null> {
    // Get ALL agents from registry
    let candidates = await this.registry.list()

    // Step 1: Filter by domain
    if (requirements.domain) {
      candidates = candidates.filter((a) => a.domain === requirements.domain)
    }

    // Step 2: Filter by scope (optional)
    if (requirements.scope) {
      candidates = candidates.filter((a) => a.scope === requirements.scope)
    }

    // Step 3: Filter capabilities ⊇ required
    if (requirements.capabilities.length > 0) {
      candidates = candidates.filter((a) =>
        requirements.capabilities.every((cap) => a.capabilities.includes(cap)),
      )
    }

    // Step 4: Filter accepts_from (caller must be in agent's accepts_from list,
    //         or the list must contain '*')
    candidates = candidates.filter(
      (a) => a.accepts_from.includes('*') || a.accepts_from.includes(requirements.callerAgentId),
    )

    // Step 5: Filter current_load < max_concurrent
    const withLoad: Array<{ agent: AgentManifest; load: number }> = []
    for (const agent of candidates) {
      const load = await this.registry.getCurrentLoad(agent.agent_id)
      if (load < agent.max_concurrent) {
        withLoad.push({ agent, load })
      }
    }

    if (withLoad.length === 0) {
      return null
    }

    // Step 6: Sort — priority DESC, then load ASC (tie-break)
    withLoad.sort((a, b) => {
      if (b.agent.priority !== a.agent.priority) {
        return b.agent.priority - a.agent.priority // higher priority first
      }
      return a.load - b.load // lower load first
    })

    // Step 7: Top candidate
    const selected = withLoad[0]!
    return {
      agentId: selected.agent.agent_id,
      manifest: selected.agent,
    }
  }

  // ── Context snapshot ──────────────────────────────────────────────────

  async buildContextSnapshot(
    sessionId: string,
    agentManifest: AgentManifest,
  ): Promise<Record<string, unknown>> {
    const { read, forbidden } = agentManifest.context_access
    return this.contextStore.getSnapshot(sessionId, read, forbidden)
  }

  // ── Auto-routing ──────────────────────────────────────────────────────

  start(): Unsubscribe {
    this.unsub = this.bus.subscribe('bus:TASK_AVAILABLE', (data) => {
      const event = data as TaskAvailableEvent
      void this.handleTaskAvailable(event)
    })

    return () => {
      this.dispose()
    }
  }

  dispose(): void {
    if (this.unsub) {
      this.unsub()
      this.unsub = null
    }
  }

  // ── Private ───────────────────────────────────────────────────────────

  private async handleTaskAvailable(event: TaskAvailableEvent): Promise<void> {
    const task = await this.taskQueue.getTask(event.task_id)
    if (!task || task.status !== 'AVAILABLE') return

    // Build requirements from the task
    const requirements: RouteRequirements = {
      capabilities: [task.intentId],
      callerAgentId: this.dispatcherAgentId,
    }

    const result = await this.route(requirements)

    if (!result) {
      // No candidate found — task stays AVAILABLE for later attempts
      return
    }

    // Try to claim the task (uses SET NX semantics via LockManager)
    const claimed = await this.taskQueue.claim(result.agentId, task.taskId)
    if (!claimed) {
      // Another router/agent already claimed it — race condition handled
      return
    }

    // Increment load tracking
    await this.registry.incrementLoad(result.agentId)

    // Build context snapshot for the agent
    const snapshot = await this.buildContextSnapshot(task.sessionId, result.manifest)

    // Start the task
    await this.taskQueue.start(task.taskId)

    // Publish the full TaskPayload to the agent's input channel
    await this.bus.publish(`bus:${result.manifest.input_channel}`, {
      event: 'TASK_PAYLOAD',
      task_id: task.taskId,
      session_id: task.sessionId,
      intent_id: task.intentId,
      slots: task.slots,
      context_snapshot: snapshot,
      cancel_token: task.cancelToken,
      timeout_ms: task.timeoutMs,
      reply_to: task.replyTo,
    })
  }
}
