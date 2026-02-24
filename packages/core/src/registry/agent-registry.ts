import type {
  IEventBus,
  AgentManifest,
  HeartbeatEvent,
  HeartbeatStatus,
  AgentRegisteredEvent,
  AgentDeregisteredEvent,
  Unsubscribe,
} from '../types/index.js'

// ── Types ─────────────────────────────────────────────────────────────────────

export interface RegistryFilters {
  domain?: AgentManifest['domain']
  scope?: string
  /** Agent must have ALL listed capabilities */
  capabilities?: string[]
  role?: AgentManifest['role']
}

interface HeartbeatRecord {
  status: HeartbeatStatus
  current_tasks: number
  last_seen_at: number
}

interface LoadRecord {
  current: number
}

/**
 * AgentRegistry tracks which NexusAgents are currently registered on the bus.
 *
 * Uses an in-memory mirror for fast reads, synchronized automatically by
 * subscribing to `bus:AGENT_REGISTERED`, `bus:AGENT_DEREGISTERED`, and
 * `bus:HEARTBEAT` events.
 *
 * A Redis-backed version would persist agents across restarts; this
 * implementation is an in-memory version sufficient for testing and
 * single-node deployments.
 *
 * @example
 * ```typescript
 * const registry = new AgentRegistry(bus)
 * registry.listen()   // start watching bus events
 *
 * const agents = await registry.list({ capabilities: ['PRODUCT_SEARCH'] })
 * ```
 */
export class AgentRegistry {
  /** Manifests keyed by agent_id */
  private agents: Map<string, AgentManifest> = new Map()
  /** Last heartbeat info per agent */
  private heartbeats: Map<string, HeartbeatRecord> = new Map()
  /** In-flight task load per agent */
  private loads: Map<string, LoadRecord> = new Map()
  /** Cleanup functions for bus subscriptions */
  private unsubs: Unsubscribe[] = []

  constructor(private bus: IEventBus) {}

  /**
   * Start listening for bus events.
   * Must be called once to enable automatic registry updates.
   * Returns an unsubscribe function to stop listening.
   */
  listen(): Unsubscribe {
    const u1 = this.bus.subscribe('bus:AGENT_REGISTERED', (data) => {
      const { event: _event, ...manifest } = data as AgentRegisteredEvent
      void _event
      this.agents.set(manifest.agent_id, manifest as AgentManifest)
      // Initialize load if not tracked yet
      if (!this.loads.has(manifest.agent_id)) {
        this.loads.set(manifest.agent_id, { current: 0 })
      }
    })

    const u2 = this.bus.subscribe('bus:AGENT_DEREGISTERED', (data) => {
      const event = data as AgentDeregisteredEvent
      this.agents.delete(event.agent_id)
      this.heartbeats.delete(event.agent_id)
      this.loads.delete(event.agent_id)
    })

    const u3 = this.bus.subscribe('bus:HEARTBEAT', (data) => {
      const event = data as HeartbeatEvent
      this.heartbeats.set(event.agent_id, {
        status: event.status,
        current_tasks: event.current_tasks,
        last_seen_at: event.timestamp,
      })
    })

    this.unsubs.push(u1, u2, u3)

    return () => {
      u1()
      u2()
      u3()
    }
  }

  /** Stop listening for bus events and clear all state. */
  dispose(): void {
    for (const unsub of this.unsubs) unsub()
    this.unsubs = []
    this.agents.clear()
    this.heartbeats.clear()
    this.loads.clear()
  }

  // ── Registration ──────────────────────────────────────────────────────────

  /**
   * Manually register an agent manifest (e.g. on startup before the bus event arrives).
   */
  register(manifest: AgentManifest): void {
    this.agents.set(manifest.agent_id, manifest)
    if (!this.loads.has(manifest.agent_id)) {
      this.loads.set(manifest.agent_id, { current: 0 })
    }
  }

  /**
   * Manually unregister an agent.
   */
  unregister(agentId: string): void {
    this.agents.delete(agentId)
    this.heartbeats.delete(agentId)
    this.loads.delete(agentId)
  }

  // ── Queries ───────────────────────────────────────────────────────────────

  /**
   * Get a registered agent by ID. Returns null if not found.
   */
  async get(agentId: string): Promise<AgentManifest | null> {
    return this.agents.get(agentId) ?? null
  }

  /**
   * List all registered agents, optionally filtered.
   */
  async list(filters?: RegistryFilters): Promise<AgentManifest[]> {
    let results = Array.from(this.agents.values())

    if (!filters) return results

    if (filters.domain !== undefined) {
      results = results.filter((a) => a.domain === filters.domain)
    }
    if (filters.scope !== undefined) {
      results = results.filter((a) => a.scope === filters.scope)
    }
    if (filters.capabilities !== undefined && filters.capabilities.length > 0) {
      results = results.filter((a) =>
        filters.capabilities!.every((cap) => a.capabilities.includes(cap)),
      )
    }
    if (filters.role !== undefined) {
      results = results.filter((a) => a.role === filters.role)
    }

    return results
  }

  /**
   * Returns agents that have NOT sent a heartbeat within the given threshold.
   * Agents that never sent a heartbeat are also considered stale.
   */
  async getStale(thresholdMs: number): Promise<AgentManifest[]> {
    const now = Date.now()
    return Array.from(this.agents.values()).filter((agent) => {
      const hb = this.heartbeats.get(agent.agent_id)
      if (!hb) return true // never heard from — stale
      return now - hb.last_seen_at > thresholdMs
    })
  }

  // ── Heartbeat ─────────────────────────────────────────────────────────────

  /**
   * Manually record a heartbeat for an agent.
   */
  updateHeartbeat(agentId: string, status: HeartbeatStatus): void {
    this.heartbeats.set(agentId, {
      status,
      current_tasks: this.loads.get(agentId)?.current ?? 0,
      last_seen_at: Date.now(),
    })
  }

  /**
   * Get the last known heartbeat for an agent. Returns null if never seen.
   */
  getHeartbeat(agentId: string): HeartbeatRecord | null {
    return this.heartbeats.get(agentId) ?? null
  }

  // ── Load tracking ─────────────────────────────────────────────────────────

  /**
   * Get the current in-flight task count for an agent.
   */
  async getCurrentLoad(agentId: string): Promise<number> {
    return this.loads.get(agentId)?.current ?? 0
  }

  /**
   * Increment the task load for an agent (call when a task is dispatched).
   */
  async incrementLoad(agentId: string): Promise<void> {
    const rec = this.loads.get(agentId) ?? { current: 0 }
    rec.current = Math.max(0, rec.current + 1)
    this.loads.set(agentId, rec)
  }

  /**
   * Decrement the task load for an agent (call when a task completes or fails).
   */
  async decrementLoad(agentId: string): Promise<void> {
    const rec = this.loads.get(agentId) ?? { current: 0 }
    rec.current = Math.max(0, rec.current - 1)
    this.loads.set(agentId, rec)
  }

  // ── Convenience ───────────────────────────────────────────────────────────

  /**
   * Total number of registered agents.
   */
  get size(): number {
    return this.agents.size
  }

  /**
   * Returns true if an agent with the given ID is registered.
   */
  has(agentId: string): boolean {
    return this.agents.has(agentId)
  }
}
