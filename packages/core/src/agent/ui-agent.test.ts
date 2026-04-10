import { describe, it, expect } from 'vitest'
import { UIAgent } from './ui-agent.js'
import type { UIUpdatePayload } from './ui-agent.js'
import { InMemoryBus } from '../bus/in-memory-bus.js'

// ── Helpers ──────────────────────────────────────────────────────────────────

function createUIAgent(onUpdate?: (u: UIUpdatePayload) => void) {
  const bus = new InMemoryBus()
  const updates: UIUpdatePayload[] = []
  const uiEvents: unknown[] = []

  bus.subscribe('bus:UI_UPDATE', (d) => uiEvents.push(d))

  const agent = new UIAgent({
    bus,
    onUpdate: (u) => {
      updates.push(u)
      onUpdate?.(u)
    },
  })

  return { agent, bus, updates, uiEvents }
}

// ── Tests ────────────────────────────────────────────────────────────────────

describe('UIAgent', () => {
  // ── DRAFT lifecycle ─────────────────────────────────────────────

  describe('DRAFT_CREATED', () => {
    it('publishes UI_UPDATE order_panel show with draft data', async () => {
      const { agent, updates, uiEvents } = createUIAgent()

      await agent.onEvent('bus:DRAFT_CREATED', {
        event: 'DRAFT_CREATED',
        draft_id: 'draft_001',
        session_id: 'session-1',
        intent_id: 'order_create',
        summary: { product: 'Nike Air 42', total: 18500 },
        ttl: 120,
      })

      expect(updates).toHaveLength(1)
      expect(updates[0]).toMatchObject({
        component: 'order_panel',
        action: 'show',
        data: {
          draft_id: 'draft_001',
          intent_id: 'order_create',
          summary: { product: 'Nike Air 42', total: 18500 },
        },
      })
      expect(uiEvents).toHaveLength(1)
      expect((uiEvents[0] as any).event).toBe('UI_UPDATE')
    })
  })

  describe('DRAFT_CONFIRMED', () => {
    it('publishes UI_UPDATE order_panel confirmed', async () => {
      const { agent, updates } = createUIAgent()

      await agent.onEvent('bus:DRAFT_CONFIRMED', {
        event: 'DRAFT_CONFIRMED',
        draft_id: 'draft_001',
        session_id: 'session-1',
        intent_id: 'order_create',
        items: { product: 'Nike Air 42', qty: 1 },
        total: 18500,
      })

      expect(updates).toHaveLength(1)
      expect(updates[0]).toMatchObject({
        component: 'order_panel',
        action: 'confirmed',
        data: {
          draft_id: 'draft_001',
          total: 18500,
          message: '✅ Orden confirmada',
        },
      })
    })
  })

  describe('DRAFT_CANCELLED', () => {
    it('publishes UI_UPDATE order_panel hide', async () => {
      const { agent, updates } = createUIAgent()

      await agent.onEvent('bus:DRAFT_CANCELLED', {
        event: 'DRAFT_CANCELLED',
        draft_id: 'draft_001',
        session_id: 'session-1',
        reason: 'user_cancelled',
      })

      expect(updates).toHaveLength(1)
      expect(updates[0]).toMatchObject({
        component: 'order_panel',
        action: 'hide',
        data: {
          draft_id: 'draft_001',
          reason: 'user_cancelled',
        },
      })
    })
  })

  // ── TOOL_RESULT ─────────────────────────────────────────────────

  describe('TOOL_RESULT', () => {
    it('publishes UI_UPDATE product_grid show on product_search', async () => {
      const { agent, updates } = createUIAgent()

      await agent.onEvent('bus:TOOL_RESULT', {
        event: 'TOOL_RESULT',
        tool_name: 'product_search',
        result: [
          { name: 'Nike Air Max', price: 18500 },
          { name: 'Adidas Superstar', price: 15000 },
        ],
        query: 'tenis',
      })

      expect(updates).toHaveLength(1)
      expect(updates[0]).toMatchObject({
        component: 'product_grid',
        action: 'show',
      })
      expect((updates[0].data as any).results).toHaveLength(2)
    })

    it('ignores TOOL_RESULT for non-product_search tools', async () => {
      const { agent, updates } = createUIAgent()

      await agent.onEvent('bus:TOOL_RESULT', {
        event: 'TOOL_RESULT',
        tool_name: 'inventory_check',
        result: { stock: 5 },
      })

      expect(updates).toHaveLength(0)
    })
  })

  // ── TARGET_GROUP_CHANGED ────────────────────────────────────────

  describe('TARGET_GROUP_CHANGED', () => {
    it('publishes UI_UPDATE queue_status update', async () => {
      const { agent, updates } = createUIAgent()

      await agent.onEvent('bus:TARGET_GROUP_CHANGED', {
        event: 'TARGET_GROUP_CHANGED',
        store_id: 'store_001',
        primary: 'spk_A',
        queued: ['spk_B'],
        ambient: ['spk_C'],
        speakers: [
          { speakerId: 'spk_A', state: 'targeted' },
          { speakerId: 'spk_B', state: 'queued' },
          { speakerId: 'spk_C', state: 'ambient' },
        ],
        timestamp: Date.now(),
      })

      expect(updates).toHaveLength(1)
      expect(updates[0]).toMatchObject({
        component: 'queue_status',
        action: 'update',
        data: {
          primary: 'spk_A',
          queued: ['spk_B'],
          ambient: ['spk_C'],
        },
      })
    })
  })

  // ── APPROVAL_RESOLVED ──────────────────────────────────────────

  describe('APPROVAL_RESOLVED', () => {
    it('publishes UI_UPDATE approval_bar update', async () => {
      const { agent, updates } = createUIAgent()

      await agent.onEvent('bus:APPROVAL_RESOLVED', {
        event: 'APPROVAL_RESOLVED',
        request_id: 'req_001',
        draft_id: 'draft_001',
        approved: true,
        approver_id: 'manager_1',
        channel_used: 'voice',
        timestamp: Date.now(),
      })

      expect(updates).toHaveLength(1)
      expect(updates[0]).toMatchObject({
        component: 'approval_bar',
        action: 'update',
        data: {
          approved: true,
          channel_used: 'voice',
        },
      })
    })
  })

  describe('ORDER_QUEUED_NO_APPROVER', () => {
    it('publishes UI_UPDATE approval_queue show', async () => {
      const { agent, updates } = createUIAgent()

      await agent.onEvent('bus:ORDER_QUEUED_NO_APPROVER', {
        event: 'ORDER_QUEUED_NO_APPROVER',
        request_id: 'req_001',
        draft_id: 'draft_001',
        session_id: 'session-1',
        required_role: 'manager',
        queued_at: Date.now(),
      })

      expect(updates).toHaveLength(1)
      expect(updates[0]).toMatchObject({
        component: 'approval_queue',
        action: 'show',
        data: {
          request_id: 'req_001',
          required_role: 'manager',
        },
      })
    })
  })

  // ── PROACTIVE_TRIGGER ──────────────────────────────────────────

  describe('PROACTIVE_TRIGGER', () => {
    it('publishes UI_UPDATE suggestion show', async () => {
      const { agent, updates } = createUIAgent()

      await agent.onEvent('bus:PROACTIVE_TRIGGER', {
        event: 'PROACTIVE_TRIGGER',
        session_id: 'session-1',
        reason: 'idle_customer',
        context: { idle_ms: 30000 },
      })

      expect(updates).toHaveLength(1)
      expect(updates[0]).toMatchObject({
        component: 'suggestion',
        action: 'show',
        data: {
          reason: 'idle_customer',
        },
      })
    })
  })

  // ── STAFF_COMMAND ──────────────────────────────────────────────

  describe('STAFF_COMMAND', () => {
    it('publishes UI_UPDATE staff_bar show', async () => {
      const { agent, updates } = createUIAgent()

      await agent.onEvent('bus:STAFF_COMMAND', {
        event: 'STAFF_COMMAND',
        session_id: 'session-1',
        command: 'apply_discount',
        staff_id: 'spk_cashier',
        params: { percentage: 10 },
        result: { discount_applied: true, new_total: 16650 },
        timestamp: Date.now(),
      })

      expect(updates).toHaveLength(1)
      expect(updates[0]).toMatchObject({
        component: 'staff_bar',
        action: 'show',
        data: {
          command: 'apply_discount',
          staff_id: 'spk_cashier',
        },
      })
    })
  })

  // ── Edge cases ────────────────────────────────────────────────

  describe('edge cases', () => {
    it('ignores irrelevant events', async () => {
      const { agent, updates, uiEvents } = createUIAgent()

      await agent.onEvent('bus:HEARTBEAT', {
        event: 'HEARTBEAT',
        agent_id: 'ProactiveAgent',
      })

      expect(updates).toHaveLength(0)
      expect(uiEvents).toHaveLength(0)
    })

    it('draft data appears correctly in UI_UPDATE.data', async () => {
      const { agent, updates } = createUIAgent()

      const summary = { product: 'Tenis Rojos', size: 42, total: 18500 }

      await agent.onEvent('bus:DRAFT_CREATED', {
        event: 'DRAFT_CREATED',
        draft_id: 'draft_002',
        session_id: 'session-1',
        intent_id: 'order_create',
        summary,
        ttl: 60,
      })

      expect(updates[0].data!.summary).toEqual(summary)
      expect(updates[0].data!.draft_id).toBe('draft_002')
    })

    it('multiple rapid events are all published in order', async () => {
      const { agent, updates } = createUIAgent()

      await agent.onEvent('bus:DRAFT_CREATED', {
        event: 'DRAFT_CREATED',
        draft_id: 'draft_001',
        session_id: 'session-1',
        intent_id: 'order_create',
        summary: { product: 'Nike' },
        ttl: 120,
      })

      await agent.onEvent('bus:DRAFT_CONFIRMED', {
        event: 'DRAFT_CONFIRMED',
        draft_id: 'draft_001',
        session_id: 'session-1',
        intent_id: 'order_create',
        items: { product: 'Nike' },
        total: 18500,
      })

      await agent.onEvent('bus:STAFF_COMMAND', {
        event: 'STAFF_COMMAND',
        session_id: 'session-1',
        command: 'apply_discount',
        staff_id: 'spk_cashier',
        params: { percentage: 10 },
        result: { ok: true },
        timestamp: Date.now(),
      })

      expect(updates).toHaveLength(3)
      expect(updates[0].component).toBe('order_panel')
      expect(updates[0].action).toBe('show')
      expect(updates[1].component).toBe('order_panel')
      expect(updates[1].action).toBe('confirmed')
      expect(updates[2].component).toBe('staff_bar')
      expect(updates[2].action).toBe('show')
    })

    it('onUpdate callback is invoked before bus publish', async () => {
      const order: string[] = []

      const bus = new InMemoryBus()
      bus.subscribe('bus:UI_UPDATE', () => order.push('bus'))

      const agent = new UIAgent({
        bus,
        onUpdate: () => order.push('callback'),
      })

      await agent.onEvent('bus:DRAFT_CREATED', {
        event: 'DRAFT_CREATED',
        draft_id: 'd1',
        session_id: 's1',
        intent_id: 'i1',
        summary: {},
        ttl: 60,
      })

      expect(order).toEqual(['callback', 'bus'])
    })
  })
})
