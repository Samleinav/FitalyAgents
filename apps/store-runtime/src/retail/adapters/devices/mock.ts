import type { RetailAdapterCatalogDeps } from '../catalog.js'
import type {
  AdapterExecutionContext,
  AdapterHealth,
  ReceiptPrintResult,
  ReceiptPrinterAdapter,
} from '../catalog.js'

export function createMockDeviceAdapterCatalog(_deps: RetailAdapterCatalogDeps): {
  receiptPrinter: ReceiptPrinterAdapter
} {
  return {
    receiptPrinter: {
      driver: 'mock',
      capabilities() {
        return ['receipt_print']
      },
      async health(): Promise<AdapterHealth> {
        return {
          ok: true,
          driver: 'mock',
          details: {
            device: 'receipt_printer',
          },
        }
      },
      async execute(
        _action: 'receipt_print',
        input: {
          order_id: string
          reprint?: boolean
        },
        _context: AdapterExecutionContext,
      ): Promise<ReceiptPrintResult> {
        const receiptId = `receipt_${Date.now()}`
        return {
          receipt_id: receiptId,
          print_job_id: `job_${Date.now()}`,
          order_id: input.order_id,
          status: 'printed',
          text: input.reprint
            ? `Reimprimí el comprobante ${receiptId}.`
            : `Imprimí el comprobante ${receiptId}.`,
        }
      },
    },
  }
}
