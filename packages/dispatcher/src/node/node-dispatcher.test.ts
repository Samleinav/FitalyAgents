import { describe, it, expect, beforeEach, afterEach } from 'vitest'
import { NodeDispatcher } from './node-dispatcher.js'
import { InMemoryEmbeddingClassifier } from './classifier/in-memory-embedding-classifier.js'
import { InMemoryLLMFallbackAgent } from './fallback/in-memory-llm-fallback-agent.js'
import { InMemoryIntentLibrary } from './intent-library/in-memory-intent-library.js'
import { InMemoryBus } from 'fitalyagents'

describe('NodeDispatcher', () => {
  let bus: InMemoryBus
  let lib: InMemoryIntentLibrary
  let classifier: InMemoryEmbeddingClassifier
  let fallbackAgent: InMemoryLLMFallbackAgent
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

    fallbackAgent = new InMemoryLLMFallbackAgent({
      bus,
      intentLibrary: lib,
      resolver: async (text) => ({
        intent_id: 'generic_query',
        domain_required: 'customer_facing',
        scope_hint: 'general',
        capabilities_required: ['GENERAL_QUERY'],
        slots: { raw_text: text },
      }),
    })

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
})
