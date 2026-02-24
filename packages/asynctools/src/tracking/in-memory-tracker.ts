import type { IPendingStateTracker } from './types.js'
import type {
  ToolResult,
  InjectionStrategy,
  PendingToolCall,
  TurnState,
  ToolStatus,
} from '../types/index.js'

/**
 * In-memory implementation of the PendingStateTracker.
 *
 * Tracks tool call states across turns using Maps. Supports all three
 * injection strategies with configurable TTL for orphan turn cleanup.
 *
 * @example
 * ```typescript
 * const tracker = new InMemoryPendingStateTracker()
 * const turn = tracker.createTurn('turn_1', 'agent_1', 'inject_when_all', 30000)
 * tracker.addPending('turn_1', 'call_1', 'product_search', { query: 'nike' })
 * tracker.markCompleted('turn_1', 'call_1', result)
 * console.log(tracker.isResolved('turn_1')) // true
 * ```
 */
export class InMemoryPendingStateTracker implements IPendingStateTracker {
  private turns: Map<string, TurnState> = new Map()
  private turnTimers: Map<string, ReturnType<typeof setTimeout>> = new Map()

  constructor(private ttlMs: number = 60_000) {}

  createTurn(
    turnId: string,
    agentId: string,
    strategy: InjectionStrategy,
    globalTimeoutMs: number,
  ): TurnState {
    const turn: TurnState = {
      turn_id: turnId,
      agent_id: agentId,
      strategy,
      global_timeout_ms: globalTimeoutMs,
      tool_calls: new Map(),
      results: new Map(),
      created_at: Date.now(),
    }

    this.turns.set(turnId, turn)

    // Set TTL for orphan cleanup
    const timer = setTimeout(() => {
      this.deleteTurn(turnId)
    }, this.ttlMs)

    // Don't let the timer prevent process exit
    if (typeof timer === 'object' && 'unref' in timer) {
      timer.unref()
    }

    this.turnTimers.set(turnId, timer)

    return turn
  }

  addPending(turnId: string, toolCallId: string, toolId: string, input: unknown): void {
    const turn = this.getTurnOrThrow(turnId)
    const pending: PendingToolCall = {
      tool_call_id: toolCallId,
      tool_id: toolId,
      status: 'pending',
      input,
      created_at: Date.now(),
    }
    turn.tool_calls.set(toolCallId, pending)
  }

  markRunning(turnId: string, toolCallId: string): void {
    const call = this.getCallOrThrow(turnId, toolCallId)
    call.status = 'running'
  }

  markCompleted(turnId: string, toolCallId: string, result: ToolResult): void {
    const call = this.getCallOrThrow(turnId, toolCallId)
    call.status = 'completed'
    const turn = this.getTurnOrThrow(turnId)
    turn.results.set(toolCallId, result)
  }

  markFailed(turnId: string, toolCallId: string, error: string): void {
    const call = this.getCallOrThrow(turnId, toolCallId)
    call.status = 'failed'
    const turn = this.getTurnOrThrow(turnId)
    turn.results.set(toolCallId, {
      tool_call_id: toolCallId,
      tool_id: call.tool_id,
      status: 'failed',
      error,
      started_at: call.created_at,
      completed_at: Date.now(),
      duration_ms: Date.now() - call.created_at,
    })
  }

  markTimedOut(turnId: string, toolCallId: string): void {
    const call = this.getCallOrThrow(turnId, toolCallId)
    call.status = 'timed_out'
    const turn = this.getTurnOrThrow(turnId)
    turn.results.set(toolCallId, {
      tool_call_id: toolCallId,
      tool_id: call.tool_id,
      status: 'timed_out',
      error: 'Tool call timed out',
      started_at: call.created_at,
      completed_at: Date.now(),
      duration_ms: Date.now() - call.created_at,
    })
  }

  isResolved(turnId: string): boolean {
    const turn = this.turns.get(turnId)
    if (!turn) return false
    if (turn.tool_calls.size === 0) return false

    switch (turn.strategy) {
      case 'inject_when_all':
        return this.allTerminal(turn)

      case 'inject_when_ready':
        return this.anyCompleted(turn)

      case 'inject_on_timeout': {
        const elapsed = Date.now() - turn.created_at
        return elapsed >= turn.global_timeout_ms
      }

      default:
        return false
    }
  }

  getResults(turnId: string): ToolResult[] {
    const turn = this.turns.get(turnId)
    if (!turn) return []
    return Array.from(turn.results.values())
  }

  getPending(turnId: string): string[] {
    const turn = this.turns.get(turnId)
    if (!turn) return []

    return Array.from(turn.tool_calls.entries())
      .filter(([_, call]) => call.status === 'pending' || call.status === 'running')
      .map(([id]) => id)
  }

  getTimedOut(turnId: string): string[] {
    const turn = this.turns.get(turnId)
    if (!turn) return []

    return Array.from(turn.tool_calls.entries())
      .filter(([_, call]) => call.status === 'timed_out')
      .map(([id]) => id)
  }

  getTurn(turnId: string): TurnState | undefined {
    return this.turns.get(turnId)
  }

  deleteTurn(turnId: string): void {
    this.turns.delete(turnId)
    const timer = this.turnTimers.get(turnId)
    if (timer) {
      clearTimeout(timer)
      this.turnTimers.delete(turnId)
    }
  }

  // ── Private helpers ───────────────────────────────────────────────────

  private getTurnOrThrow(turnId: string): TurnState {
    const turn = this.turns.get(turnId)
    if (!turn) throw new Error(`Turn not found: "${turnId}"`)
    return turn
  }

  private getCallOrThrow(turnId: string, toolCallId: string): PendingToolCall {
    const turn = this.getTurnOrThrow(turnId)
    const call = turn.tool_calls.get(toolCallId)
    if (!call) throw new Error(`Tool call not found: "${toolCallId}" in turn "${turnId}"`)
    return call
  }

  private isTerminalStatus(status: ToolStatus): boolean {
    return status === 'completed' || status === 'failed' || status === 'timed_out'
  }

  private allTerminal(turn: TurnState): boolean {
    for (const call of turn.tool_calls.values()) {
      if (!this.isTerminalStatus(call.status)) return false
    }
    return true
  }

  private anyCompleted(turn: TurnState): boolean {
    for (const call of turn.tool_calls.values()) {
      if (call.status === 'completed') return true
    }
    return false
  }
}
