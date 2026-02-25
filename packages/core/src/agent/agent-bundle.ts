import type { NexusAgent } from './nexus-agent.js'

/**
 * A disposable resource (AudioQueueService, ContextStore, etc.)
 */
export interface Disposable {
  dispose(): void
}

export interface AgentBundleOptions {
  /** Agents to manage. Started in order, shut down in reverse order. */
  agents: NexusAgent[]
  /**
   * Additional disposable resources (AudioQueueService, ContextStore, etc.)
   * that should be cleaned up when the bundle is disposed.
   *
   * All disposables are called on `bundle.dispose()`, NOT on `bundle.shutdown()`.
   */
  disposables?: Disposable[]
}

/**
 * AgentBundle — groups agents and disposables for unified lifecycle management.
 *
 * Replaces the manual start/shutdown/dispose boilerplate in multi-agent setups.
 *
 * @example
 * ```typescript
 * const bundle = new AgentBundle({
 *   agents: [interactionAgent, workAgent, orderAgent],
 *   disposables: [audioQueue, contextStore],
 * })
 *
 * await bundle.start()
 * // ... run tests or serve traffic ...
 * await bundle.shutdown()
 * bundle.dispose()
 * ```
 */
export class AgentBundle {
  private readonly agents: NexusAgent[]
  private readonly disposables: Disposable[]

  constructor(options: AgentBundleOptions) {
    this.agents = [...options.agents]
    this.disposables = [...(options.disposables ?? [])]
  }

  /**
   * Start all agents in the order they were provided.
   */
  async start(): Promise<void> {
    for (const agent of this.agents) {
      await agent.start()
    }
  }

  /**
   * Shut down all agents in reverse order (last-in, first-out).
   * Does NOT call dispose on disposables — use `dispose()` for that.
   */
  async shutdown(): Promise<void> {
    const reversed = [...this.agents].reverse()
    for (const agent of reversed) {
      await agent.shutdown()
    }
  }

  /**
   * Dispose all disposable resources (queues, stores, etc.).
   * Call this after `shutdown()` to fully clean up.
   */
  dispose(): void {
    for (const d of this.disposables) {
      d.dispose()
    }
  }
}
