import type { ITENClient, Gesture, QuickResponse } from './types.js'

/**
 * Recorded call for inspection in tests.
 */
export interface RecordedCall {
    method: string
    args: unknown[]
    timestamp: number
}

/**
 * Map of intent IDs to quick response overrides.
 */
export type QuickResponseMap = Record<string, QuickResponse>

/**
 * Mock TEN Client for testing the InteractionAgent.
 *
 * Records all calls and returns configurable responses.
 * Simulates the ~50-150ms latency of the real TEN Framework.
 *
 * @example
 * ```typescript
 * const tenClient = new MockTENClient({
 *   quickResponses: {
 *     'product_search': { text: 'Let me look that up for you!', gesture: 'thinking' },
 *   },
 *   latencyMs: 10, // speed up tests
 * })
 * ```
 */
export class MockTENClient implements ITENClient {
    public calls: RecordedCall[] = []
    private quickResponses: QuickResponseMap
    private latencyMs: number

    constructor(opts: {
        quickResponses?: QuickResponseMap
        latencyMs?: number
    } = {}) {
        this.quickResponses = opts.quickResponses ?? {}
        this.latencyMs = opts.latencyMs ?? 5
    }

    async generateQuickResponse(
        _context: Record<string, unknown>,
        intentId: string,
    ): Promise<QuickResponse> {
        this.record('generateQuickResponse', [_context, intentId])
        await this.delay()

        return this.quickResponses[intentId] ?? {
            text: 'One moment please...',
            gesture: 'thinking' as Gesture,
        }
    }

    async displayGesture(sessionId: string, gesture: Gesture): Promise<void> {
        this.record('displayGesture', [sessionId, gesture])
        await this.delay()
    }

    async displayOrder(sessionId: string, data: Record<string, unknown>): Promise<void> {
        this.record('displayOrder', [sessionId, data])
        await this.delay()
    }

    // ── Test helpers ──────────────────────────────────────────────────────

    getCallsFor(method: string): RecordedCall[] {
        return this.calls.filter((c) => c.method === method)
    }

    reset(): void {
        this.calls = []
    }

    private record(method: string, args: unknown[]): void {
        this.calls.push({ method, args, timestamp: Date.now() })
    }

    private delay(): Promise<void> {
        return new Promise((r) => setTimeout(r, this.latencyMs))
    }
}
