import { describe, expect, it } from 'vitest'
import { createBaseConfig } from '../../test/helpers.js'
import { resolveRetailToolPolicy, retailDefaultEnabledTools } from './policies.js'

describe('retail policies', () => {
  it('exposes the phase-1 enabled tool set by default', () => {
    expect(retailDefaultEnabledTools()).toEqual([
      'product_search',
      'inventory_check',
      'customer_lookup',
      'order_create',
      'order_update',
      'order_confirm',
      'payment_intent_create',
      'receipt_print',
    ])
  })

  it('resolves default tool safety and role-sensitive retail policies', () => {
    const config = createBaseConfig()

    expect(resolveRetailToolPolicy('order_confirm', config)).toMatchObject({
      safety: 'protected',
    })
    expect(resolveRetailToolPolicy('price_override', config)).toMatchObject({
      safety: 'restricted',
      required_role: 'manager',
    })
  })

  it('lets explicit tool overrides win over retail defaults', () => {
    const config = createBaseConfig({
      safety: {
        unknown_tool_default: 'restricted',
        tool_overrides: [
          {
            name: 'receipt_print',
            safety: 'safe',
            required_role: 'cashier',
          },
        ],
      },
    })

    expect(resolveRetailToolPolicy('receipt_print', config)).toMatchObject({
      safety: 'safe',
      required_role: 'cashier',
    })
  })
})
