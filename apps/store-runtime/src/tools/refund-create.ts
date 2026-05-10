import type { IStoreTool } from './registry.js'
import { readNumber, readRecord, readString } from './tool-input.js'

export function createRefundCreateTool(): IStoreTool {
  return {
    tool_id: 'refund_create',
    description: 'Create a refund request for manager approval.',
    safety: 'restricted',
    required_role: 'manager',
    input_schema: {
      type: 'object',
      properties: {
        order_id: { type: 'string' },
        amount: { type: 'number' },
        reason: { type: 'string' },
      },
      required: ['order_id', 'amount'],
    },
    async execute(input) {
      const payload = readRecord(input)
      const orderId = readString(payload.order_id)
      const amount = readNumber(payload.amount)

      if (!orderId) {
        throw new Error('refund_create requires order_id')
      }
      if (amount == null || amount <= 0) {
        throw new Error('refund_create requires a positive amount')
      }

      const refundId = `refund_${Date.now()}`
      return {
        refund_id: refundId,
        order_id: orderId,
        amount,
        reason: readString(payload.reason) ?? 'customer_request',
        status: 'queued',
        text: `Prepare la solicitud de devolucion ${refundId} por ${formatCurrency(amount)}.`,
      }
    },
  }
}

function formatCurrency(amount: number): string {
  return new Intl.NumberFormat('es', {
    style: 'currency',
    currency: 'USD',
  }).format(amount)
}
