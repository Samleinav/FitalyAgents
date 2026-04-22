import type { RetailAdapterCatalogDeps } from '../catalog.js'
import type {
  AdapterExecutionContext,
  AdapterHealth,
  PaymentAdapter,
  PaymentIntentResult,
} from '../catalog.js'

export function createMockPaymentAdapter(deps: RetailAdapterCatalogDeps): PaymentAdapter {
  return {
    driver: 'mock',
    capabilities() {
      return ['create_intent']
    },
    async health(): Promise<AdapterHealth> {
      return {
        ok: true,
        driver: 'mock',
        details: {
          connector: 'payments',
          methods: deps.config.policies.allowed_payment_methods,
        },
      }
    },
    async execute(
      _action: 'create_intent',
      input: {
        order_id: string
        amount?: number
        payment_method?: string
      },
      _context: AdapterExecutionContext,
    ): Promise<PaymentIntentResult> {
      const order = deps.repositories.orders.findById(input.order_id)
      if (!order) {
        throw new Error(`Order ${input.order_id} was not found`)
      }

      const allowedMethods = new Set(deps.config.policies.allowed_payment_methods)
      const paymentMethod =
        input.payment_method?.trim() || deps.config.policies.allowed_payment_methods[0]
      if (!allowedMethods.has(paymentMethod)) {
        throw new Error(`Payment method "${paymentMethod}" is not allowed for this store`)
      }

      const storedAmount =
        order.result && typeof order.result.total === 'number' ? order.result.total : undefined
      const amount = Number(input.amount ?? storedAmount ?? 0)
      if (amount <= 0) {
        throw new Error('payment_intent_create requires a positive amount')
      }

      return {
        payment_intent_id: `pay_${Date.now()}`,
        order_id: input.order_id,
        amount,
        payment_method: paymentMethod,
        status: 'ready',
        text: `Preparé el cobro por ${formatCurrency(amount)} con método ${paymentMethod}.`,
      }
    },
  }
}

function formatCurrency(amount: number): string {
  return new Intl.NumberFormat('es', {
    style: 'currency',
    currency: 'USD',
  }).format(amount)
}
