import { describe, expect, it } from 'vitest'
import { applyDashboardBusEvent, createStoreDashboardState } from './ui-dashboard-state.js'

describe('ui-dashboard-state', () => {
  it('folds target group and speech lifecycle into dashboard state', () => {
    let state = createStoreDashboardState('store-test')

    state = applyDashboardBusEvent(state, 'bus:TARGET_GROUP_CHANGED', {
      event: 'TARGET_GROUP_CHANGED',
      store_id: 'store-test',
      primary: 'speaker-a',
      queued: ['speaker-b'],
      ambient: ['speaker-c'],
      speakers: [
        { speakerId: 'speaker-a', state: 'targeted' },
        { speakerId: 'speaker-b', state: 'queued' },
        { speakerId: 'speaker-c', state: 'ambient' },
      ],
      timestamp: 1,
    })
    state = applyDashboardBusEvent(state, 'bus:SPEECH_FINAL', {
      event: 'SPEECH_FINAL',
      session_id: 'session-a',
      speaker_id: 'speaker-a',
      role: 'customer',
      text: 'Busco unas zapatillas de running.',
      timestamp: 2,
    })
    state = applyDashboardBusEvent(state, 'bus:RESPONSE_START', {
      event: 'RESPONSE_START',
      session_id: 'session-a',
      speaker_id: 'speaker-a',
      turn_id: 'turn-a',
      timestamp: 3,
    })
    state = applyDashboardBusEvent(state, 'bus:AVATAR_SPEAK', {
      event: 'AVATAR_SPEAK',
      session_id: 'session-a',
      speaker_id: 'speaker-a',
      turn_id: 'turn-a',
      text: 'Tengo dos modelos recomendados.',
      is_final: true,
      timestamp: 4,
    })
    state = applyDashboardBusEvent(state, 'bus:RESPONSE_END', {
      event: 'RESPONSE_END',
      session_id: 'session-a',
      speaker_id: 'speaker-a',
      turn_id: 'turn-a',
      reason: 'end_turn',
      timestamp: 5,
    })

    expect(state.queue).toMatchObject({
      primary: 'speaker-a',
      queued: ['speaker-b'],
      ambient: ['speaker-c'],
    })
    expect(state.transcript.activeSessionId).toBe('session-a')
    expect(state.transcript.activeTurnId).toBe('turn-a')
    expect(state.transcript.turns[0]).toMatchObject({
      sessionId: 'session-a',
      speakerId: 'speaker-a',
      userText: 'Busco unas zapatillas de running.',
      assistantText: 'Tengo dos modelos recomendados.',
      status: 'completed',
      assistantTurnId: 'turn-a',
    })
  })

  it('tracks UI panels and queue snapshots from UI_UPDATE payloads', () => {
    let state = createStoreDashboardState('store-test')

    state = applyDashboardBusEvent(state, 'bus:UI_UPDATE', {
      event: 'UI_UPDATE',
      component: 'queue_status',
      action: 'update',
      data: {
        primary: 'speaker-a',
        queued: ['speaker-b'],
        ambient: [],
      },
      timestamp: 10,
    })
    state = applyDashboardBusEvent(state, 'bus:UI_UPDATE', {
      event: 'UI_UPDATE',
      component: 'product_grid',
      action: 'show',
      data: {
        results: [{ id: 'sku-1', name: 'Run Flow' }],
      },
      timestamp: 11,
    })
    state = applyDashboardBusEvent(state, 'bus:UI_UPDATE', {
      event: 'UI_UPDATE',
      component: 'order_panel',
      action: 'hide',
      data: {
        draft_id: 'draft-1',
      },
      timestamp: 12,
    })
    state = applyDashboardBusEvent(state, 'bus:UI_UPDATE', {
      event: 'UI_UPDATE',
      component: 'approval_queue',
      action: 'show',
      data: {
        request_id: 'approval-1',
        draft_id: 'draft-approval-1',
        session_id: 'session-a',
        required_role: 'manager',
      },
      timestamp: 13,
    })
    state = applyDashboardBusEvent(state, 'bus:UI_UPDATE', {
      event: 'UI_UPDATE',
      component: 'approval_bar',
      action: 'update',
      data: {
        request_id: 'approval-1',
        draft_id: 'draft-approval-1',
        session_id: 'session-a',
        approved: true,
        approver_id: 'mgr-1',
        strategy: 'parallel',
      },
      timestamp: 14,
    })

    expect(state.queue.primary).toBe('speaker-a')
    expect(state.components.product_grid).toMatchObject({
      visible: true,
      action: 'show',
    })
    expect(state.components.order_panel).toMatchObject({
      visible: false,
      action: 'hide',
    })
    expect(state.approvals.pending).toHaveLength(0)
    expect(state.approvals.lastResolved).toMatchObject({
      requestId: 'approval-1',
      approved: true,
      approverId: 'mgr-1',
    })
    expect(state.recentEvents.at(-1)?.summary).toBe('UI approval_bar · update')
  })

  it('tracks approval queue and timeout events from the bus', () => {
    let state = createStoreDashboardState('store-test')

    state = applyDashboardBusEvent(state, 'bus:ORDER_QUEUED_NO_APPROVER', {
      event: 'ORDER_QUEUED_NO_APPROVER',
      request_id: 'approval-2',
      draft_id: 'draft-2',
      session_id: 'session-2',
      required_role: 'supervisor',
      queued_at: 20,
      timestamp: 20,
    })
    state = applyDashboardBusEvent(state, 'bus:ORDER_APPROVAL_TIMEOUT', {
      event: 'ORDER_APPROVAL_TIMEOUT',
      request_id: 'approval-2',
      draft_id: 'draft-2',
      timestamp: 21,
    })

    expect(state.approvals.pending).toHaveLength(0)
    expect(state.approvals.timeoutCount).toBe(1)
  })

  it('tracks cash payment tool results as staff cash collection actions', () => {
    const state = applyDashboardBusEvent(
      createStoreDashboardState('store-test'),
      'bus:TOOL_RESULT',
      {
        event: 'TOOL_RESULT',
        tool_name: 'payment_intent_create',
        session_id: 'session-pay',
        result: {
          order_id: 'ord-1',
          amount: 89900,
          payment_method: 'cash',
        },
        timestamp: 30,
      },
    )

    expect(state.staffAction).toMatchObject({
      type: 'collect_cash',
      sessionId: 'session-pay',
      orderId: 'ord-1',
      amount: 89900,
      paymentMethod: 'cash',
      triggeredAt: 30,
    })
    expect(state.staffAction?.message).toBe(
      `Recibe el efectivo del cliente: ${formatCurrency(89900)}`,
    )
  })

  it('tracks card payment tool results as staff terminal actions', () => {
    const state = applyDashboardBusEvent(
      createStoreDashboardState('store-test'),
      'bus:TOOL_RESULT',
      {
        event: 'TOOL_RESULT',
        tool_name: 'payment_intent_create',
        session_id: 'session-pay',
        result: {
          order_id: 'ord-2',
          amount: 49900,
          payment_method: 'card',
        },
        timestamp: 31,
      },
    )

    expect(state.staffAction).toMatchObject({
      type: 'card_terminal',
      sessionId: 'session-pay',
      orderId: 'ord-2',
      amount: 49900,
      paymentMethod: 'card',
      triggeredAt: 31,
    })
    expect(state.staffAction?.message).toBe(
      `El datafono está esperando la tarjeta: ${formatCurrency(49900)}`,
    )
  })

  it('clears staff actions after receipt print tool results', () => {
    let state = applyDashboardBusEvent(createStoreDashboardState('store-test'), 'bus:TOOL_RESULT', {
      event: 'TOOL_RESULT',
      tool_name: 'payment_intent_create',
      session_id: 'session-pay',
      result: {
        order_id: 'ord-3',
        amount: 12900,
        payment_method: 'cash',
      },
      timestamp: 32,
    })

    state = applyDashboardBusEvent(state, 'bus:TOOL_RESULT', {
      event: 'TOOL_RESULT',
      tool_name: 'receipt_print',
      session_id: 'session-pay',
      result: {
        order_id: 'ord-3',
      },
      timestamp: 33,
    })

    expect(state.staffAction).toBeNull()
  })

  it('clears staff actions when the session ends', () => {
    let state = applyDashboardBusEvent(createStoreDashboardState('store-test'), 'bus:TOOL_RESULT', {
      event: 'TOOL_RESULT',
      tool_name: 'payment_intent_create',
      session_id: 'session-pay',
      result: {
        order_id: 'ord-4',
        amount: 32900,
        payment_method: 'card',
      },
      timestamp: 34,
    })

    state = applyDashboardBusEvent(state, 'bus:SESSION_ENDED', {
      event: 'SESSION_ENDED',
      session_id: 'session-pay',
      timestamp: 35,
    })

    expect(state.staffAction).toBeNull()
  })
})

function formatCurrency(amount: number): string {
  return new Intl.NumberFormat('es', {
    style: 'currency',
    currency: 'USD',
  }).format(amount)
}
