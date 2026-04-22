import type Database from 'better-sqlite3'
import type { StoreConfig } from '../config/schema.js'
import type { StoreRepositories, ToolRegistry } from '../tools/registry.js'
import { createCustomerRegisterTool } from '../tools/customer-register.js'
import { createOrderCreateTool } from '../tools/order-create.js'
import { createProductSearchTool } from '../tools/product-search.js'
import { createRefundCreateTool } from '../tools/refund-create.js'
import { type IStoreTool } from '../tools/registry.js'
import { createRetailAdapterCatalog } from './adapters/catalog.js'
import { resolveRetailToolPolicy } from './policies.js'
import { createCustomerLookupTool } from './tools/customer-lookup.js'
import { createInventoryCheckTool } from './tools/inventory-check.js'
import { createOrderConfirmTool } from './tools/order-confirm.js'
import { createOrderUpdateTool } from './tools/order-update.js'
import { createPaymentIntentCreateTool } from './tools/payment-intent-create.js'
import { createReceiptPrintTool } from './tools/receipt-print.js'

export function buildRetailSystemPrompt(config: StoreConfig): string {
  return [
    `Eres un asistente de tienda física para ${config.store.name}.`,
    `Atiende en ${languageHint(config.store.locale)} con frases cortas, claras y accionables.`,
    `Modo de servicio: ${config.retail.service_mode}. Posición en tienda: ${config.retail.store_position}.`,
    `Saludo esperado: ${config.retail.greeting_style}`,
    `Política de upsell: ${config.retail.upsell_policy}. Política de handoff: ${config.retail.handoff_policy}.`,
    config.retail.customer_display_enabled
      ? `Hay una pantalla visual para cliente en modo ${config.retail.customer_display_mode}; deja el estado listo para mostrar orden, totales y cambios.`
      : 'No dependas de una pantalla de cliente para completar la atención.',
    'Usa herramientas cuando sea necesario y evita inventar stock, cobros o datos del cliente.',
  ].join(' ')
}

export function registerRetailPresetTools(args: {
  toolRegistry: ToolRegistry
  config: StoreConfig
  db: Database.Database
  repositories: StoreRepositories
}): void {
  const adapters = createRetailAdapterCatalog({
    db: args.db,
    repositories: args.repositories,
    config: args.config,
  })

  const availableTools: IStoreTool[] = [
    createProductSearchTool({ adapter: adapters.products }),
    createInventoryCheckTool({ adapter: adapters.inventory }),
    createCustomerLookupTool({ adapter: adapters.customers }),
    createCustomerRegisterTool({ adapter: adapters.customers }),
    createOrderCreateTool({ adapter: adapters.orders }),
    createOrderUpdateTool({ adapter: adapters.orders }),
    createOrderConfirmTool({ adapter: adapters.orders }),
    createPaymentIntentCreateTool({ adapter: adapters.payments }),
    createReceiptPrintTool({ adapter: adapters.devices.receiptPrinter }),
    createRefundCreateTool(),
  ]

  const overrides = new Map(args.config.safety.tool_overrides.map((entry) => [entry.name, entry]))

  for (const tool of availableTools) {
    if (!args.config.tools.enabled.includes(tool.tool_id)) {
      continue
    }

    const policy = resolveRetailToolPolicy(tool.tool_id, args.config)
    const override = overrides.get(tool.tool_id)

    args.toolRegistry.register({
      ...tool,
      safety: override?.safety ?? policy?.safety ?? tool.safety,
      required_role: override?.required_role ?? policy?.required_role ?? tool.required_role,
      confirm_prompt: policy?.confirm_prompt ?? tool.confirm_prompt,
      quorum: override?.quorum ?? tool.quorum,
    })
  }
}

function languageHint(locale: string): string {
  switch (locale) {
    case 'es':
    case 'es-ES':
    case 'es-MX':
      return 'español'
    case 'en':
    case 'en-US':
      return 'inglés'
    default:
      return locale
  }
}
