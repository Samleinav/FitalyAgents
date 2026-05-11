import type { ProductAdapter } from '../retail/adapters/catalog.js'
import type { IStoreTool } from './registry.js'
import { readInteger, readString } from './tool-input.js'

export function createProductSearchTool(deps: { adapter: ProductAdapter }): IStoreTool {
  return {
    tool_id: 'product_search',
    description:
      'Search and show products by name, description, brand, size, or category. Use this when the customer asks to see, browse, list, or compare products. Do not create an order from browsing requests.',
    safety: 'safe',
    input_schema: {
      type: 'object',
      properties: {
        query: { type: 'string' },
        limit: { type: 'number' },
      },
      required: ['query'],
    },
    async execute(input, context) {
      const payload = toRecord(input)
      const query = readString(payload.query)
      if (!query) {
        throw new Error('product_search requires query')
      }

      return deps.adapter.execute(
        'search',
        {
          query,
          limit: readInteger(payload.limit),
        },
        context,
      )
    },
  }
}

function toRecord(value: unknown): Record<string, unknown> {
  return value && typeof value === 'object' ? (value as Record<string, unknown>) : {}
}
