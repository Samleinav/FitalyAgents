import type { OrderAdapter } from '../retail/adapters/catalog.js'
import type { IStoreTool } from './registry.js'
import { readOrderLines, readRecord, readString } from './tool-input.js'

export function createOrderCreateTool(deps: { adapter: OrderAdapter }): IStoreTool {
  return {
    tool_id: 'order_create',
    description:
      'Create a draft order only when the customer explicitly asks to buy, add to cart, or checkout specific products. Do not use this for search, browsing, or "show me products" requests; use product_search first.',
    safety: 'staged',
    confirm_prompt: 'Tengo la orden lista. Confirmas?',
    input_schema: {
      type: 'object',
      properties: {
        customer_id: { type: 'string' },
        items: {
          type: 'array',
          items: {
            type: 'object',
            properties: {
              product_id: { type: 'string' },
              quantity: { type: 'number' },
              price: { type: 'number' },
            },
            required: ['product_id', 'quantity', 'price'],
          },
        },
      },
      required: ['items'],
    },
    async execute(input, context) {
      const payload = readRecord(input)
      const items = readOrderLines(payload.items)
      if (items.length === 0) {
        throw new Error('order_create requires at least one item')
      }

      return deps.adapter.execute(
        'create',
        {
          customer_id: readString(payload.customer_id),
          items,
        },
        context,
      )
    },
  }
}
