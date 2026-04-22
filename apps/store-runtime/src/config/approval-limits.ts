import { z } from 'zod'

export const ApprovalLimitsSchema = z
  .object({
    payment_max: z.number().optional(),
    discount_max_pct: z.number().optional(),
    refund_max: z.number().optional(),
    can_override_price: z.boolean().optional(),
    can_adjust_inventory: z.boolean().optional(),
  })
  .default({})

export type ApprovalLimitsConfig = z.infer<typeof ApprovalLimitsSchema>
