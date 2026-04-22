import type { StoreConfig } from '../config/schema.js'
import { RETAIL_PHASE1_TOOL_IDS } from './capabilities.js'

export type ToolSafetyLevel = 'safe' | 'staged' | 'protected' | 'restricted'

export interface RetailToolPolicyDefaults {
  safety: ToolSafetyLevel
  required_role?: StoreConfig['employees'][number]['role']
  confirm_prompt?: string
  enabled_by_default?: boolean
}

export const DEFAULT_RETAIL_TOOL_POLICIES: Record<string, RetailToolPolicyDefaults> = {
  product_search: { safety: 'safe', enabled_by_default: true },
  inventory_check: { safety: 'safe', enabled_by_default: true },
  customer_lookup: { safety: 'safe', enabled_by_default: true },
  customer_register: {
    safety: 'staged',
    confirm_prompt: 'Preparé el registro del cliente. ¿Quieres confirmarlo?',
  },
  customer_update: { safety: 'staged' },
  order_quote: { safety: 'staged' },
  order_create: {
    safety: 'staged',
    confirm_prompt: 'Preparé el pedido. ¿Quieres confirmarlo?',
    enabled_by_default: true,
  },
  order_update: {
    safety: 'staged',
    confirm_prompt: 'Preparé los cambios del pedido. ¿Quieres confirmarlos?',
    enabled_by_default: true,
  },
  order_hold: { safety: 'staged' },
  order_confirm: {
    safety: 'protected',
    confirm_prompt: 'La orden está lista. ¿Confirmo el cierre de la venta?',
    enabled_by_default: true,
  },
  order_cancel: { safety: 'protected' },
  payment_intent_create: {
    safety: 'protected',
    confirm_prompt: 'Tengo listo el cobro. ¿Deseas preparar el pago?',
    enabled_by_default: true,
  },
  payment_cancel: { safety: 'protected' },
  receipt_print: {
    safety: 'protected',
    confirm_prompt: 'Tengo listo el comprobante. ¿Quieres imprimirlo?',
    enabled_by_default: true,
  },
  discount_apply: { safety: 'protected' },
  payment_terminal_charge: { safety: 'restricted', required_role: 'cashier' },
  refund_quote: { safety: 'protected', required_role: 'manager' },
  refund_create: { safety: 'restricted', required_role: 'manager' },
  price_override: { safety: 'restricted', required_role: 'manager' },
  cash_drawer_open: { safety: 'restricted', required_role: 'cashier' },
  register_shift_open: { safety: 'protected', required_role: 'cashier' },
  register_shift_close: { safety: 'restricted', required_role: 'manager' },
}

export function retailDefaultEnabledTools(): string[] {
  return [...RETAIL_PHASE1_TOOL_IDS]
}

export function resolveRetailToolPolicy(
  toolId: string,
  config: Pick<StoreConfig, 'policies' | 'safety'>,
): RetailToolPolicyDefaults | undefined {
  const defaults = DEFAULT_RETAIL_TOOL_POLICIES[toolId]
  if (!defaults) {
    return undefined
  }

  const requiredRole =
    toolId === 'price_override'
      ? config.policies.price_override_requires_role
      : defaults.required_role

  const override = config.safety.tool_overrides.find((entry) => entry.name === toolId)

  return {
    ...defaults,
    required_role: override?.required_role ?? requiredRole,
    safety: override?.safety ?? defaults.safety,
    enabled_by_default: defaults.enabled_by_default,
  }
}
