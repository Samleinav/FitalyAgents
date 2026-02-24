import type { ToolResult, InjectionStrategy, TurnState } from '../types/index.js'

/**
 * Interface for tracking the state of pending tool calls within a turn.
 * Supports multiple injection strategies (inject_when_all, inject_when_ready, inject_on_timeout).
 */
export interface IPendingStateTracker {
  /** Create a new turn with its injection strategy and timeout. */
  createTurn(
    turnId: string,
    agentId: string,
    strategy: InjectionStrategy,
    globalTimeoutMs: number,
  ): TurnState

  /** Register a new pending tool call within a turn. */
  addPending(turnId: string, toolCallId: string, toolId: string, input: unknown): void

  /** Mark a tool call as actively running. */
  markRunning(turnId: string, toolCallId: string): void

  /** Mark a tool call as completed with a result. */
  markCompleted(turnId: string, toolCallId: string, result: ToolResult): void

  /** Mark a tool call as failed with an error. */
  markFailed(turnId: string, toolCallId: string, error: string): void

  /** Mark a tool call as timed out. */
  markTimedOut(turnId: string, toolCallId: string): void

  /** Check whether the turn is resolved according to its injection strategy. */
  isResolved(turnId: string): boolean

  /** Get all completed results for a turn. */
  getResults(turnId: string): ToolResult[]

  /** Get all tool call IDs that are still pending or running. */
  getPending(turnId: string): string[]

  /** Get all tool call IDs that timed out. */
  getTimedOut(turnId: string): string[]

  /** Get the full TurnState. */
  getTurn(turnId: string): TurnState | undefined

  /** Delete a turn and all its data. */
  deleteTurn(turnId: string): void
}
