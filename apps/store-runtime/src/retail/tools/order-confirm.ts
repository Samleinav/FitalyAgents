import type { OrderAdapter } from '../adapters/catalog.js'
import type { IStoreTool } from '../../tools/registry.js'
import { readRecord, readString } from '../../tools/tool-input.js'

export function createOrderConfirmTool(deps: { adapter: OrderAdapter }): IStoreTool {
  return {
    tool_id: 'order_confirm',
    description: 'Confirm an open order.',
    safety: 'protected',
    confirm_prompt: 'La orden esta lista. Confirmo el cierre de la venta?',
    input_schema: {
      type: 'object',
      properties: {
        order_id: { type: 'string' },
      },
      required: ['order_id'],
    },
    async execute(input, context) {
      const orderId = readString(readRecord(input).order_id)
      if (!orderId) {
        throw new Error('order_confirm requires order_id')
      }

      return deps.adapter.execute('confirm', { order_id: orderId }, context)
    },
  }
}
