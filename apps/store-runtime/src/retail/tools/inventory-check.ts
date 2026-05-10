import type { InventoryAdapter } from '../adapters/catalog.js'
import type { IStoreTool } from '../../tools/registry.js'
import { readInteger, readRecord, readString } from '../../tools/tool-input.js'

export function createInventoryCheckTool(deps: { adapter: InventoryAdapter }): IStoreTool {
  return {
    tool_id: 'inventory_check',
    description: 'Check product inventory by product id or query.',
    safety: 'safe',
    input_schema: {
      type: 'object',
      properties: {
        product_id: { type: 'string' },
        query: { type: 'string' },
        limit: { type: 'number' },
      },
    },
    async execute(input, context) {
      const payload = readRecord(input)
      return deps.adapter.execute(
        'inventory_check',
        {
          product_id: readString(payload.product_id),
          query: readString(payload.query),
          limit: readInteger(payload.limit),
        },
        context,
      )
    },
  }
}
