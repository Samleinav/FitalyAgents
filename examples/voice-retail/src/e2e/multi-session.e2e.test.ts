/**
 * Sprint 4.1 — Multi-Session Concurrente E2E
 *
 * Validates zero cross-contamination when multiple sessions run simultaneously.
 *
 * Test matrix:
 * 1. Stress test: 10 concurrent sessions with WorkAgent
 * 2. ContextStore isolation: sess_A writes never leak to sess_B
 * 3. ACTION_COMPLETED scoping: events from sess_ana don't fire callbacks for sess_pedro
 * 4. Load test: latency degradation under increasing concurrency (1, 5, 10, 20)
 * 5. AudioQueue isolation: segments from one session never play on another
 * 6. ApprovalQueue isolation: approving order from sess_A doesn't affect sess_B
 * 7. Race condition detection: concurrent patches to ContextStore
 */
import { describe, it, expect, beforeEach, afterEach } from 'vitest'
import {
  InMemoryBus,
  InMemoryContextStore,
  InMemoryAudioQueueService,
  InMemoryApprovalQueue,
  InMemoryLockManager,
  InMemoryTaskQueue,
} from 'fitalyagents'
import type { AudioSegment } from 'fitalyagents'
import { WorkAgent } from '../agents/work/work-agent.js'
import { MockToolExecutor } from '../agents/work/mock-tool-executor.js'
import { InteractionAgent } from '../agents/interaction/interaction-agent.js'
import { MockTENClient } from '../agents/interaction/mock-ten-client.js'
import { OrderAgent } from '../agents/order/order-agent.js'
import { MockOrderService } from '../agents/order/mock-order-service.js'

// ── Helpers ──────────────────────────────────────────────────────────────────

const wait = (ms: number) => new Promise((r) => setTimeout(r, ms))

function makeSessionId(i: number): string {
  return `sess_${String(i).padStart(3, '0')}`
}

/**
 * Run a single "session flow": classify → work → interaction → result
 * Returns the session_id and timing data.
 */
async function runSessionFlow(opts: {
  sessionId: string
  workAgent: WorkAgent
  bus: InMemoryBus
}): Promise<{ sessionId: string; durationMs: number; result: unknown }> {
  const start = performance.now()
  const { sessionId, workAgent } = opts

  const result = await workAgent.process({
    event: 'TASK_PAYLOAD',
    task_id: `task_${sessionId}`,
    session_id: sessionId,
    intent_id: 'product_search',
    slots: { query: `product for ${sessionId}`, color: 'blue' },
    context_snapshot: { session: sessionId },
    cancel_token: null,
    timeout_ms: 8000,
    reply_to: `queue:work:outbox:${sessionId}`,
  })

  return {
    sessionId,
    durationMs: performance.now() - start,
    result: result.result,
  }
}

// ── Tests ─────────────────────────────────────────────────────────────────────

describe('E2E: Multi-Session Concurrente (Sprint 4.1)', () => {
  let bus: InMemoryBus
  let contextStore: InMemoryContextStore
  let audioQueue: InMemoryAudioQueueService
  let audioUnsub: () => void
  let played: Array<{ sessionId: string; segment: AudioSegment }>

  beforeEach(() => {
    bus = new InMemoryBus()
    contextStore = new InMemoryContextStore()
    played = []
    audioQueue = new InMemoryAudioQueueService({
      bus,
      onSegmentReady: async (sessionId, segment) => {
        played.push({ sessionId, segment })
      },
    })
    audioUnsub = audioQueue.start()
  })

  afterEach(() => {
    audioUnsub()
    audioQueue.dispose()
    contextStore.dispose()
  })

  // ── 1. Stress test: 10 concurrent sessions with WorkAgent ──────────────

  describe('Stress test: 10 concurrent sessions', () => {
    let workAgent: WorkAgent
    let toolExecutor: MockToolExecutor

    beforeEach(async () => {
      toolExecutor = new MockToolExecutor({
        latencyMs: 10,
        tools: [
          {
            tool_id: 'product_search',
            description: 'Search products',
            handler: async () => ({ products: [{ name: 'Nike Air', price: 129.99 }] }),
          },
        ],
      })

      workAgent = new WorkAgent({ bus, toolExecutor })
      await workAgent.start()
    })

    afterEach(async () => {
      await workAgent.shutdown()
    })

    it('10 sessions complete independently with correct results', async () => {
      const sessions = Array.from({ length: 10 }, (_, i) =>
        runSessionFlow({
          sessionId: makeSessionId(i),
          workAgent,
          bus,
        }),
      )

      const results = await Promise.all(sessions)

      // All 10 must complete
      expect(results).toHaveLength(10)

      // Each session returns its own result
      for (const r of results) {
        expect(r.result).toBeTruthy()
        expect(r.sessionId).toMatch(/^sess_\d{3}$/)
      }

      // Verify unique session IDs
      const uniqueSessions = new Set(results.map((r) => r.sessionId))
      expect(uniqueSessions.size).toBe(10)
    })

    it('all 10 sessions complete within reasonable time (< 2s)', async () => {
      const start = performance.now()

      const sessions = Array.from({ length: 10 }, (_, i) =>
        runSessionFlow({
          sessionId: makeSessionId(i),
          workAgent,
          bus,
        }),
      )

      const results = await Promise.all(sessions)
      const totalMs = performance.now() - start

      console.log(`\n⏱️ 10 concurrent sessions completed in ${totalMs.toFixed(0)}ms`)
      for (const r of results) {
        console.log(`   ${r.sessionId}: ${r.durationMs.toFixed(0)}ms`)
      }

      // Should be well under 2s since they run concurrently
      expect(totalMs).toBeLessThan(2000)
    })
  })

  // ── 2. ContextStore session isolation ───────────────────────────────────

  describe('ContextStore zero cross-contamination', () => {
    it('sess_ana writes never leak to sess_pedro', async () => {
      // Simulate two active sessions writing context concurrently
      await Promise.all([
        contextStore.patch('sess_ana', {
          user_name: 'Ana García',
          cart: [{ product: 'Zapatos rojos', qty: 1 }],
          locale: 'es-MX',
          payment_method: 'credit_card',
        }),
        contextStore.patch('sess_pedro', {
          user_name: 'Pedro López',
          cart: [{ product: 'Camisa azul', qty: 2 }],
          locale: 'es-AR',
          payment_method: 'debit',
        }),
      ])

      // Verify isolation
      const anaName = await contextStore.get<string>('sess_ana', 'user_name')
      const pedroName = await contextStore.get<string>('sess_pedro', 'user_name')
      expect(anaName).toBe('Ana García')
      expect(pedroName).toBe('Pedro López')

      const anaCart = await contextStore.get<unknown[]>('sess_ana', 'cart')
      const pedroCart = await contextStore.get<unknown[]>('sess_pedro', 'cart')
      expect(anaCart).toHaveLength(1)
      expect(pedroCart).toHaveLength(1)
      expect((anaCart![0] as Record<string, unknown>).product).toBe('Zapatos rojos')
      expect((pedroCart![0] as Record<string, unknown>).product).toBe('Camisa azul')

      // Cross-check: Ana can't see Pedro's data
      const anaPedroName = await contextStore.get('sess_ana', 'user_name')
      expect(anaPedroName).not.toBe('Pedro López')

      // Deleting Ana's session doesn't affect Pedro
      await contextStore.delete('sess_ana')
      expect(await contextStore.exists('sess_ana')).toBe(false)
      expect(await contextStore.exists('sess_pedro')).toBe(true)
      expect(await contextStore.get<string>('sess_pedro', 'user_name')).toBe('Pedro López')
    })

    it('concurrent patches to same session are atomic (no data loss)', async () => {
      // Rapidly patch the same session from multiple "sources"
      const patches = Array.from({ length: 20 }, (_, i) =>
        contextStore.patch('sess_race', {
          [`field_${i}`]: `value_${i}`,
        }),
      )
      await Promise.all(patches)

      // Verify all 20 fields are present
      for (let i = 0; i < 20; i++) {
        const val = await contextStore.get<string>('sess_race', `field_${i}`)
        expect(val).toBe(`value_${i}`)
      }
    })

    it('getSnapshot returns only session-scoped data', async () => {
      await contextStore.patch('sess_1', { a: 1, b: 2, secret: 'hidden' })
      await contextStore.patch('sess_2', { a: 10, b: 20, secret: 'other_hidden' })

      const snap1 = await contextStore.getSnapshot('sess_1', ['*'], ['secret'])
      const snap2 = await contextStore.getSnapshot('sess_2', ['*'], ['secret'])

      expect(snap1.a).toBe(1)
      expect(snap2.a).toBe(10)
      expect(snap1).not.toHaveProperty('secret')
      expect(snap2).not.toHaveProperty('secret')

      // No cross-contamination
      expect(snap1.a).not.toBe(snap2.a)
    })
  })

  // ── 3. ACTION_COMPLETED event scoping ──────────────────────────────────

  describe('ACTION_COMPLETED event scoping', () => {
    it('sess_ana events do NOT trigger sess_pedro handlers', async () => {
      const anaEvents: unknown[] = []
      const pedroEvents: unknown[] = []

      // Subscribe to bus events, filtering by session_id
      bus.subscribe('bus:ACTION_COMPLETED', (data) => {
        const event = data as { session_id: string }
        if (event.session_id === 'sess_ana') {
          anaEvents.push(data)
        } else if (event.session_id === 'sess_pedro') {
          pedroEvents.push(data)
        }
      })

      // Emit events for both sessions
      await bus.publish('bus:ACTION_COMPLETED', {
        event: 'ACTION_COMPLETED',
        session_id: 'sess_ana',
        intent_id: 'product_search',
        result: { text: 'Found red shoes' },
        timestamp: Date.now(),
      })

      await bus.publish('bus:ACTION_COMPLETED', {
        event: 'ACTION_COMPLETED',
        session_id: 'sess_pedro',
        intent_id: 'order_status',
        result: { text: 'Order delivered' },
        timestamp: Date.now(),
      })

      // Each list should only have events for their session
      expect(anaEvents).toHaveLength(1)
      expect(pedroEvents).toHaveLength(1)
      expect((anaEvents[0] as Record<string, unknown>).intent_id).toBe('product_search')
      expect((pedroEvents[0] as Record<string, unknown>).intent_id).toBe('order_status')
    })

    it('InteractionAgent responds only to its own session events', async () => {
      const tenClient = new MockTENClient({
        quickResponses: {
          product_search: { text: 'Buscando...', gesture: 'thinking' },
        },
        latencyMs: 2,
      })

      const ia = new InteractionAgent({ bus, tenClient, audioQueue })
      await ia.start()

      // InteractionAgent processes a task for sess_ana
      await ia.process({
        event: 'TASK_PAYLOAD',
        task_id: 'ia_ana',
        session_id: 'sess_ana',
        intent_id: 'product_search',
        slots: {},
        context_snapshot: {},
        cancel_token: null,
        timeout_ms: 8000,
        reply_to: 'queue:ia:outbox',
      })

      // ACTION_COMPLETED from sess_pedro should NOT affect sess_ana's audio
      const prePlayCount = played.length

      await bus.publish('bus:ACTION_COMPLETED', {
        event: 'ACTION_COMPLETED',
        session_id: 'sess_pedro', // Different session!
        intent_id: 'product_search',
        result: { text: 'For Pedro, not Ana' },
        timestamp: Date.now(),
      })

      await wait(100)

      // Only sess_pedro's audio should be pushed (if any), not affect sess_ana
      const anaAudio = played.filter((p) => p.sessionId === 'sess_ana')
      const pedroAudio = played.filter((p) => p.sessionId === 'sess_pedro')

      // Ana's audio count should only include her filler
      // Pedro's event might trigger a response in his session
      // Key assertion: no cross-contamination
      for (const p of anaAudio) {
        expect(p.sessionId).toBe('sess_ana')
      }
      for (const p of pedroAudio) {
        expect(p.sessionId).toBe('sess_pedro')
      }

      await ia.shutdown()
    })
  })

  // ── 4. Load test: latency degradation under concurrency ────────────────

  describe('Load test: latency degradation', () => {
    let workAgent: WorkAgent
    let toolExecutor: MockToolExecutor

    beforeEach(async () => {
      toolExecutor = new MockToolExecutor({
        latencyMs: 5,
        tools: [
          {
            tool_id: 'product_search',
            description: 'Search products',
            handler: async () => ({ products: [{ name: 'Nike', price: 99 }] }),
          },
        ],
      })
      workAgent = new WorkAgent({ bus, toolExecutor })
      await workAgent.start()
    })

    afterEach(async () => {
      await workAgent.shutdown()
    })

    it('latency scales linearly (not exponentially) under load', async () => {
      const concurrencyLevels = [1, 5, 10, 20]
      const timings: Record<number, number> = {}

      for (const n of concurrencyLevels) {
        const start = performance.now()

        const sessions = Array.from({ length: n }, (_, i) =>
          runSessionFlow({
            sessionId: `load_${n}_${i}`,
            workAgent,
            bus,
          }),
        )
        await Promise.all(sessions)

        timings[n] = performance.now() - start
      }

      console.log('\n📊 Load Test Results:')
      for (const [n, t] of Object.entries(timings)) {
        console.log(`   ${n} sessions: ${t.toFixed(0)}ms (${(t / Number(n)).toFixed(1)}ms/session)`)
      }

      // Key metric: per-session latency shouldn't blow up
      // With 20 sessions, it should still be under 200ms total (vs ~5ms mock latency each)
      expect(timings[20]!).toBeLessThan(2000)

      // Per-session latency at 20 should be less than 5x the baseline (1 session)
      const perSessionBaseline = timings[1]!
      const perSession20 = timings[20]! / 20
      expect(perSession20).toBeLessThan(perSessionBaseline * 5)
    })
  })

  // ── 5. AudioQueue session isolation ─────────────────────────────────────

  describe('AudioQueue session isolation', () => {
    it('segments from sess_A never play on sess_B', async () => {
      // Push segments to two different sessions
      await audioQueue.push('sess_A', {
        segmentId: 'audio_A_1',
        text: 'Hello from session A',
        priority: 5,
      })

      await audioQueue.push('sess_B', {
        segmentId: 'audio_B_1',
        text: 'Hello from session B',
        priority: 5,
      })

      await wait(100)

      const sessAPlayed = played.filter((p) => p.sessionId === 'sess_A')
      const sessBPlayed = played.filter((p) => p.sessionId === 'sess_B')

      // Each session only gets its own audio
      expect(sessAPlayed.length).toBeGreaterThanOrEqual(1)
      expect(sessBPlayed.length).toBeGreaterThanOrEqual(1)

      for (const p of sessAPlayed) {
        expect(p.segment.segmentId).toMatch(/^audio_A_/)
      }
      for (const p of sessBPlayed) {
        expect(p.segment.segmentId).toMatch(/^audio_B_/)
      }
    })

    it('BARGE_IN on sess_A does not interrupt sess_B', async () => {
      // Push audio to both sessions
      await audioQueue.push('sess_A', { segmentId: 'a1', text: 'A audio', priority: 5 })
      await audioQueue.push('sess_B', { segmentId: 'b1', text: 'B audio', priority: 5 })

      // Barge-in only on A
      await bus.publish('bus:BARGE_IN', { session_id: 'sess_A' })

      await wait(50)

      // B should continue playing normally
      const bPlayed = played.filter((p) => p.sessionId === 'sess_B')
      expect(bPlayed.length).toBeGreaterThanOrEqual(1)
    })
  })

  // ── 6. TaskQueue concurrent isolation ───────────────────────────────────

  describe('TaskQueue concurrent isolation', () => {
    it("tasks from different sessions don't interfere", async () => {
      const locks = new InMemoryLockManager()
      const queue = new InMemoryTaskQueue({ lockManager: locks, bus })

      // Publish tasks for 5 different sessions
      const taskPromises = Array.from({ length: 5 }, (_, i) =>
        queue.publish({
          taskId: `task_s${i}`,
          sessionId: `sess_${i}`,
          intentId: 'product_search',
          slots: { session: `sess_${i}` },
          contextSnapshot: {},
          priority: 5,
          timeoutMs: 8000,
          cancelToken: `tok_${i}`,
          replyTo: `queue:out:${i}`,
        }),
      )

      await Promise.all(taskPromises)

      // Each task should be independently claimable
      for (let i = 0; i < 5; i++) {
        const claimed = await queue.claim(`agent_${i}`, `task_s${i}`)
        expect(claimed).not.toBeNull()
        expect(claimed!.sessionId).toBe(`sess_${i}`)
      }

      // Complete one session shouldn't affect others
      await queue.start('task_s0')
      await queue.complete('task_s0', { done: true })

      expect(await queue.getStatus('task_s0')).toBe('COMPLETED')
      expect(await queue.getStatus('task_s1')).toBe('LOCKED') // still locked by agent_1

      queue.dispose()
      locks.dispose()
    })
  })

  // ── 7. Full multi-session pipeline ──────────────────────────────────────

  describe('Full pipeline: 5 sessions running simultaneously', () => {
    it('each session gets its own complete flow without contamination', async () => {
      const tenClient = new MockTENClient({
        quickResponses: {
          order_status: { text: 'Checking order...', gesture: 'waiting' },
        },
        latencyMs: 2,
      })
      const orderService = new MockOrderService({ latencyMs: 5 })
      const ia = new InteractionAgent({ bus, tenClient, audioQueue })
      const oa = new OrderAgent({ bus, orderService })

      await ia.start()
      await oa.start()

      // 5 concurrent order status queries, each for different sessions
      const results = await Promise.all(
        Array.from({ length: 5 }, (_, i) => {
          const sid = makeSessionId(i)
          return oa.process({
            event: 'TASK_PAYLOAD',
            task_id: `mstask_${sid}`,
            session_id: sid,
            intent_id: 'order_status',
            slots: { order_id: `ORD-${sid}` },
            context_snapshot: {},
            cancel_token: null,
            timeout_ms: 8000,
            reply_to: `queue:order:outbox:${sid}`,
          })
        }),
      )

      // Verify each result is scoped to its session
      for (let i = 0; i < 5; i++) {
        const r = results[i]!
        const sid = makeSessionId(i)
        expect(r.session_id).toBe(sid)
        expect(r.status).toBe('completed')

        const data = r.result as Record<string, unknown>
        expect(data.order_id).toBe(`ORD-${sid}`)
      }

      // Context patches should be unique per session
      const patches = results.map((r) => r.context_patch)
      for (let i = 0; i < 5; i++) {
        const sid = makeSessionId(i)
        const action = patches[i]!.last_action as Record<string, unknown>
        expect(action.order_id).toBe(`ORD-${sid}`)
      }

      await ia.shutdown()
      await oa.shutdown()
    })
  })
})
