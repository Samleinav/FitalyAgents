import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest'
import { InMemoryBus } from '../bus/in-memory-bus.js'
import { InMemoryDraftStore } from './draft-store.js'
import type { IEventBus } from '../types/index.js'

describe('InMemoryDraftStore', () => {
  let bus: IEventBus
  let store: InMemoryDraftStore

  beforeEach(() => {
    vi.useFakeTimers()
    bus = new InMemoryBus()
    store = new InMemoryDraftStore({ bus })
  })

  afterEach(() => {
    store.dispose()
    vi.useRealTimers()
  })

  // ── create() ───────────────────────────────────────────────────────

  describe('create()', () => {
    it('creates a draft and returns an ID', async () => {
      const id = await store.create('session-1', {
        intent_id: 'order_create',
        items: { product: 'Nike Air', size: 42 },
        total: 15000,
      })

      expect(id).toMatch(/^draft_/)
      const draft = await store.get(id)
      expect(draft).not.toBeNull()
      expect(draft!.status).toBe('draft')
      expect(draft!.items.product).toBe('Nike Air')
      expect(draft!.total).toBe(15000)
    })

    it('publishes bus:DRAFT_CREATED', async () => {
      const events: unknown[] = []
      bus.subscribe('bus:DRAFT_CREATED', (data) => events.push(data))

      await store.create('session-1', {
        intent_id: 'order_create',
        items: { product: 'Nike Air' },
      })

      expect(events).toHaveLength(1)
      expect(events[0]).toMatchObject({
        event: 'DRAFT_CREATED',
        session_id: 'session-1',
        intent_id: 'order_create',
      })
    })

    it('can be found by session ID', async () => {
      await store.create('session-1', {
        intent_id: 'order_create',
        items: { product: 'Nike Air' },
      })

      const draft = await store.getBySession('session-1')
      expect(draft).not.toBeNull()
      expect(draft!.intent_id).toBe('order_create')
    })
  })

  // ── update() ───────────────────────────────────────────────────────

  describe('update()', () => {
    it('updates draft items and saves history', async () => {
      const id = await store.create('session-1', {
        intent_id: 'order_create',
        items: { product: 'Nike Air', color: 'blue' },
      })

      const updated = await store.update(id, { color: 'red' })

      expect(updated.items.color).toBe('red')
      expect(updated.items.product).toBe('Nike Air')
      expect(updated.history).toHaveLength(1)
    })

    it('renews TTL on update', async () => {
      const id = await store.create('session-1', {
        intent_id: 'order_create',
        items: { product: 'Nike Air' },
        ttl_seconds: 10,
      })

      // Advance 8 seconds (within TTL)
      vi.advanceTimersByTime(8_000)

      // Update (should renew TTL to 10s from now)
      await store.update(id, { color: 'red' })

      // Advance 8 more seconds (total 16s from creation, but within renewed TTL)
      vi.advanceTimersByTime(8_000)

      const draft = await store.get(id)
      expect(draft).not.toBeNull()
      expect(draft!.status).toBe('draft')
    })

    it('throws if draft not found', async () => {
      await expect(store.update('nonexistent', {})).rejects.toThrow('Draft not found')
    })

    it('throws if draft is already confirmed', async () => {
      const id = await store.create('session-1', {
        intent_id: 'order_create',
        items: { product: 'Nike Air' },
      })
      await store.confirm(id)

      await expect(store.update(id, {})).rejects.toThrow('cannot update')
    })
  })

  // ── confirm() ──────────────────────────────────────────────────────

  describe('confirm()', () => {
    it('confirms a draft', async () => {
      const id = await store.create('session-1', {
        intent_id: 'order_create',
        items: { product: 'Nike Air' },
        total: 15000,
      })

      await store.confirm(id)

      const draft = await store.get(id)
      expect(draft!.status).toBe('confirmed')
    })

    it('publishes bus:DRAFT_CONFIRMED', async () => {
      const events: unknown[] = []
      bus.subscribe('bus:DRAFT_CONFIRMED', (data) => events.push(data))

      const id = await store.create('session-1', {
        intent_id: 'order_create',
        items: { product: 'Nike Air' },
        total: 15000,
      })

      await store.confirm(id)

      expect(events).toHaveLength(1)
      expect(events[0]).toMatchObject({
        event: 'DRAFT_CONFIRMED',
        session_id: 'session-1',
        total: 15000,
      })
    })

    it('removes from session index after confirm', async () => {
      const id = await store.create('session-1', {
        intent_id: 'order_create',
        items: {},
      })
      await store.confirm(id)

      const bySession = await store.getBySession('session-1')
      expect(bySession).toBeNull()
    })
  })

  // ── cancel() ───────────────────────────────────────────────────────

  describe('cancel()', () => {
    it('cancels and removes a draft', async () => {
      const id = await store.create('session-1', {
        intent_id: 'order_create',
        items: {},
      })

      await store.cancel(id)

      const draft = await store.get(id)
      expect(draft).toBeNull()
    })

    it('publishes bus:DRAFT_CANCELLED', async () => {
      const events: unknown[] = []
      bus.subscribe('bus:DRAFT_CANCELLED', (data) => events.push(data))

      const id = await store.create('session-1', {
        intent_id: 'order_create',
        items: {},
      })

      await store.cancel(id)

      expect(events).toHaveLength(1)
      expect(events[0]).toMatchObject({
        event: 'DRAFT_CANCELLED',
        reason: 'cancelled_by_user',
      })
    })
  })

  // ── rollback() ─────────────────────────────────────────────────────

  describe('rollback()', () => {
    it('reverts to previous state', async () => {
      const id = await store.create('session-1', {
        intent_id: 'order_create',
        items: { product: 'Nike Air', color: 'blue' },
      })

      await store.update(id, { color: 'red' })
      const rolled = await store.rollback(id)

      expect(rolled.items.color).toBe('blue')
    })

    it('can rollback multiple times through history', async () => {
      const id = await store.create('session-1', {
        intent_id: 'order_create',
        items: { product: 'Nike Air', color: 'blue', size: 42 },
      })

      await store.update(id, { color: 'red' })
      await store.update(id, { size: 44 })

      // Rollback to red (before size change)
      let rolled = await store.rollback(id)
      expect(rolled.items.color).toBe('red')

      // Rollback to blue (original)
      rolled = await store.rollback(id)
      expect(rolled.items.color).toBe('blue')
    })

    it('throws if no history', async () => {
      const id = await store.create('session-1', {
        intent_id: 'order_create',
        items: {},
      })

      await expect(store.rollback(id)).rejects.toThrow('no history')
    })
  })

  // ── TTL expiry ─────────────────────────────────────────────────────

  describe('TTL expiry', () => {
    it('auto-cancels draft after TTL', async () => {
      const events: unknown[] = []
      bus.subscribe('bus:DRAFT_CANCELLED', (data) => events.push(data))

      await store.create('session-1', {
        intent_id: 'order_create',
        items: {},
        ttl_seconds: 5,
      })

      vi.advanceTimersByTime(5_000)

      expect(events).toHaveLength(1)
      expect(events[0]).toMatchObject({
        event: 'DRAFT_CANCELLED',
        reason: 'ttl_expired',
      })
    })

    it('removes expired draft from store', async () => {
      const id = await store.create('session-1', {
        intent_id: 'order_create',
        items: {},
        ttl_seconds: 5,
      })

      vi.advanceTimersByTime(5_000)

      const draft = await store.get(id)
      expect(draft).toBeNull()
    })
  })

  // ── Full lifecycle ─────────────────────────────────────────────────

  describe('full lifecycle', () => {
    it('create → update → confirm', async () => {
      const id = await store.create('session-1', {
        intent_id: 'order_create',
        items: { product: 'Nike Air', color: 'blue', size: 42 },
        total: 15000,
      })

      await store.update(id, { color: 'red' })
      await store.confirm(id)

      const draft = await store.get(id)
      expect(draft!.status).toBe('confirmed')
      expect(draft!.items.color).toBe('red')
    })

    it('create → update → rollback → confirm', async () => {
      const id = await store.create('session-1', {
        intent_id: 'order_create',
        items: { product: 'Nike Air', color: 'blue' },
      })

      await store.update(id, { color: 'red' })
      await store.rollback(id)
      await store.confirm(id)

      const draft = await store.get(id)
      expect(draft!.status).toBe('confirmed')
      expect(draft!.items.color).toBe('blue') // rolled back to original
    })
  })
})
