import { describe, it, expect, beforeEach, afterEach } from 'vitest'
import {
  NodeDispatcher,
  SPECULATIVE_CONFIDENCE_MIN,
  SPECULATIVE_MARGIN_MIN,
} from './node-dispatcher.js'
import type {
  SpeculativeToolMeta,
  IntentToolResolver,
  SpeculativeExecutor,
} from './node-dispatcher.js'
import type { MemoryScopeResolver } from '../memory/scope-resolver.js'
import { InMemoryEmbeddingClassifier } from './classifier/in-memory-embedding-classifier.js'
import { InMemoryIntentLibrary } from './intent-library/in-memory-intent-library.js'
import { SpeculativeCache } from '../speculative-cache.js'
import { InMemoryMemoryStore } from '../memory/memory-store.js'
import { InMemoryBus } from 'fitalyagents'
import type { ILLMFallbackAgent } from '../types/index.js'
import type { IEventBus, Unsubscribe } from 'fitalyagents'

// ── Mock Fallback Agent (replaces deleted InMemoryLLMFallbackAgent) ──────────

class MockFallbackAgent implements ILLMFallbackAgent {
  private unsub: Unsubscribe | null = null
  constructor(
    private readonly bus: IEventBus,
    private readonly intentLibrary: InMemoryIntentLibrary,
  ) {}

  start(): void {
    this.unsub = this.bus.subscribe('bus:DISPATCH_FALLBACK', (data) => {
      const event = data as { session_id: string; text: string }
      void this.resolve(event)
    })
  }

  private async resolve(event: { session_id: string; text: string }): Promise<void> {
    await this.bus.publish('bus:TASK_AVAILABLE', {
      event: 'TASK_AVAILABLE',
      task_id: `fallback_${Date.now()}`,
      session_id: event.session_id,
      intent_id: 'generic_query',
      domain_required: 'customer_facing',
      scope_hint: 'general',
      capabilities_required: ['GENERAL_QUERY'],
      slots: { raw_text: event.text },
      priority: 5,
      source: 'llm_fallback',
      timeout_ms: 8000,
      created_at: Date.now(),
    })

    await this.bus.publish('bus:INTENT_UPDATED', {
      event: 'INTENT_UPDATED',
      intent_id: 'generic_query',
      new_example: event.text,
      source: 'llm_fallback',
      timestamp: Date.now(),
    })
  }

  dispose(): void {
    if (this.unsub) this.unsub()
    this.unsub = null
  }
}

class NoopFallbackAgent implements ILLMFallbackAgent {
  private unsub: Unsubscribe | null = null

  constructor(private readonly bus: IEventBus) {}

  start(): void {
    this.unsub = this.bus.subscribe('bus:DISPATCH_FALLBACK', () => {
      // Intentionally unresolved: used to verify ambiguous fallbacks are not stored.
    })
  }

  dispose(): void {
    if (this.unsub) this.unsub()
    this.unsub = null
  }
}

describe('NodeDispatcher', () => {
  let bus: InMemoryBus
  let lib: InMemoryIntentLibrary
  let classifier: InMemoryEmbeddingClassifier
  let fallbackAgent: MockFallbackAgent
  let dispatcher: NodeDispatcher

  beforeEach(async () => {
    bus = new InMemoryBus()
    lib = new InMemoryIntentLibrary()

    // Bootstrap intents
    await lib.createIntent({
      intent_id: 'product_search',
      domain_required: 'customer_facing',
      scope_hint: 'commerce',
      capabilities_required: ['PRODUCT_SEARCH'],
      initial_examples: ['find shoes', 'search for sneakers', 'look for running shoes'],
    })

    classifier = new InMemoryEmbeddingClassifier(lib)

    fallbackAgent = new MockFallbackAgent(bus, lib)

    dispatcher = new NodeDispatcher({
      bus,
      classifier,
      fallbackAgent,
    })
  })

  afterEach(() => {
    dispatcher.dispose()
    lib.dispose()
  })

  it('starts and can be disposed', async () => {
    await dispatcher.start()
    expect(dispatcher.isStarted).toBe(true)
    dispatcher.dispose()
    expect(dispatcher.isStarted).toBe(false)
  })

  it('throws if started twice', async () => {
    await dispatcher.start()
    await expect(dispatcher.start()).rejects.toThrow('already started')
  })

  describe('confident classification → TASK_AVAILABLE', () => {
    it('publishes TASK_AVAILABLE when classifier is confident', async () => {
      await dispatcher.start()

      const events: unknown[] = []
      bus.subscribe('bus:TASK_AVAILABLE', (data) => {
        events.push(data)
      })

      // Publish a speech event that matches an intent exactly
      await bus.publish('bus:SPEECH_FINAL', {
        event: 'SPEECH_FINAL',
        session_id: 'sess_1',
        text: 'find shoes',
        timestamp: Date.now(),
      })

      // Give async handler time
      await new Promise((r) => setTimeout(r, 50))

      expect(events.length).toBe(1)
      expect(events[0]).toHaveProperty('event', 'TASK_AVAILABLE')
      expect(events[0]).toHaveProperty('intent_id', 'product_search')
      expect(events[0]).toHaveProperty('source', 'classifier')
    })
  })

  describe('fallback classification → DISPATCH_FALLBACK', () => {
    it('publishes DISPATCH_FALLBACK when classifier is not confident', async () => {
      await dispatcher.start()

      const fallbacks: unknown[] = []
      bus.subscribe('bus:DISPATCH_FALLBACK', (data) => {
        fallbacks.push(data)
      })

      // Publish unrecognized speech
      await bus.publish('bus:SPEECH_FINAL', {
        event: 'SPEECH_FINAL',
        session_id: 'sess_1',
        text: 'completely unrelated xyz abc 123',
        timestamp: Date.now(),
      })

      await new Promise((r) => setTimeout(r, 50))

      expect(fallbacks.length).toBe(1)
      expect(fallbacks[0]).toHaveProperty('event', 'DISPATCH_FALLBACK')
      expect(fallbacks[0]).toHaveProperty('text', 'completely unrelated xyz abc 123')
      expect(fallbacks[0]).not.toHaveProperty('memory_context')
    })

    it('adds memory_context when an optional memory store has related session history', async () => {
      const memoryStore = new InMemoryMemoryStore()
      await memoryStore.write({
        text: 'customer usually orders decaf coffee',
        wing: 'session',
        room: 'sess_1',
      })

      const memoryDispatcher = new NodeDispatcher({
        bus,
        classifier,
        fallbackAgent,
        memoryStore,
      })

      await memoryDispatcher.start()

      const fallbacks: Array<Record<string, unknown>> = []
      bus.subscribe('bus:DISPATCH_FALLBACK', (data) => {
        fallbacks.push(data as Record<string, unknown>)
      })

      await bus.publish('bus:SPEECH_FINAL', {
        event: 'SPEECH_FINAL',
        session_id: 'sess_1',
        text: 'the usual decaf please',
        timestamp: Date.now(),
      })

      await new Promise((r) => setTimeout(r, 50))

      expect(fallbacks).toHaveLength(1)
      expect(fallbacks[0]?.memory_context).toBeDefined()
      expect(fallbacks[0]?.memory_context).toHaveLength(1)

      memoryDispatcher.dispose()
    })

    it('writes session memory asynchronously after successful dispatch', async () => {
      const memoryStore = new InMemoryMemoryStore()
      const memoryDispatcher = new NodeDispatcher({
        bus,
        classifier,
        fallbackAgent,
        memoryStore,
      })

      await memoryDispatcher.start()

      await bus.publish('bus:SPEECH_FINAL', {
        event: 'SPEECH_FINAL',
        session_id: 'sess_1',
        text: 'find shoes',
        timestamp: Date.now(),
      })

      await new Promise((r) => setTimeout(r, 50))

      const hits = await memoryStore.query('find shoes', { room: 'sess_1' })
      expect(hits.length).toBeGreaterThan(0)
      expect(hits[0]?.text).toBe('find shoes')

      memoryDispatcher.dispose()
    })

    it('does not write unresolved fallback utterances into memory', async () => {
      const memoryStore = new InMemoryMemoryStore()
      const unresolvedFallbackAgent = new NoopFallbackAgent(bus)
      const memoryDispatcher = new NodeDispatcher({
        bus,
        classifier,
        fallbackAgent: unresolvedFallbackAgent,
        memoryStore,
      })

      await memoryDispatcher.start()

      await bus.publish('bus:SPEECH_FINAL', {
        event: 'SPEECH_FINAL',
        session_id: 'sess_1',
        text: 'completely unrelated xyz abc 123',
        timestamp: Date.now(),
      })

      await new Promise((r) => setTimeout(r, 50))

      const hits = await memoryStore.query('completely unrelated xyz abc 123', { room: 'sess_1' })
      expect(hits).toHaveLength(0)

      memoryDispatcher.dispose()
    })

    it('writes resolved fallback utterances into memory after llm_fallback resolution', async () => {
      const memoryStore = new InMemoryMemoryStore()
      const memoryDispatcher = new NodeDispatcher({
        bus,
        classifier,
        fallbackAgent,
        memoryStore,
      })

      await memoryDispatcher.start()

      await bus.publish('bus:SPEECH_FINAL', {
        event: 'SPEECH_FINAL',
        session_id: 'sess_1',
        text: 'completely unrelated xyz abc 123',
        timestamp: Date.now(),
      })

      await new Promise((r) => setTimeout(r, 75))

      const hits = await memoryStore.query('completely unrelated xyz abc 123', { room: 'sess_1' })
      expect(hits).toHaveLength(1)
      expect(hits[0]?.text).toBe('completely unrelated xyz abc 123')

      memoryDispatcher.dispose()
    })

    it('uses memoryScopeResolver to avoid mixing customer and employee memory in one session', async () => {
      const memoryStore = new InMemoryMemoryStore()
      const memoryScopeResolver: MemoryScopeResolver = ({ session_id, speaker_id, role }) => {
        if (role === 'customer') {
          return { wing: 'customer', room: speaker_id ?? `${session_id}:customer` }
        }

        if (role === 'staff') {
          return { wing: 'employee', room: speaker_id ?? `${session_id}:employee` }
        }

        return { wing: 'session', room: session_id }
      }

      await memoryStore.write({
        text: 'customer usually orders decaf coffee',
        wing: 'customer',
        room: 'cust_1',
      })
      await memoryStore.write({
        text: 'employee is handling inventory counting',
        wing: 'employee',
        room: 'staff_1',
      })

      const memoryDispatcher = new NodeDispatcher({
        bus,
        classifier,
        fallbackAgent,
        memoryStore,
        memoryScopeResolver,
      })

      await memoryDispatcher.start()

      const fallbacks: Array<Record<string, unknown>> = []
      bus.subscribe('bus:DISPATCH_FALLBACK', (data) => {
        fallbacks.push(data as Record<string, unknown>)
      })

      await bus.publish('bus:SPEECH_FINAL', {
        event: 'SPEECH_FINAL',
        session_id: 'shared_sess',
        speaker_id: 'cust_1',
        role: 'customer',
        text: 'the usual decaf please',
        timestamp: Date.now(),
      })

      await bus.publish('bus:SPEECH_FINAL', {
        event: 'SPEECH_FINAL',
        session_id: 'shared_sess',
        speaker_id: 'staff_1',
        role: 'staff',
        text: 'inventory count status',
        timestamp: Date.now(),
      })

      await new Promise((r) => setTimeout(r, 50))

      expect(fallbacks).toHaveLength(2)
      expect(fallbacks[0]?.memory_context).toHaveLength(1)
      expect((fallbacks[0]?.memory_context as Array<Record<string, unknown>>)[0]).toMatchObject({
        wing: 'customer',
        room: 'cust_1',
      })
      expect(fallbacks[1]?.memory_context).toHaveLength(1)
      expect((fallbacks[1]?.memory_context as Array<Record<string, unknown>>)[0]).toMatchObject({
        wing: 'employee',
        room: 'staff_1',
      })

      memoryDispatcher.dispose()
    })

    it('writes resolved llm_fallback memory into the matched actor scope', async () => {
      const memoryStore = new InMemoryMemoryStore()
      const memoryScopeResolver: MemoryScopeResolver = ({ session_id, speaker_id, role }) => {
        if (role === 'customer') {
          return { wing: 'customer', room: speaker_id ?? `${session_id}:customer` }
        }

        if (role === 'staff') {
          return { wing: 'employee', room: speaker_id ?? `${session_id}:employee` }
        }

        return { wing: 'session', room: session_id }
      }

      const memoryDispatcher = new NodeDispatcher({
        bus,
        classifier,
        fallbackAgent,
        memoryStore,
        memoryScopeResolver,
      })

      await memoryDispatcher.start()

      await bus.publish('bus:SPEECH_FINAL', {
        event: 'SPEECH_FINAL',
        session_id: 'shared_sess',
        speaker_id: 'cust_1',
        role: 'customer',
        text: 'please repeat my regular order',
        timestamp: Date.now(),
      })

      await new Promise((r) => setTimeout(r, 75))

      expect(
        await memoryStore.query('please repeat my regular order', {
          wing: 'customer',
          room: 'cust_1',
        }),
      ).toHaveLength(1)
      expect(
        await memoryStore.query('please repeat my regular order', {
          wing: 'employee',
          room: 'cust_1',
        }),
      ).toHaveLength(0)

      memoryDispatcher.dispose()
    })

    it('writes memory into distinct group, store, and session scopes', async () => {
      const memoryStore = new InMemoryMemoryStore()
      const memoryScopeResolver: MemoryScopeResolver = ({ session_id, group_id, store_id }) => {
        if (group_id) return { wing: 'group', room: group_id }
        if (store_id) return { wing: 'store', room: store_id }
        return { wing: 'session', room: session_id }
      }

      const memoryDispatcher = new NodeDispatcher({
        bus,
        classifier,
        fallbackAgent,
        memoryStore,
        memoryScopeResolver,
      })

      await memoryDispatcher.start()

      await bus.publish('bus:SPEECH_FINAL', {
        event: 'SPEECH_FINAL',
        session_id: 'sess_scope',
        text: 'find shoes',
        timestamp: Date.now(),
      })
      await bus.publish('bus:SPEECH_FINAL', {
        event: 'SPEECH_FINAL',
        session_id: 'sess_scope',
        store_id: 'store_9',
        text: 'find shoes',
        timestamp: Date.now(),
      })
      await bus.publish('bus:SPEECH_FINAL', {
        event: 'SPEECH_FINAL',
        session_id: 'sess_scope',
        group_id: 'group_A',
        text: 'find shoes',
        timestamp: Date.now(),
      })

      await new Promise((r) => setTimeout(r, 50))

      expect(
        await memoryStore.query('find shoes', { wing: 'session', room: 'sess_scope' }),
      ).toHaveLength(1)
      expect(
        await memoryStore.query('find shoes', { wing: 'store', room: 'store_9' }),
      ).toHaveLength(1)
      expect(
        await memoryStore.query('find shoes', { wing: 'group', room: 'group_A' }),
      ).toHaveLength(1)

      memoryDispatcher.dispose()
    })
  })

  describe('LLMFallbackAgent resolution', () => {
    it('fallback agent resolves and publishes TASK_AVAILABLE + INTENT_UPDATED', async () => {
      await dispatcher.start()

      const tasks: unknown[] = []
      const intentUpdates: unknown[] = []

      // The fallback agent is already subscribed to DISPATCH_FALLBACK via start()
      // We add listeners for what it produces
      bus.subscribe('bus:TASK_AVAILABLE', (data) => {
        tasks.push(data)
      })
      bus.subscribe('bus:INTENT_UPDATED', (data) => {
        intentUpdates.push(data)
      })

      // Trigger unrecognized speech → fallback → LLM resolve
      await bus.publish('bus:SPEECH_FINAL', {
        event: 'SPEECH_FINAL',
        session_id: 'sess_1',
        text: 'something entirely new and unknown',
        timestamp: Date.now(),
      })

      await new Promise((r) => setTimeout(r, 100))

      // Should have 1 TASK_AVAILABLE from the fallback agent
      expect(tasks.length).toBeGreaterThanOrEqual(1)
      const fallbackTask = tasks.find(
        (t) => (t as Record<string, unknown>).source === 'llm_fallback',
      )
      expect(fallbackTask).toBeDefined()
      expect(fallbackTask).toHaveProperty('intent_id', 'generic_query')

      // Should have INTENT_UPDATED
      expect(intentUpdates.length).toBeGreaterThanOrEqual(1)
    })
  })

  describe('intent reload', () => {
    it('reloads intent when INTENT_UPDATED is published', async () => {
      await dispatcher.start()

      // Add a new example to the library manually
      await lib.addExample('product_search', 'zapatillas deportivas')

      // Publish INTENT_UPDATED → classifier should reload
      await bus.publish('bus:INTENT_UPDATED', {
        event: 'INTENT_UPDATED',
        intent_id: 'product_search',
        new_example: 'zapatillas deportivas',
        source: 'test',
        timestamp: Date.now(),
      })

      await new Promise((r) => setTimeout(r, 50))

      // Now classify — should be confident
      const result = await classifier.classify('zapatillas deportivas')
      expect(result.type).toBe('confident')
    })
  })

  describe('lock watchdog', () => {
    it('calls watchdog tick at configured interval', async () => {
      let tickCount = 0
      const customDispatcher = new NodeDispatcher({
        bus,
        classifier,
        fallbackAgent,
        watchdogIntervalMs: 50,
        onWatchdogTick: async () => {
          tickCount++
        },
      })

      await customDispatcher.start()

      // Wait for a few ticks
      await new Promise((r) => setTimeout(r, 180))

      expect(tickCount).toBeGreaterThanOrEqual(2)

      customDispatcher.dispose()
    })
  })

  // ── Sprint 5.1: SPEECH_PARTIAL + Speculative Cache ──────────────────────

  describe('SPEECH_PARTIAL → speculative execution', () => {
    let cache: SpeculativeCache
    let executorCalls: Array<{ intentId: string; sessionId: string }>
    let speculativeDispatcher: NodeDispatcher

    const toolResolver: IntentToolResolver = (intentId) => {
      const toolMap: Record<string, SpeculativeToolMeta> = {
        product_search: { tool_id: 'product_search', safety: 'safe' },
        order_create: { tool_id: 'order_create', safety: 'staged' },
        refund_process: { tool_id: 'refund_process', safety: 'protected' },
        delete_account: { tool_id: 'delete_account', safety: 'restricted' },
      }
      return toolMap[intentId] ?? null
    }

    const speculativeExecutor: SpeculativeExecutor = async (intentId, sessionId) => {
      executorCalls.push({ intentId, sessionId })
      return { results: [{ name: 'Nike Air Max', price: 120 }] }
    }

    beforeEach(async () => {
      cache = new SpeculativeCache({ maxEntries: 64 })
      executorCalls = []

      // Add more intents for different safety levels
      await lib.createIntent({
        intent_id: 'order_create',
        domain_required: 'customer_facing',
        scope_hint: 'commerce',
        capabilities_required: ['ORDER_CREATE'],
        initial_examples: ['create an order', 'place an order', 'I want to buy this'],
      })
      await lib.createIntent({
        intent_id: 'refund_process',
        domain_required: 'customer_facing',
        scope_hint: 'commerce',
        capabilities_required: ['REFUND_PROCESS'],
        initial_examples: ['process a refund', 'I want a refund', 'refund my purchase'],
      })
      await lib.createIntent({
        intent_id: 'delete_account',
        domain_required: 'customer_facing',
        scope_hint: 'account',
        capabilities_required: ['DELETE_ACCOUNT'],
        initial_examples: ['delete my account', 'remove my account', 'erase my account'],
      })

      speculativeDispatcher = new NodeDispatcher({
        bus,
        classifier,
        fallbackAgent,
        speculativeCache: cache,
        intentToolResolver: toolResolver,
        speculativeExecutor: speculativeExecutor,
      })
    })

    afterEach(() => {
      speculativeDispatcher.dispose()
    })

    it('does not subscribe to SPEECH_PARTIAL without speculativeCache', async () => {
      // Default dispatcher (no cache) — no partial listener
      await dispatcher.start()

      const events: unknown[] = []
      bus.subscribe('bus:SPECULATIVE_HIT', (data) => events.push(data))

      await bus.publish('bus:SPEECH_PARTIAL', {
        event: 'SPEECH_PARTIAL',
        session_id: 'sess_1',
        text: 'find shoes',
        timestamp: Date.now(),
      })

      await new Promise((r) => setTimeout(r, 50))
      expect(events.length).toBe(0)
    })

    it('pre-executes SAFE tool on confident SPEECH_PARTIAL', async () => {
      await speculativeDispatcher.start()

      const hits: unknown[] = []
      bus.subscribe('bus:SPECULATIVE_HIT', (data) => hits.push(data))

      await bus.publish('bus:SPEECH_PARTIAL', {
        event: 'SPEECH_PARTIAL',
        session_id: 'sess_1',
        text: 'find shoes',
        timestamp: Date.now(),
      })

      await new Promise((r) => setTimeout(r, 50))

      // Executor should have been called
      expect(executorCalls.length).toBe(1)
      expect(executorCalls[0]).toEqual({ intentId: 'product_search', sessionId: 'sess_1' })

      // Cache should have the result
      const cached = cache.get('sess_1', 'product_search')
      expect(cached).not.toBeNull()
      expect(cached!.type).toBe('tool_result')
      if (cached!.type === 'tool_result') {
        expect(cached!.result).toEqual({ results: [{ name: 'Nike Air Max', price: 120 }] })
      }

      // SPECULATIVE_HIT event should be published
      expect(hits.length).toBe(1)
      expect(hits[0]).toHaveProperty('intent_id', 'product_search')
    })

    it('caches hint for PROTECTED tools (no execution)', async () => {
      await speculativeDispatcher.start()

      await bus.publish('bus:SPEECH_PARTIAL', {
        event: 'SPEECH_PARTIAL',
        session_id: 'sess_2',
        text: 'process a refund',
        timestamp: Date.now(),
      })

      await new Promise((r) => setTimeout(r, 50))

      // Executor should NOT have been called
      expect(executorCalls.length).toBe(0)

      // Cache should have a hint
      const cached = cache.get('sess_2', 'refund_process')
      expect(cached).not.toBeNull()
      expect(cached!.type).toBe('hint')
    })

    it('caches hint for RESTRICTED tools (no execution)', async () => {
      await speculativeDispatcher.start()

      await bus.publish('bus:SPEECH_PARTIAL', {
        event: 'SPEECH_PARTIAL',
        session_id: 'sess_3',
        text: 'delete my account',
        timestamp: Date.now(),
      })

      await new Promise((r) => setTimeout(r, 50))

      // Executor should NOT have been called
      expect(executorCalls.length).toBe(0)

      // Cache should have a hint
      const cached = cache.get('sess_3', 'delete_account')
      expect(cached).not.toBeNull()
      expect(cached!.type).toBe('hint')
    })

    it('caches hint for STAGED tools (no pre-execution)', async () => {
      await speculativeDispatcher.start()

      await bus.publish('bus:SPEECH_PARTIAL', {
        event: 'SPEECH_PARTIAL',
        session_id: 'sess_4',
        text: 'create an order',
        timestamp: Date.now(),
      })

      await new Promise((r) => setTimeout(r, 50))

      expect(executorCalls.length).toBe(0)

      const cached = cache.get('sess_4', 'order_create')
      expect(cached).not.toBeNull()
      expect(cached!.type).toBe('hint')
    })

    it('does not re-execute if cache already has an entry', async () => {
      await speculativeDispatcher.start()

      // First PARTIAL
      await bus.publish('bus:SPEECH_PARTIAL', {
        event: 'SPEECH_PARTIAL',
        session_id: 'sess_1',
        text: 'find shoes',
        timestamp: Date.now(),
      })
      await new Promise((r) => setTimeout(r, 50))

      // Second PARTIAL — same session + intent
      await bus.publish('bus:SPEECH_PARTIAL', {
        event: 'SPEECH_PARTIAL',
        session_id: 'sess_1',
        text: 'find shoes',
        timestamp: Date.now(),
      })
      await new Promise((r) => setTimeout(r, 50))

      // Should only execute once
      expect(executorCalls.length).toBe(1)
    })

    it('ignores low-confidence SPEECH_PARTIAL', async () => {
      await speculativeDispatcher.start()

      await bus.publish('bus:SPEECH_PARTIAL', {
        event: 'SPEECH_PARTIAL',
        session_id: 'sess_1',
        text: 'completely unrelated xyz abc 123',
        timestamp: Date.now(),
      })

      await new Promise((r) => setTimeout(r, 50))

      expect(executorCalls.length).toBe(0)
      expect(cache.size).toBe(0)
    })

    it('handles speculative executor failure gracefully', async () => {
      const failingExecutor: SpeculativeExecutor = async () => {
        throw new Error('tool failed')
      }

      const failDispatcher = new NodeDispatcher({
        bus,
        classifier,
        fallbackAgent,
        speculativeCache: cache,
        intentToolResolver: toolResolver,
        speculativeExecutor: failingExecutor,
      })

      await failDispatcher.start()

      // Should not throw
      await bus.publish('bus:SPEECH_PARTIAL', {
        event: 'SPEECH_PARTIAL',
        session_id: 'sess_1',
        text: 'find shoes',
        timestamp: Date.now(),
      })

      await new Promise((r) => setTimeout(r, 50))

      // Cache should be empty (execution failed)
      expect(cache.size).toBe(0)

      failDispatcher.dispose()
    })

    it('PARTIAL → cache → FINAL uses cached result (0ms tool wait)', async () => {
      await speculativeDispatcher.start()

      // Step 1: SPEECH_PARTIAL populates cache
      await bus.publish('bus:SPEECH_PARTIAL', {
        event: 'SPEECH_PARTIAL',
        session_id: 'sess_1',
        text: 'find shoes',
        timestamp: Date.now(),
      })
      await new Promise((r) => setTimeout(r, 50))

      // Verify cache is populated
      const cached = cache.get('sess_1', 'product_search')
      expect(cached).not.toBeNull()
      expect(cached!.type).toBe('tool_result')

      // Step 2: SPEECH_FINAL arrives — dispatcher publishes TASK_AVAILABLE
      const tasks: unknown[] = []
      bus.subscribe('bus:TASK_AVAILABLE', (data) => tasks.push(data))

      await bus.publish('bus:SPEECH_FINAL', {
        event: 'SPEECH_FINAL',
        session_id: 'sess_1',
        text: 'find shoes',
        timestamp: Date.now(),
      })
      await new Promise((r) => setTimeout(r, 50))

      // TASK_AVAILABLE should be published (normal flow)
      expect(tasks.length).toBe(1)

      // The cached result is still available for the InteractionAgent
      // to use (0ms tool wait) — the LLM won't have to wait for tool execution
      const stillCached = cache.get('sess_1', 'product_search')
      expect(stillCached).not.toBeNull()
    })

    it('different sessions get independent speculative results', async () => {
      await speculativeDispatcher.start()

      await bus.publish('bus:SPEECH_PARTIAL', {
        event: 'SPEECH_PARTIAL',
        session_id: 'sess_A',
        text: 'find shoes',
        timestamp: Date.now(),
      })
      await bus.publish('bus:SPEECH_PARTIAL', {
        event: 'SPEECH_PARTIAL',
        session_id: 'sess_B',
        text: 'process a refund',
        timestamp: Date.now(),
      })

      await new Promise((r) => setTimeout(r, 50))

      // Session A has tool_result
      const cacheA = cache.get('sess_A', 'product_search')
      expect(cacheA).not.toBeNull()
      expect(cacheA!.type).toBe('tool_result')

      // Session B has hint
      const cacheB = cache.get('sess_B', 'refund_process')
      expect(cacheB).not.toBeNull()
      expect(cacheB!.type).toBe('hint')

      // No cross-contamination
      expect(cache.get('sess_A', 'refund_process')).toBeNull()
      expect(cache.get('sess_B', 'product_search')).toBeNull()
    })

    it('unknown intent (no tool resolver match) is ignored', async () => {
      // Create an intent without a tool mapping
      await lib.createIntent({
        intent_id: 'greet_customer',
        domain_required: 'customer_facing',
        scope_hint: 'social',
        capabilities_required: ['GREETING'],
        initial_examples: ['hello there', 'hi how are you', 'good morning'],
      })

      // Reload classifier to pick up new intent
      // The InMemoryEmbeddingClassifier auto-inits, but we need to re-create
      const spec2 = new NodeDispatcher({
        bus,
        classifier,
        fallbackAgent,
        speculativeCache: cache,
        intentToolResolver: toolResolver,
        speculativeExecutor: speculativeExecutor,
      })
      await spec2.start()

      await bus.publish('bus:SPEECH_PARTIAL', {
        event: 'SPEECH_PARTIAL',
        session_id: 'sess_1',
        text: 'hello there',
        timestamp: Date.now(),
      })

      await new Promise((r) => setTimeout(r, 50))

      // No execution, no cache
      expect(executorCalls.length).toBe(0)
      expect(cache.size).toBe(0)

      spec2.dispose()
    })
  })

  // ── Constants are exported correctly ────────────────────────────────────

  describe('speculative constants', () => {
    it('exports thresholds', () => {
      expect(SPECULATIVE_CONFIDENCE_MIN).toBe(0.9)
      expect(SPECULATIVE_MARGIN_MIN).toBe(0.15)
    })
  })
})
