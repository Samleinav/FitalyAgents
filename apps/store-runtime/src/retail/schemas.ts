import { z } from 'zod'
import { HUMAN_ROLE_VALUES } from '../config/human-roles.js'
import { ApprovalLimitsSchema } from '../config/approval-limits.js'

export const RETAIL_SERVICE_MODE_VALUES = [
  'express-checkout',
  'assisted-retail',
  'premium-concierge',
  'customer-support-desk',
] as const

export const STORE_POSITION_VALUES = [
  'entrance',
  'cashier',
  'fitting-room',
  'returns-desk',
  'self-checkout',
] as const

export const CONNECTOR_DRIVER_VALUES = ['mock', 'rest', 'graphql', 'sqlite', 'postgres'] as const

export const DEVICE_DRIVER_VALUES = ['mock', 'tcp', 'usb', 'gateway', 'web'] as const

export const ConnectorRetryPolicySchema = z
  .object({
    max_attempts: z.number().int().min(1).default(3),
    backoff_ms: z.number().int().min(0).default(250),
  })
  .default({})

export const ConnectorConfigSchema = z
  .object({
    driver: z.enum(CONNECTOR_DRIVER_VALUES).default('mock'),
    url: z.string().url().optional(),
    connection_string: z.string().optional(),
    database: z.string().optional(),
    headers: z.record(z.string()).default({}),
    health_timeout_ms: z.number().int().positive().default(3_000),
    retry_policy: ConnectorRetryPolicySchema,
    options: z.record(z.unknown()).default({}),
  })
  .default({})

export const DeviceConfigSchema = z
  .object({
    driver: z.enum(DEVICE_DRIVER_VALUES).default('mock'),
    timeout_ms: z.number().int().positive().default(2_000),
    connection: z.record(z.unknown()).default({}),
  })
  .default({})

export const RetailConfigSchema = z
  .object({
    service_mode: z.enum(RETAIL_SERVICE_MODE_VALUES).default('assisted-retail'),
    store_position: z.enum(STORE_POSITION_VALUES).default('cashier'),
    greeting_style: z
      .string()
      .min(1)
      .default('Recibe al cliente con calidez, claridad y foco en resolver rápido.'),
    upsell_policy: z.enum(['none', 'light', 'active']).default('light'),
    handoff_policy: z.enum(['manual', 'auto']).default('manual'),
    customer_display_enabled: z.boolean().default(false),
    customer_display_mode: z.enum(['order', 'full']).default('order'),
  })
  .default({})

export const RetailConnectorsSchema = z
  .object({
    products: ConnectorConfigSchema,
    orders: ConnectorConfigSchema,
    customers: ConnectorConfigSchema,
    payments: ConnectorConfigSchema,
    inventory: ConnectorConfigSchema,
    receipts: ConnectorConfigSchema,
  })
  .default({})

export const RetailDevicesSchema = z
  .object({
    payment_terminal: DeviceConfigSchema,
    receipt_printer: DeviceConfigSchema,
    cash_drawer: DeviceConfigSchema,
    customer_display: DeviceConfigSchema,
  })
  .default({})

export const RetailPoliciesSchema = z
  .object({
    discount_max_pct: z.number().min(0).max(100).default(10),
    refund_max: z.number().min(0).default(150),
    price_override_requires_role: z.enum(HUMAN_ROLE_VALUES).default('manager'),
    cancellation_window_minutes: z.number().int().min(0).default(30),
    allowed_payment_methods: z.array(z.string().min(1)).default(['card', 'cash']),
    role_approval_defaults: z
      .object({
        cashier: ApprovalLimitsSchema.optional(),
        operator: ApprovalLimitsSchema.optional(),
        manager: ApprovalLimitsSchema.optional(),
        supervisor: ApprovalLimitsSchema.optional(),
        owner: ApprovalLimitsSchema.optional(),
      })
      .default({}),
  })
  .default({})

export type RetailConfig = z.infer<typeof RetailConfigSchema>
export type RetailConnectorsConfig = z.infer<typeof RetailConnectorsSchema>
export type RetailDevicesConfig = z.infer<typeof RetailDevicesSchema>
export type RetailPoliciesConfig = z.infer<typeof RetailPoliciesSchema>
