import type { PaymentAdapter } from '../adapters/catalog.js'
import type { IStoreTool } from '../../tools/registry.js'
import { readNumber, readRecord, readString } from '../../tools/tool-input.js'

export function createPaymentIntentCreateTool(deps: { adapter: PaymentAdapter }): IStoreTool {
  return {
    tool_id: 'payment_intent_create',
    description:
      'Prepare payment for the current order when the customer chooses a payment method such as card or cash. Do not mention this internal tool name to the customer.',
    safety: 'protected',
    confirm_prompt: 'Tengo listo el cobro. Preparo el pago?',
    input_schema: {
      type: 'object',
      properties: {
        order_id: { type: 'string' },
        amount: { type: 'number' },
        payment_method: { type: 'string' },
      },
      required: ['order_id'],
    },
    async execute(input, context) {
      const payload = readRecord(input)
      const orderId = readString(payload.order_id)
      if (!orderId) {
        throw new Error('payment_intent_create requires order_id')
      }

      return deps.adapter.execute(
        'create_intent',
        {
          order_id: orderId,
          amount: readNumber(payload.amount),
          payment_method: readString(payload.payment_method),
        },
        context,
      )
    },
  }
}
