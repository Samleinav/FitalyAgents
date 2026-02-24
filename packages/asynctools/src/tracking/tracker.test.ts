import { describe, it, expect, beforeEach, vi, afterEach } from 'vitest'
import { InMemoryPendingStateTracker } from './in-memory-tracker.js'
import type { ToolResult } from '../types/index.js'

function makeResult(
  toolCallId: string,
  toolId: string,
  status: 'completed' | 'failed' = 'completed',
): ToolResult {
  return {
    tool_call_id: toolCallId,
    tool_id: toolId,
    status,
    result: status === 'completed' ? { data: 'ok' } : undefined,
    error: status === 'failed' ? 'something went wrong' : undefined,
    started_at: Date.now(),
    completed_at: Date.now(),
    duration_ms: 10,
  }
}

describe('InMemoryPendingStateTracker', () => {
  let tracker: InMemoryPendingStateTracker

  beforeEach(() => {
    tracker = new InMemoryPendingStateTracker(60_000)
  })

  afterEach(() => {
    // Clean up any lingering timers
    vi.restoreAllMocks()
  })

  // ── createTurn / getTurn / deleteTurn ─────────────────────────────────

  describe('createTurn()', () => {
    it('creates a turn with the correct properties', () => {
      const turn = tracker.createTurn('t1', 'agent_1', 'inject_when_all', 30_000)
      expect(turn.turn_id).toBe('t1')
      expect(turn.agent_id).toBe('agent_1')
      expect(turn.strategy).toBe('inject_when_all')
      expect(turn.global_timeout_ms).toBe(30_000)
      expect(turn.tool_calls.size).toBe(0)
      expect(turn.results.size).toBe(0)
    })

    it('getTurn returns the created turn', () => {
      tracker.createTurn('t1', 'agent_1', 'inject_when_all', 30_000)
      expect(tracker.getTurn('t1')).toBeDefined()
    })

    it('getTurn returns undefined for unknown turn', () => {
      expect(tracker.getTurn('unknown')).toBeUndefined()
    })

    it('deleteTurn removes the turn', () => {
      tracker.createTurn('t1', 'agent_1', 'inject_when_all', 30_000)
      tracker.deleteTurn('t1')
      expect(tracker.getTurn('t1')).toBeUndefined()
    })
  })

  // ── addPending / markRunning ──────────────────────────────────────────

  describe('addPending() and state transitions', () => {
    it('adds a pending tool call', () => {
      tracker.createTurn('t1', 'agent_1', 'inject_when_all', 30_000)
      tracker.addPending('t1', 'c1', 'search', { query: 'nike' })

      const pending = tracker.getPending('t1')
      expect(pending).toContain('c1')
    })

    it('markRunning changes status', () => {
      tracker.createTurn('t1', 'agent_1', 'inject_when_all', 30_000)
      tracker.addPending('t1', 'c1', 'search', {})
      tracker.markRunning('t1', 'c1')

      const turn = tracker.getTurn('t1')!
      expect(turn.tool_calls.get('c1')!.status).toBe('running')
      // Still in pending list since running = not terminal
      expect(tracker.getPending('t1')).toContain('c1')
    })

    it('throws for unknown turn', () => {
      expect(() => tracker.addPending('unknown', 'c1', 'search', {})).toThrow('Turn not found')
    })

    it('throws for unknown tool call', () => {
      tracker.createTurn('t1', 'agent_1', 'inject_when_all', 30_000)
      expect(() => tracker.markRunning('t1', 'unknown')).toThrow('Tool call not found')
    })
  })

  // ── markCompleted / markFailed / markTimedOut ─────────────────────────

  describe('terminal state transitions', () => {
    it('markCompleted stores the result', () => {
      tracker.createTurn('t1', 'agent_1', 'inject_when_all', 30_000)
      tracker.addPending('t1', 'c1', 'search', {})
      tracker.markRunning('t1', 'c1')

      const result = makeResult('c1', 'search')
      tracker.markCompleted('t1', 'c1', result)

      expect(tracker.getPending('t1')).toHaveLength(0)
      expect(tracker.getResults('t1')).toHaveLength(1)
      expect(tracker.getResults('t1')[0].status).toBe('completed')
    })

    it('markFailed stores the error result', () => {
      tracker.createTurn('t1', 'agent_1', 'inject_when_all', 30_000)
      tracker.addPending('t1', 'c1', 'search', {})
      tracker.markFailed('t1', 'c1', 'Connection refused')

      const results = tracker.getResults('t1')
      expect(results).toHaveLength(1)
      expect(results[0].status).toBe('failed')
      expect(results[0].error).toBe('Connection refused')
    })

    it('markTimedOut stores the timeout result', () => {
      tracker.createTurn('t1', 'agent_1', 'inject_when_all', 30_000)
      tracker.addPending('t1', 'c1', 'search', {})
      tracker.markTimedOut('t1', 'c1')

      const timedOut = tracker.getTimedOut('t1')
      expect(timedOut).toContain('c1')

      const results = tracker.getResults('t1')
      expect(results[0].status).toBe('timed_out')
    })
  })

  // ── isResolved: inject_when_all ───────────────────────────────────────

  describe('isResolved — inject_when_all', () => {
    it('returns false when no tool calls', () => {
      tracker.createTurn('t1', 'agent_1', 'inject_when_all', 30_000)
      expect(tracker.isResolved('t1')).toBe(false)
    })

    it('returns false when some calls are still pending', () => {
      tracker.createTurn('t1', 'agent_1', 'inject_when_all', 30_000)
      tracker.addPending('t1', 'c1', 'search', {})
      tracker.addPending('t1', 'c2', 'inventory', {})
      tracker.addPending('t1', 'c3', 'price', {})

      tracker.markCompleted('t1', 'c1', makeResult('c1', 'search'))
      tracker.markCompleted('t1', 'c2', makeResult('c2', 'inventory'))

      expect(tracker.isResolved('t1')).toBe(false)
    })

    it('returns true when ALL calls are terminal', () => {
      tracker.createTurn('t1', 'agent_1', 'inject_when_all', 30_000)
      tracker.addPending('t1', 'c1', 'search', {})
      tracker.addPending('t1', 'c2', 'inventory', {})
      tracker.addPending('t1', 'c3', 'price', {})

      tracker.markCompleted('t1', 'c1', makeResult('c1', 'search'))
      tracker.markFailed('t1', 'c2', 'error')
      tracker.markTimedOut('t1', 'c3')

      expect(tracker.isResolved('t1')).toBe(true)
    })
  })

  // ── isResolved: inject_when_ready ─────────────────────────────────────

  describe('isResolved — inject_when_ready', () => {
    it('returns false when no calls are completed', () => {
      tracker.createTurn('t1', 'agent_1', 'inject_when_ready', 30_000)
      tracker.addPending('t1', 'c1', 'search', {})
      tracker.addPending('t1', 'c2', 'inventory', {})

      expect(tracker.isResolved('t1')).toBe(false)
    })

    it('returns true when ANY call completes', () => {
      tracker.createTurn('t1', 'agent_1', 'inject_when_ready', 30_000)
      tracker.addPending('t1', 'c1', 'search', {})
      tracker.addPending('t1', 'c2', 'inventory', {})
      tracker.addPending('t1', 'c3', 'price', {})

      // Only first one completes
      tracker.markCompleted('t1', 'c1', makeResult('c1', 'search'))

      expect(tracker.isResolved('t1')).toBe(true)
    })

    it('returns false if only failures (no completions)', () => {
      tracker.createTurn('t1', 'agent_1', 'inject_when_ready', 30_000)
      tracker.addPending('t1', 'c1', 'search', {})
      tracker.markFailed('t1', 'c1', 'error')

      // inject_when_ready requires at least one "completed"
      expect(tracker.isResolved('t1')).toBe(false)
    })
  })

  // ── isResolved: inject_on_timeout ─────────────────────────────────────

  describe('isResolved — inject_on_timeout', () => {
    it('returns false before timeout expires', () => {
      tracker.createTurn('t1', 'agent_1', 'inject_on_timeout', 30_000)
      tracker.addPending('t1', 'c1', 'search', {})
      tracker.markCompleted('t1', 'c1', makeResult('c1', 'search'))

      // Even though completed, strategy says wait for timeout
      expect(tracker.isResolved('t1')).toBe(false)
    })

    it('returns true after timeout expires', () => {
      // Create with very short timeout
      vi.useFakeTimers()
      tracker.createTurn('t1', 'agent_1', 'inject_on_timeout', 100)
      tracker.addPending('t1', 'c1', 'search', {})

      expect(tracker.isResolved('t1')).toBe(false)

      vi.advanceTimersByTime(150)

      expect(tracker.isResolved('t1')).toBe(true)
      vi.useRealTimers()
    })
  })

  // ── Orphan cleanup ────────────────────────────────────────────────────

  describe('orphan turn cleanup (TTL)', () => {
    it('automatically deletes turn after TTL expires', () => {
      vi.useFakeTimers()

      const shortTtlTracker = new InMemoryPendingStateTracker(500)
      shortTtlTracker.createTurn('t1', 'agent_1', 'inject_when_all', 30_000)

      expect(shortTtlTracker.getTurn('t1')).toBeDefined()

      vi.advanceTimersByTime(600)

      expect(shortTtlTracker.getTurn('t1')).toBeUndefined()
      vi.useRealTimers()
    })

    it('does not delete turn before TTL expires', () => {
      vi.useFakeTimers()

      const shortTtlTracker = new InMemoryPendingStateTracker(500)
      shortTtlTracker.createTurn('t1', 'agent_1', 'inject_when_all', 30_000)

      vi.advanceTimersByTime(300)

      expect(shortTtlTracker.getTurn('t1')).toBeDefined()
      vi.useRealTimers()
    })

    it('deleteTurn cancels the TTL timer', () => {
      vi.useFakeTimers()

      const shortTtlTracker = new InMemoryPendingStateTracker(500)
      shortTtlTracker.createTurn('t1', 'agent_1', 'inject_when_all', 30_000)
      shortTtlTracker.deleteTurn('t1')

      vi.advanceTimersByTime(600)

      // Should already be deleted, no error on double-delete
      expect(shortTtlTracker.getTurn('t1')).toBeUndefined()
      vi.useRealTimers()
    })
  })

  // ── Edge cases ────────────────────────────────────────────────────────

  describe('edge cases', () => {
    it('returns empty arrays for unknown turn', () => {
      expect(tracker.getResults('unknown')).toEqual([])
      expect(tracker.getPending('unknown')).toEqual([])
      expect(tracker.getTimedOut('unknown')).toEqual([])
    })

    it('isResolved returns false for unknown turn', () => {
      expect(tracker.isResolved('unknown')).toBe(false)
    })
  })
})
