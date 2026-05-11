import type { CustomerAdapter } from '../adapters/catalog.js'
import type { IStoreTool } from '../../tools/registry.js'
import { readInteger, readRecord, readString } from '../../tools/tool-input.js'

export function createCustomerLookupTool(deps: { adapter: CustomerAdapter }): IStoreTool {
  return {
    tool_id: 'customer_lookup',
    description: 'Find customers by id, name, phone, or email query.',
    safety: 'safe',
    input_schema: {
      type: 'object',
      properties: {
        customer_id: { type: 'string' },
        query: { type: 'string' },
        limit: { type: 'number' },
      },
    },
    async execute(input, context) {
      const payload = readRecord(input)
      return deps.adapter.execute(
        'lookup',
        {
          customer_id: readString(payload.customer_id),
          query: readString(payload.query),
          limit: readInteger(payload.limit),
        },
        context,
      )
    },
  }
}
