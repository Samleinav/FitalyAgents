import { describe, expect, it } from 'vitest'
import {
  applyCustomerDisplayBusEvent,
  createCustomerDisplayState,
} from './customer-display-state.js'

describe('customer-display-state', () => {
  it('folds draft, tool results, payment and receipt into a customer-friendly order state', () => {
    let state = createCustomerDisplayState('store-test', 'full')

    state = applyCustomerDisplayBusEvent(state, 'bus:DRAFT_CREATED', {
      event: 'DRAFT_CREATED',
      draft_id: 'draft-1',
      session_id: 'session-1',
      intent_id: 'order_create',
      summary: {
        items: [
          { product_id: 'sku-run-1', name: 'Run Flow', quantity: 1, price: 79.9 },
          { product_id: 'sku-sock-1', name: 'Performance Socks', quantity: 2, price: 9.5 },
        ],
      },
      timestamp: 1,
    })
    state = applyCustomerDisplayBusEvent(state, 'bus:DRAFT_CONFIRMED', {
      event: 'DRAFT_CONFIRMED',
      draft_id: 'draft-1',
      session_id: 'session-1',
      intent_id: 'order_create',
      items: {
        items: [
          { product_id: 'sku-run-1', name: 'Run Flow', quantity: 1, price: 79.9 },
          { product_id: 'sku-sock-1', name: 'Performance Socks', quantity: 2, price: 9.5 },
        ],
      },
      total: 98.9,
      timestamp: 2,
    })
    state = applyCustomerDisplayBusEvent(state, 'bus:TOOL_RESULT', {
      event: 'TOOL_RESULT',
      tool_name: 'order_create',
      session_id: 'session-1',
      result: {
        order_id: 'ord-1',
        order_state: 'open',
        total: 98.9,
        items: [
          {
            product_id: 'sku-run-1',
            name: 'Run Flow',
            quantity: 1,
            price: 79.9,
            line_total: 79.9,
          },
          {
            product_id: 'sku-sock-1',
            name: 'Performance Socks',
            quantity: 2,
            price: 9.5,
            line_total: 19,
          },
        ],
        text: 'La orden quedó preparada.',
      },
      timestamp: 3,
    })
    state = applyCustomerDisplayBusEvent(state, 'bus:TOOL_RESULT', {
      event: 'TOOL_RESULT',
      tool_name: 'payment_intent_create',
      session_id: 'session-1',
      result: {
        order_id: 'ord-1',
        amount: 98.9,
        payment_method: 'card',
        status: 'ready',
        text: 'Preparé el cobro.',
      },
      timestamp: 4,
    })
    state = applyCustomerDisplayBusEvent(state, 'bus:TOOL_RESULT', {
      event: 'TOOL_RESULT',
      tool_name: 'receipt_print',
      session_id: 'session-1',
      result: {
        receipt_id: 'receipt-1',
        order_id: 'ord-1',
        status: 'printed',
        text: 'Imprimí el comprobante.',
      },
      timestamp: 5,
    })

    expect(state.order).toMatchObject({
      draftId: null,
      orderId: 'ord-1',
      status: 'open',
      total: 98.9,
      paymentStatus: 'waiting',
      paymentMethod: 'card',
      receiptStatus: 'printed',
      receiptId: 'receipt-1',
    })
    expect(state.order.items).toHaveLength(2)
    expect(state.message).toMatchObject({
      body: 'Imprimí el comprobante.',
    })
  })

  it('tracks approval wait states, resolution and suggested products', () => {
    let state = createCustomerDisplayState('store-test', 'order')

    state = applyCustomerDisplayBusEvent(state, 'bus:TOOL_RESULT', {
      event: 'TOOL_RESULT',
      tool_name: 'product_search',
      session_id: 'session-2',
      result: {
        products: [
          { id: 'sku-1', name: 'Cloud Pace', price: 89.9, description: 'Daily trainer', stock: 4 },
          { id: 'sku-2', name: 'Tempo Rise', price: 109.5, description: 'Tempo option', stock: 2 },
        ],
        text: 'Tengo dos opciones.',
      },
      timestamp: 10,
    })
    state = applyCustomerDisplayBusEvent(state, 'bus:ORDER_QUEUED_NO_APPROVER', {
      event: 'ORDER_QUEUED_NO_APPROVER',
      request_id: 'approval-1',
      session_id: 'session-2',
      timestamp: 11,
    })
    state = applyCustomerDisplayBusEvent(state, 'bus:APPROVAL_RESOLVED', {
      event: 'APPROVAL_RESOLVED',
      request_id: 'approval-1',
      session_id: 'session-2',
      approved: true,
      approver_id: 'mgr-1',
      timestamp: 12,
    })
    state = applyCustomerDisplayBusEvent(state, 'bus:AVATAR_SPEAK', {
      event: 'AVATAR_SPEAK',
      session_id: 'session-2',
      text: 'Te muestro las opciones en pantalla.',
      timestamp: 13,
    })

    expect(state.suggestions).toHaveLength(2)
    expect(state.suggestions[0]).toMatchObject({
      id: 'sku-1',
      visualId: 'A1',
      stock: 4,
      stockStatus: 'low',
    })
    expect(state.suggestions[1]).toMatchObject({
      id: 'sku-2',
      visualId: 'A2',
      stock: 2,
      stockStatus: 'low',
    })
    expect(state.order.approvalStatus).toBe('approved')
    expect(state.order.refundStatus).toBe('idle')
    expect(state.message).toMatchObject({
      title: 'Asistente',
      body: 'Te muestro las opciones en pantalla.',
    })
  })

  it('keeps refund state scoped to refund tool results', () => {
    let state = createCustomerDisplayState('store-test', 'full')

    state = applyCustomerDisplayBusEvent(state, 'bus:ORDER_QUEUED_NO_APPROVER', {
      event: 'ORDER_QUEUED_NO_APPROVER',
      request_id: 'approval-2',
      session_id: 'session-3',
      timestamp: 19,
    })
    expect(state.order.approvalStatus).toBe('waiting')
    expect(state.order.refundStatus).toBe('idle')

    state = applyCustomerDisplayBusEvent(state, 'bus:TOOL_RESULT', {
      event: 'TOOL_RESULT',
      tool_name: 'refund_create',
      session_id: 'session-3',
      result: {
        refund_id: 'refund-1',
        status: 'approved',
        text: 'El reembolso quedó aprobado.',
      },
      timestamp: 20,
    })
    state = applyCustomerDisplayBusEvent(state, 'bus:APPROVAL_RESOLVED', {
      event: 'APPROVAL_RESOLVED',
      request_id: 'approval-2',
      session_id: 'session-3',
      approved: true,
      approver_id: 'mgr-1',
      timestamp: 21,
    })

    expect(state.order.approvalStatus).toBe('approved')
    expect(state.order.refundStatus).toBe('approved')
    expect(state.order.refundId).toBe('refund-1')
  })

  it('assigns stable visual ids to the visible product suggestions', () => {
    const state = applyCustomerDisplayBusEvent(
      createCustomerDisplayState('store-test', 'full'),
      'bus:TOOL_RESULT',
      {
        event: 'TOOL_RESULT',
        tool_name: 'product_search',
        session_id: 'session-4',
        result: {
          products: [
            { id: 'sku-1', name: 'Producto 1', price: 10, description: 'Uno' },
            { id: 'sku-2', name: 'Producto 2', price: 20, description: 'Dos' },
            { id: 'sku-3', name: 'Producto 3', price: 30, description: 'Tres' },
            { id: 'sku-4', name: 'Producto 4', price: 40, description: 'Cuatro' },
            { id: 'sku-5', name: 'Producto 5', price: 50, description: 'Cinco' },
            { id: 'sku-6', name: 'Producto 6', price: 60, description: 'Seis' },
            { id: 'sku-7', name: 'Producto 7', price: 70, description: 'Siete' },
          ],
        },
        timestamp: 22,
      },
    )

    expect(state.suggestions.map((product) => product.visualId)).toEqual([
      'A1',
      'A2',
      'A3',
      'A4',
      'A5',
      'A6',
    ])
    expect(state.suggestions.map((product) => product.id)).not.toContain('sku-7')
  })

  it('assigns stock statuses to product suggestions', () => {
    const state = applyCustomerDisplayBusEvent(
      createCustomerDisplayState('store-test', 'full'),
      'bus:TOOL_RESULT',
      {
        event: 'TOOL_RESULT',
        tool_name: 'product_search',
        session_id: 'session-5',
        result: {
          products: [
            { id: 'sku-out', name: 'Sin stock', price: 10, description: 'Agotado', stock: 0 },
            { id: 'sku-low', name: 'Pocas unidades', price: 20, description: 'Ultimas', stock: 5 },
            { id: 'sku-ok', name: 'Disponible', price: 30, description: 'Normal', stock: 6 },
            { id: 'sku-unknown', name: 'Sin dato', price: 40, description: 'Sin inventario' },
          ],
        },
        timestamp: 23,
      },
    )

    expect(state.suggestions.map((product) => product.stockStatus)).toEqual([
      'out',
      'low',
      'available',
      'available',
    ])
  })

  it('resets customer display state when the session ends', () => {
    let state = createCustomerDisplayState('store-test', 'full')

    state = applyCustomerDisplayBusEvent(state, 'bus:TOOL_RESULT', {
      event: 'TOOL_RESULT',
      tool_name: 'product_search',
      session_id: 'session-ended',
      speaker_id: 'customer-1',
      result: {
        products: [
          { id: 'sku-1', name: 'Cloud Pace', price: 89.9, description: 'Daily trainer', stock: 8 },
        ],
        text: 'Tengo una opcion.',
      },
      timestamp: 30,
    })
    state = applyCustomerDisplayBusEvent(state, 'bus:TOOL_RESULT', {
      event: 'TOOL_RESULT',
      tool_name: 'order_create',
      session_id: 'session-ended',
      result: {
        order_id: 'ord-ended',
        order_state: 'open',
        total: 89.9,
        items: [{ product_id: 'sku-1', name: 'Cloud Pace', quantity: 1, price: 89.9 }],
        text: 'Orden preparada.',
      },
      timestamp: 31,
    })

    state = applyCustomerDisplayBusEvent(state, 'bus:SESSION_ENDED', {
      event: 'SESSION_ENDED',
      session_id: 'session-ended',
      store_id: 'store-test',
      timestamp: 32,
    })

    expect(state).toMatchObject({
      sessionId: null,
      speakerId: null,
      suggestions: [],
      message: null,
      updatedAt: 32,
      order: createCustomerDisplayState('store-test', 'full').order,
    })
  })
})
