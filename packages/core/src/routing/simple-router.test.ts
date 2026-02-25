import { describe, it, expect, beforeEach, afterEach } from 'vitest'
import { InMemoryBus } from '../bus/in-memory-bus.js'
import { SimpleRouter } from './simple-router.js'

describe('SimpleRouter', () => {
  let bus: InMemoryBus
  let router: SimpleRouter

  afterEach(() => {
    router?.dispose()
  })

  // ── start / dispose ───────────────────────────────────────────────────

  describe('start / dispose', () => {
    it('starts and returns an unsubscribe function', () => {
      bus = new InMemoryBus()
      router = new SimpleRouter({ bus, routes: { search: 'work-agent' } })
      const stop = router.start()
      expect(typeof stop).toBe('function')
    })

    it('throws if started twice', () => {
      bus = new InMemoryBus()
      router = new SimpleRouter({ bus, routes: {} })
      router.start()
      expect(() => router.start()).toThrow('already started')
    })

    it('can be restarted after dispose', () => {
      bus = new InMemoryBus()
      router = new SimpleRouter({ bus, routes: {} })
      router.start()
      router.dispose()
      expect(() => router.start()).not.toThrow()
    })
  })

  // ── routing ───────────────────────────────────────────────────────────

  describe('routing', () => {
    beforeEach(() => {
      bus = new InMemoryBus()
    })

    it('routes TASK_AVAILABLE to the correct agent inbox', async () => {
      router = new SimpleRouter({
        bus,
        routes: { product_search: 'work-agent' },
      })
      router.start()

      await bus.publish('bus:TASK_AVAILABLE', {
        event: 'TASK_AVAILABLE',
        task_id: 'task_001',
        session_id: 'sess_1',
        intent_id: 'product_search',
        slots: { query: 'nike' },
        priority: 5,
      })

      const payload = await bus.brpop('queue:work-agent:inbox', 1)
      expect(payload).not.toBeNull()
      const p = payload as Record<string, unknown>
      expect(p.event).toBe('TASK_PAYLOAD')
      expect(p.task_id).toBe('task_001')
      expect(p.intent_id).toBe('product_search')
      expect(p.reply_to).toBe('queue:work-agent:outbox')
    })

    it('ignores unknown intents', async () => {
      router = new SimpleRouter({
        bus,
        routes: { product_search: 'work-agent' },
      })
      router.start()

      await bus.publish('bus:TASK_AVAILABLE', {
        event: 'TASK_AVAILABLE',
        task_id: 'task_002',
        session_id: 'sess_1',
        intent_id: 'unknown_intent',
        slots: {},
        priority: 5,
      })

      // No message should arrive in any inbox
      const payload = await bus.brpop('queue:work-agent:inbox', 0.1)
      expect(payload).toBeNull()
    })

    it('routes different intents to different agents', async () => {
      router = new SimpleRouter({
        bus,
        routes: {
          product_search: 'work-agent',
          order_create: 'order-agent',
        },
      })
      router.start()

      await bus.publish('bus:TASK_AVAILABLE', {
        event: 'TASK_AVAILABLE',
        task_id: 'task_search',
        session_id: 'sess_1',
        intent_id: 'product_search',
        slots: {},
        priority: 5,
      })
      await bus.publish('bus:TASK_AVAILABLE', {
        event: 'TASK_AVAILABLE',
        task_id: 'task_order',
        session_id: 'sess_1',
        intent_id: 'order_create',
        slots: {},
        priority: 5,
      })

      const workMsg = await bus.brpop('queue:work-agent:inbox', 1)
      const orderMsg = await bus.brpop('queue:order-agent:inbox', 1)

      expect((workMsg as Record<string, unknown>).task_id).toBe('task_search')
      expect((orderMsg as Record<string, unknown>).task_id).toBe('task_order')
    })

    it('preserves slots from the TASK_AVAILABLE event', async () => {
      router = new SimpleRouter({
        bus,
        routes: { product_search: 'work-agent' },
      })
      router.start()

      await bus.publish('bus:TASK_AVAILABLE', {
        event: 'TASK_AVAILABLE',
        task_id: 'task_003',
        session_id: 'sess_1',
        intent_id: 'product_search',
        slots: { brand: 'Nike', size: 42 },
        priority: 5,
      })

      const payload = await bus.brpop('queue:work-agent:inbox', 1)
      expect((payload as Record<string, unknown>).slots).toEqual({ brand: 'Nike', size: 42 })
    })
  })

  // ── alwaysNotify ─────────────────────────────────────────────────────

  describe('alwaysNotify', () => {
    beforeEach(() => {
      bus = new InMemoryBus()
    })

    it('broadcasts to alwaysNotify agents for every intent', async () => {
      router = new SimpleRouter({
        bus,
        routes: { product_search: 'work-agent' },
        alwaysNotify: ['interaction-agent'],
      })
      router.start()

      await bus.publish('bus:TASK_AVAILABLE', {
        event: 'TASK_AVAILABLE',
        task_id: 'task_004',
        session_id: 'sess_1',
        intent_id: 'product_search',
        slots: {},
        priority: 5,
      })

      const workMsg = await bus.brpop('queue:work-agent:inbox', 1)
      const iaMsg = await bus.brpop('queue:interaction-agent:inbox', 1)

      expect(workMsg).not.toBeNull()
      expect(iaMsg).not.toBeNull()

      // Primary agent keeps original task_id
      expect((workMsg as Record<string, unknown>).task_id).toBe('task_004')
      // Broadcast agent gets prefixed task_id to avoid collision
      expect((iaMsg as Record<string, unknown>).task_id).toBe('interaction-agent_task_004')
    })

    it('broadcasts to alwaysNotify even for unrouted intents', async () => {
      router = new SimpleRouter({
        bus,
        routes: {}, // no primary routes
        alwaysNotify: ['interaction-agent'],
      })
      router.start()

      await bus.publish('bus:TASK_AVAILABLE', {
        event: 'TASK_AVAILABLE',
        task_id: 'task_005',
        session_id: 'sess_1',
        intent_id: 'anything',
        slots: {},
        priority: 5,
      })

      const iaMsg = await bus.brpop('queue:interaction-agent:inbox', 1)
      expect(iaMsg).not.toBeNull()
    })
  })

  // ── unsubscribe ───────────────────────────────────────────────────────

  describe('unsubscribe', () => {
    it('stops routing after unsubscribe is called', async () => {
      bus = new InMemoryBus()
      router = new SimpleRouter({
        bus,
        routes: { product_search: 'work-agent' },
      })
      const stop = router.start()
      stop()

      await bus.publish('bus:TASK_AVAILABLE', {
        event: 'TASK_AVAILABLE',
        task_id: 'task_006',
        session_id: 'sess_1',
        intent_id: 'product_search',
        slots: {},
        priority: 5,
      })

      const payload = await bus.brpop('queue:work-agent:inbox', 0.1)
      expect(payload).toBeNull()
    })
  })
})
