import type { AgentManifest, IEventBus, Unsubscribe } from '../types/index.js'
import type { AgentRegistry } from '../registry/agent-registry.js'
import type { ILockManager } from '../locks/types.js'
import type { ITaskQueue } from '../tasks/types.js'
import type { IContextStore } from '../context/types.js'

// ── Route result ────────────────────────────────────────────────────────────

/**
 * Result returned by `CapabilityRouter.route()`.
 */
export interface RouteResult {
  /** The agent selected to handle the task */
  agentId: string
  /** The agent's manifest */
  manifest: AgentManifest
}

/**
 * Event shape for TASK_AVAILABLE that triggers routing.
 */
export interface TaskAvailableEvent {
  event: 'TASK_AVAILABLE'
  task_id: string
  session_id: string
  intent_id: string
  priority: number
}

// ── Routing options ─────────────────────────────────────────────────────────

/**
 * Routing requirements extracted from the task or caller.
 */
export interface RouteRequirements {
  /** Required domain */
  domain?: AgentManifest['domain']
  /** Required scope (optional filter) */
  scope?: string
  /** Capabilities the agent MUST have (superset match) */
  capabilities: string[]
  /** Who is the caller (for `accepts_from` filter) */
  callerAgentId: string
}

// ── Interface ───────────────────────────────────────────────────────────────

/**
 * Interface for capability-based task routing.
 *
 * Implements the 7-step selection algorithm:
 * 1. Filter by domain
 * 2. Filter by scope (optional)
 * 3. Filter by capabilities ⊇ required
 * 4. Filter by accepts_from
 * 5. Filter by current_load < max_concurrent
 * 6. Sort by priority DESC, load ASC
 * 7. Pick top candidate
 */
export interface ICapabilityRouter {
  /**
   * Route a task to the best available agent.
   * Returns the selected agentId, or null if no candidate found.
   */
  route(requirements: RouteRequirements): Promise<RouteResult | null>

  /**
   * Build a context snapshot for an agent based on its `context_access.read` rules.
   */
  buildContextSnapshot(
    sessionId: string,
    agentManifest: AgentManifest,
  ): Promise<Record<string, unknown>>

  /**
   * Start listening to TASK_AVAILABLE events and automatically route them.
   * Returns an unsubscribe function.
   */
  start(): Unsubscribe

  /**
   * Stop listening and clean up.
   */
  dispose(): void
}

// ── Dependencies ────────────────────────────────────────────────────────────

export interface CapabilityRouterDeps {
  registry: AgentRegistry
  lockManager: ILockManager
  taskQueue: ITaskQueue
  contextStore: IContextStore
  bus: IEventBus
  /** ID of the caller/dispatcher for accepts_from checks */
  dispatcherAgentId: string
}
