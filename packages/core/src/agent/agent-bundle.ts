/**
 * A disposable resource (AudioQueueService, ContextStore, etc.)
 */
export interface Disposable {
  dispose(): void
}

/**
 * Minimal interface for agents managed by AgentBundle.
 * Both StreamAgent and any custom agent can implement this.
 */
export interface IAgent {
  start(): Promise<void>
  stop(): Promise<void>
}

export interface AgentBundleOptions {
  /** Agents to manage. Started in order, stopped in reverse order. */
  agents: IAgent[]
  /**
   * Additional disposable resources (AudioQueueService, ContextStore, etc.)
   * that should be cleaned up when the bundle is disposed.
   *
   * All disposables are called on `bundle.dispose()`, NOT on `bundle.stop()`.
   */
  disposables?: Disposable[]
}

/**
 * AgentBundle — groups agents and disposables for unified lifecycle management.
 *
 * Replaces the manual start/stop/dispose boilerplate in multi-agent setups.
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
 * await bundle.stop()
 * bundle.dispose()
 * ```
 */
export class AgentBundle {
  private readonly agents: IAgent[]
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
   * Stop all agents in reverse order (last-in, first-out).
   * Does NOT call dispose on disposables — use `dispose()` for that.
   */
  async stop(): Promise<void> {
    const reversed = [...this.agents].reverse()
    for (const agent of reversed) {
      await agent.stop()
    }
  }

  /**
   * @deprecated Use stop() instead. Will be removed in v3.0.0.
   */
  async shutdown(): Promise<void> {
    return this.stop()
  }

  /**
   * Dispose all disposable resources (queues, stores, etc.).
   * Call this after `stop()` to fully clean up.
   */
  dispose(): void {
    for (const d of this.disposables) {
      d.dispose()
    }
  }
}
