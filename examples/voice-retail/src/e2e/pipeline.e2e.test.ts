/**
 * Sprint 2.4 — End-to-End Integration Test
 *
 * Full pipeline: Speech → Dispatcher → WorkAgent → InteractionAgent → Audio
 *
 * This test validates that ALL components of the FitalyAgents system
 * work together through the shared event bus:
 *
 * ```
 * User speaks: "I want Nike shoes size 42"
 *   │
 *   ├── bus:SPEECH_FINAL
 *   │     ↓
 *   ├── NodeDispatcher classifies → bus:TASK_AVAILABLE
 *   │     ↓
 *   ├── [Router] routes to WorkAgent inbox
 *   │     ↓
 *   ├── WorkAgent.process()
 *   │   ├── product_search(brand:Nike, size:42) ──┐
 *   │   └── price_check(brand:Nike)  ─────────────┤  PARALLEL
 *   │                                              ↓
 *   │   → bus:ACTION_COMPLETED
 *   │     ↓
 *   ├── InteractionAgent reacts:
 *   │   ├── audio_queue_interrupt (stop filler)
 *   │   ├── audio_queue_push (real response)
 *   │   ├── audio_queue_continue (play)
 *   │   └── displayGesture('happy')
 *   │     ↓
 *   └── AudioQueueService plays segments
 * ```
 */
import { describe, it, expect, beforeEach, afterEach } from 'vitest'
import { InMemoryBus, InMemoryAudioQueueService } from 'fitalyagents'
import type { AudioSegment } from 'fitalyagents'

import { InteractionAgent } from '../agents/interaction/interaction-agent.js'
import { MockTENClient } from '../agents/interaction/mock-ten-client.js'
import { WorkAgent } from '../agents/work/work-agent.js'
import { MockToolExecutor } from '../agents/work/mock-tool-executor.js'

// ── Helpers ─────────────────────────────────────────────────────────────────

/** Wait for async event propagation */
const wait = (ms: number) => new Promise((r) => setTimeout(r, ms))

/**
 * Build the task router for E2E tests.
 * Routes TASK_AVAILABLE events to agent inboxes via the bus.
 * Routes speech intents to WorkAgent and always notifies InteractionAgent.
 */
function createSimpleRouter(bus: InMemoryBus) {
  const routes: Record<string, string> = {
    product_search: 'work-agent',
    product_search_with_price: 'work-agent',
    price_query: 'work-agent',
    order_query: 'work-agent',
  }
  const alwaysNotify = ['interaction-agent']

  return bus.subscribe('bus:TASK_AVAILABLE', (data: unknown) => {
    const event = data as {
      task_id: string
      session_id: string
      intent_id: string
      slots: Record<string, unknown>
      timeout_ms: number
    }
    const taskPayload = {
      event: 'TASK_PAYLOAD' as const,
      task_id: event.task_id,
      session_id: event.session_id,
      intent_id: event.intent_id,
      slots: event.slots ?? {},
      context_snapshot: {},
      cancel_token: null,
      timeout_ms: event.timeout_ms ?? 8000,
      reply_to: `queue:${routes[event.intent_id] ?? 'work-agent'}:outbox`,
    }
    const targetAgent = routes[event.intent_id]
    if (targetAgent) {
      void bus.publish(`queue:${targetAgent}:inbox`, taskPayload)
    }
    for (const agentId of alwaysNotify) {
      if (agentId !== targetAgent) {
        void bus.publish(`queue:${agentId}:inbox`, taskPayload)
      }
    }
  })
}

/**
 * Mock EmbeddingClassifier for E2E — always returns confident classification
 * when it recognizes the intent in the text.
 */
function createMockClassifier() {
  const intents: Record<string, string[]> = {
    product_search_with_price: ['nike shoes', 'adidas shoes', 'zapatos nike'],
    product_search: ['search', 'find', 'buscar'],
    price_query: ['price', 'cost', 'precio', 'cuánto cuesta'],
    order_query: ['order', 'orders', 'pedido'],
  }

  return {
    async init() {},
    async classify(text: string) {
      const lower = text.toLowerCase()
      for (const [intentId, keywords] of Object.entries(intents)) {
        if (keywords.some((kw) => lower.includes(kw))) {
          return {
            type: 'confident' as const,
            intent_id: intentId,
            confidence: 0.92,
            domain_required: 'customer_facing' as const,
            scope_hint: 'commerce',
            capabilities_required: [intentId.toUpperCase()],
            candidates: [{ intent_id: intentId, score: 0.92 }],
          }
        }
      }
      return {
        type: 'fallback' as const,
        confidence: 0.2,
        top_candidates: [],
      }
    },
    async reloadIntent() {},
    dispose() {},
  }
}

/**
 * Mock Fallback Agent for E2E.
 */
function createMockFallbackAgent() {
  return {
    start() {},
    dispose() {},
  }
}

// ── Test Suite ───────────────────────────────────────────────────────────────

describe('E2E: Full Voice Pipeline', () => {
  let bus: InMemoryBus
  let tenClient: MockTENClient
  let toolExecutor: MockToolExecutor
  let audioQueue: InMemoryAudioQueueService
  let interactionAgent: InteractionAgent
  let workAgent: WorkAgent
  let played: Array<{ sessionId: string; segment: AudioSegment }>
  let routerUnsub: () => void
  let audioUnsub: () => void

  // Event collectors
  let taskAvailableEvents: unknown[]
  let actionCompletedEvents: unknown[]

  beforeEach(async () => {
    bus = new InMemoryBus()
    played = []
    taskAvailableEvents = []
    actionCompletedEvents = []

    // Collect events for assertions
    bus.subscribe('bus:TASK_AVAILABLE', (d) => taskAvailableEvents.push(d))
    bus.subscribe('bus:ACTION_COMPLETED', (d) => actionCompletedEvents.push(d))

    // 1. Audio Queue Service
    audioQueue = new InMemoryAudioQueueService({
      bus,
      onSegmentReady: async (sessionId, segment) => {
        played.push({ sessionId, segment })
      },
    })
    audioUnsub = audioQueue.start()

    // 2. TEN Client (mock)
    tenClient = new MockTENClient({
      quickResponses: {
        product_search_with_price: {
          text: '¡Déjame buscar eso para ti!',
          gesture: 'thinking',
        },
        product_search: {
          text: 'Buscando productos...',
          gesture: 'thinking',
        },
      },
      latencyMs: 2,
    })

    // 3. Tool Executor (mock — stands in for LangChain.js)
    toolExecutor = new MockToolExecutor({
      latencyMs: 20,
      tools: [
        {
          tool_id: 'product_search',
          description: 'Search products',
          handler: async (input) => ({
            results: [
              { name: 'Nike Air Max 90', size: input.size ?? 42, price: 129.99 },
              { name: 'Nike Dunk Low', size: input.size ?? 42, price: 109.99 },
            ],
            total: 2,
          }),
        },
        {
          tool_id: 'price_check',
          description: 'Check price',
          handler: async () => ({
            base_price: 129.99,
            discount: 15,
            final_price: 110.49,
          }),
        },
      ],
    })

    // 4. InteractionAgent
    interactionAgent = new InteractionAgent({
      bus,
      tenClient,
      audioQueue,
    })

    // 5. WorkAgent
    workAgent = new WorkAgent({
      bus,
      toolExecutor,
    })

    // 6. Simple Router (routes TASK_AVAILABLE → agent inboxes)
    routerUnsub = createSimpleRouter(bus)

    // Start agents
    await interactionAgent.start()
    await workAgent.start()
  })

  afterEach(async () => {
    routerUnsub()
    audioUnsub()
    await interactionAgent.shutdown()
    await workAgent.shutdown()
    audioQueue.dispose()
  })

  // ── Full Pipeline ─────────────────────────────────────────────────────

  it('full pipeline: speech → classify → work (parallel) → interaction → audio', async () => {
    const start = Date.now()

    // USER SPEAKS: "I want Nike shoes size 42"
    // Simulates Process 1 (STT) publishing SPEECH_FINAL
    await bus.publish('bus:SPEECH_FINAL', {
      event: 'SPEECH_FINAL',
      session_id: 'e2e_sess_1',
      text: 'I want Nike shoes size 42',
      timestamp: Date.now(),
    })

    // The classifier should recognize "nike shoes" → product_search_with_price
    // But our simple router intercepts TASK_AVAILABLE directly
    // We need to simulate the classifier step manually
    const classifier = createMockClassifier()
    const classified = await classifier.classify('I want Nike shoes size 42')

    expect(classified.type).toBe('confident')
    if (classified.type === 'confident') {
      // Publish TASK_AVAILABLE (normally done by NodeDispatcher)
      await bus.publish('bus:TASK_AVAILABLE', {
        event: 'TASK_AVAILABLE',
        task_id: `e2e_task_${Date.now()}`,
        session_id: 'e2e_sess_1',
        intent_id: classified.intent_id,
        domain_required: classified.domain_required,
        scope_hint: classified.scope_hint,
        capabilities_required: classified.capabilities_required,
        slots: { brand: 'Nike', size: 42 },
        priority: 5,
        source: 'classifier',
        classifier_confidence: classified.confidence,
        timeout_ms: 8000,
        created_at: Date.now(),
      })
    }

    // Wait for the full async pipeline to complete
    await wait(500)

    const elapsed = Date.now() - start

    // ── Assertions ──────────────────────────────────────────────────────

    // 1. TASK_AVAILABLE was published
    expect(taskAvailableEvents.length).toBe(1)

    // 2. WorkAgent executed tools in parallel
    expect(toolExecutor.executionLog.length).toBe(2)
    const toolIds = toolExecutor.executionLog.map((l) => l.request.tool_id)
    expect(toolIds).toContain('product_search')
    expect(toolIds).toContain('price_check')

    // 3. ACTION_COMPLETED was published by WorkAgent
    expect(actionCompletedEvents.length).toBeGreaterThanOrEqual(1)

    // 4. InteractionAgent called TEN for quick response + gestures
    const quickCalls = tenClient.getCallsFor('generateQuickResponse')
    expect(quickCalls.length).toBeGreaterThanOrEqual(1)

    const gestureCalls = tenClient.getCallsFor('displayGesture')
    // thinking (filler) + filler gesture + happy (ACTION_COMPLETED reaction)
    expect(gestureCalls.length).toBeGreaterThanOrEqual(2)
    const gestureTypes = gestureCalls.map((c) => c.args[1])
    expect(gestureTypes).toContain('thinking')
    expect(gestureTypes).toContain('happy')

    // 5. Audio was played (filler + real response)
    expect(played.length).toBeGreaterThanOrEqual(2)

    // Filler should have been played first
    const fillerSegments = played.filter((p) => p.segment.segmentId.startsWith('filler_'))
    expect(fillerSegments.length).toBeGreaterThanOrEqual(1)

    // Real response should also be present
    const realSegments = played.filter((p) => p.segment.segmentId.startsWith('response_'))
    expect(realSegments.length).toBeGreaterThanOrEqual(1)

    // 6. Performance: entire pipeline should complete quickly with mocks
    expect(elapsed).toBeLessThan(800)

    console.log(`\n📊 E2E Pipeline Metrics:`)
    console.log(`   Total elapsed: ${elapsed}ms`)
    console.log(`   Tools executed: ${toolExecutor.executionLog.length}`)
    console.log(`   Audio segments played: ${played.length}`)
    console.log(`   TEN calls: ${tenClient.calls.length}`)
    console.log(`   Filler segments: ${fillerSegments.length}`)
    console.log(`   Real response segments: ${realSegments.length}`)
  })

  // ── Barge-in ──────────────────────────────────────────────────────────

  it('barge-in interrupts audio and stops filler', async () => {
    // Start a task that generates filler
    await interactionAgent.process({
      event: 'TASK_PAYLOAD',
      task_id: 'barge_task_1',
      session_id: 'barge_sess',
      intent_id: 'product_search',
      slots: {},
      context_snapshot: {},
      cancel_token: null,
      timeout_ms: 8000,
      reply_to: 'queue:interaction-agent:outbox',
    })

    await wait(30)

    // User interrupts: "Actually, never mind"
    await bus.publish('bus:BARGE_IN', {
      event: 'BARGE_IN',
      session_id: 'barge_sess',
      timestamp: Date.now(),
    })

    await wait(30)

    // Audio should be interrupted
    expect(audioQueue.getState('barge_sess')).toBe('interrupted')
  })

  // ── Latency benchmark ─────────────────────────────────────────────────

  it('p50 latency < 800ms with mock tools (10 iterations)', async () => {
    const latencies: number[] = []

    for (let i = 0; i < 10; i++) {
      const start = Date.now()
      const sessionId = `bench_sess_${i}`

      // Direct process — skip bus routing for benchmark
      await workAgent.process({
        event: 'TASK_PAYLOAD',
        task_id: `bench_task_${i}`,
        session_id: sessionId,
        intent_id: 'product_search_with_price',
        slots: { brand: 'Nike', size: 42 },
        context_snapshot: {},
        cancel_token: null,
        timeout_ms: 8000,
        reply_to: 'queue:work-agent:outbox',
      })

      latencies.push(Date.now() - start)
    }

    latencies.sort((a, b) => a - b)
    const p50 = latencies[4]! // median of 10
    const p95 = latencies[9]! // max of 10

    console.log(`\n📊 Latency Benchmark (10 iterations):`)
    console.log(`   p50: ${p50}ms`)
    console.log(`   p95: ${p95}ms`)
    console.log(`   min: ${latencies[0]}ms`)
    console.log(`   max: ${latencies[9]}ms`)
    console.log(`   all: [${latencies.join(', ')}]ms`)

    expect(p50).toBeLessThan(800)
    expect(p95).toBeLessThan(1200)
  })

  // ── Multi-session isolation ───────────────────────────────────────────

  it('multiple sessions run independently', async () => {
    // Process two sessions simultaneously
    const [resultA, resultB] = await Promise.all([
      interactionAgent.process({
        event: 'TASK_PAYLOAD',
        task_id: 'iso_task_a',
        session_id: 'iso_sess_A',
        intent_id: 'product_search',
        slots: {},
        context_snapshot: {},
        cancel_token: null,
        timeout_ms: 8000,
        reply_to: 'queue:interaction-agent:outbox',
      }),
      interactionAgent.process({
        event: 'TASK_PAYLOAD',
        task_id: 'iso_task_b',
        session_id: 'iso_sess_B',
        intent_id: 'product_search',
        slots: {},
        context_snapshot: {},
        cancel_token: null,
        timeout_ms: 8000,
        reply_to: 'queue:interaction-agent:outbox',
      }),
    ])

    expect(resultA.session_id).toBe('iso_sess_A')
    expect(resultB.session_id).toBe('iso_sess_B')
    expect(resultA.status).toBe('completed')
    expect(resultB.status).toBe('completed')

    await wait(100)

    // Both sessions should have audio
    const audioA = played.filter((p) => p.sessionId === 'iso_sess_A')
    const audioB = played.filter((p) => p.sessionId === 'iso_sess_B')
    expect(audioA.length).toBeGreaterThanOrEqual(1)
    expect(audioB.length).toBeGreaterThanOrEqual(1)
  })

  // ── Event flow validation ─────────────────────────────────────────────

  it('validates complete event sequence', async () => {
    const allEvents: Array<{ channel: string; timestamp: number }> = []

    // Capture all bus events
    const channels = [
      'bus:TASK_AVAILABLE',
      'bus:ACTION_COMPLETED',
      'bus:AUDIO_SEGMENT_QUEUED',
      'bus:AUDIO_SEGMENT_PLAYING',
      'bus:AUDIO_SEGMENT_DONE',
      'bus:AUDIO_INTERRUPTED',
      'bus:AUDIO_RESUMED',
    ]

    for (const ch of channels) {
      bus.subscribe(ch, () => allEvents.push({ channel: ch, timestamp: Date.now() }))
    }

    // Trigger the pipeline
    await bus.publish('bus:TASK_AVAILABLE', {
      event: 'TASK_AVAILABLE',
      task_id: `flow_task_${Date.now()}`,
      session_id: 'flow_sess',
      intent_id: 'product_search_with_price',
      slots: { brand: 'Nike' },
      priority: 5,
      source: 'classifier',
      classifier_confidence: 0.92,
      timeout_ms: 8000,
      created_at: Date.now(),
    })

    await wait(500)

    // Key events should have fired
    const eventChannels = allEvents.map((e) => e.channel)

    expect(eventChannels).toContain('bus:TASK_AVAILABLE')
    expect(eventChannels).toContain('bus:ACTION_COMPLETED')
    expect(eventChannels).toContain('bus:AUDIO_SEGMENT_QUEUED')

    console.log(`\n📊 Event Flow:`)
    for (const e of allEvents) {
      console.log(`   ${e.channel}`)
    }
  })
})
