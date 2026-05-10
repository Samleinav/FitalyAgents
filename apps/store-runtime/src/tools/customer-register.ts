import type { CustomerAdapter } from '../retail/adapters/catalog.js'
import type { IStoreTool } from './registry.js'
import { readRecord, readString } from './tool-input.js'

export function createCustomerRegisterTool(deps: { adapter: CustomerAdapter }): IStoreTool {
  return {
    tool_id: 'customer_register',
    description: 'Register a new customer profile.',
    safety: 'staged',
    confirm_prompt: 'Tengo los datos del cliente listos. Confirmas?',
    input_schema: {
      type: 'object',
      properties: {
        name: { type: 'string' },
        locale: { type: 'string' },
        metadata: { type: 'object' },
      },
      required: ['name'],
    },
    async execute(input, context) {
      const payload = readRecord(input)
      const name = readString(payload.name)
      if (!name) {
        throw new Error('customer_register requires name')
      }

      return deps.adapter.execute(
        'register',
        {
          name,
          locale: readString(payload.locale),
          metadata: readRecord(payload.metadata),
        },
        context,
      )
    },
  }
}
