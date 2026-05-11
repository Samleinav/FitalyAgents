import type { OrderAdapter } from '../adapters/catalog.js'
import type { IStoreTool } from '../../tools/registry.js'
import { readOrderLines, readRecord, readString, readStringArray } from '../../tools/tool-input.js'

export function createOrderUpdateTool(deps: { adapter: OrderAdapter }): IStoreTool {
  return {
    tool_id: 'order_update',
    description: 'Update an existing order by replacing, adding, or removing line items.',
    safety: 'staged',
    confirm_prompt: 'Tengo los cambios de la orden listos. Confirmas?',
    input_schema: {
      type: 'object',
      properties: {
        order_id: { type: 'string' },
        items: { type: 'array' },
        add_items: { type: 'array' },
        remove_product_ids: { type: 'array' },
      },
      required: ['order_id'],
    },
    async execute(input, context) {
      const payload = readRecord(input)
      const orderId = readString(payload.order_id)
      if (!orderId) {
        throw new Error('order_update requires order_id')
      }

      return deps.adapter.execute(
        'update',
        {
          order_id: orderId,
          items: readOrderLines(payload.items),
          add_items: readOrderLines(payload.add_items),
          remove_product_ids: readStringArray(payload.remove_product_ids),
        },
        context,
      )
    },
  }
}
