export const RETAIL_PHASE1_TOOL_IDS = [
  'product_search',
  'inventory_check',
  'customer_lookup',
  'order_create',
  'order_update',
  'order_confirm',
  'payment_intent_create',
  'receipt_print',
] as const

export const RETAIL_OPTIONAL_TOOL_IDS = [
  'customer_register',
  'customer_update',
  'order_quote',
  'order_hold',
  'order_cancel',
  'payment_cancel',
  'refund_quote',
  'refund_create',
  'cash_drawer_open',
  'register_shift_open',
  'register_shift_close',
  'price_override',
  'discount_apply',
] as const

export const RETAIL_ALL_KNOWN_TOOL_IDS = [
  ...RETAIL_PHASE1_TOOL_IDS,
  ...RETAIL_OPTIONAL_TOOL_IDS,
] as const
