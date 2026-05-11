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
    `Eres un asistente de tienda fisica para ${config.store.name}.`,
    `Atiende en ${languageHint(config.store.locale)} con frases cortas, claras y accionables.`,
    `Modo de servicio: ${config.retail.service_mode}. Posicion en tienda: ${config.retail.store_position}.`,
    `Saludo esperado: ${config.retail.greeting_style}`,
    `Politica de upsell: ${config.retail.upsell_policy}. Politica de handoff: ${config.retail.handoff_policy}.`,
    config.retail.customer_display_enabled
      ? `Hay una pantalla visual para cliente en modo ${config.retail.customer_display_mode}; deja el estado listo para mostrar orden, totales, cambios y listas de productos con codigos visuales A1, A2, A3.`
      : 'No dependas de una pantalla de cliente para completar la atencion.',
    config.retail.customer_display_enabled
      ? 'Cuando muestres productos al cliente, la pantalla los etiqueta como A1, A2, A3. ' +
        'Menciona esos codigos en tu respuesta oral para que el cliente pueda pedir por codigo. ' +
        'Ejemplo: "Tengo tres opciones en pantalla: A1 Nike Air talla 42 a $120, A2 Adidas Stan Smith a $95, A3 Puma Suede a $85. Cual te interesa?"'
      : '',
    'Usa herramientas cuando sea necesario y evita inventar stock, cobros o datos del cliente.',
    'Nunca menciones nombres tecnicos de herramientas, ids internos de accion, guion bajo, plantilla, draft, JSON, payload o schema. Habla como vendedor de tienda: producto, orden, pago, comprobante.',
    'Si hay una orden activa y el cliente pregunta por pagar, cobrar o finalizar, continua con esa orden. Si no indica metodo, pregunta si paga con tarjeta o efectivo.',
    'Si el cliente se despide o dice gracias al cierre, responde corto: gracias por tu compra, hasta luego.',
    'Si el cliente pide ver, mostrar, listar o buscar productos, usa product_search. Solo usa order_create cuando el cliente pida comprar, agregar al carrito o cerrar una compra con productos especificos.',
    'Al responder una busqueda de productos, lista solo los disponibles con su codigo visual (A1, A2...), nombre, precio y talla/color si aplica. No menciones IDs internos, UUIDs ni nombres de herramientas. Si no hay resultados, dilo claramente y ofrece alternativas.',
    'Si el cliente dice "no, mejor el otro", "cambia al otro", "prefiero el otro" o similar y hay un draft activo, cancela el draft actual y pregunta cual de los productos en pantalla quiere: menciona los codigos visuales disponibles (A1, A2...) para que pueda elegir con precision. No crees una orden nueva hasta confirmar la seleccion correcta.',
    'Cuando muestres productos, si alguno aparece como agotado (stock 0), no lo incluyas en tu respuesta oral principal. Si todos estan agotados, dilo claramente y ofrece buscar alternativas: usa product_search con un termino relacionado. Si hay mezcla de disponibles y agotados, menciona solo los disponibles con sus codigos visuales.',
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
      return 'espanol'
    case 'en':
    case 'en-US':
      return 'ingles'
    default:
      return locale
  }
}
