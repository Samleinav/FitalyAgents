import type { ReceiptPrinterAdapter } from '../adapters/catalog.js'
import type { IStoreTool } from '../../tools/registry.js'
import { readBoolean, readRecord, readString } from '../../tools/tool-input.js'

export function createReceiptPrintTool(deps: { adapter: ReceiptPrinterAdapter }): IStoreTool {
  return {
    tool_id: 'receipt_print',
    description: 'Print or reprint a receipt for an order.',
    safety: 'protected',
    confirm_prompt: 'Tengo listo el comprobante. Quieres imprimirlo?',
    input_schema: {
      type: 'object',
      properties: {
        order_id: { type: 'string' },
        reprint: { type: 'boolean' },
      },
      required: ['order_id'],
    },
    async execute(input, context) {
      const payload = readRecord(input)
      const orderId = readString(payload.order_id)
      if (!orderId) {
        throw new Error('receipt_print requires order_id')
      }

      return deps.adapter.execute(
        'receipt_print',
        {
          order_id: orderId,
          reprint: readBoolean(payload.reprint),
        },
        context,
      )
    },
  }
}
