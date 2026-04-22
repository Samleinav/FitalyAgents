import { describe, expect, it } from 'vitest'
import { createBaseConfig } from '../../test/helpers.js'
import {
  canEmployeeApproveRetailAction,
  findEligibleRetailApprover,
  resolveRetailEmployees,
} from './staffing.js'

describe('retail staffing', () => {
  it('merges role defaults from policies into employee approval limits', () => {
    const config = createBaseConfig({
      employees: [
        {
          id: 'cash-1',
          name: 'Caja',
          role: 'cashier',
          approval_limits: {
            payment_max: 1_200,
          },
        },
        {
          id: 'mgr-1',
          name: 'Gerente',
          role: 'manager',
          approval_limits: {},
        },
      ],
      policies: {
        ...createBaseConfig().policies,
        discount_max_pct: 15,
        refund_max: 250,
        role_approval_defaults: {
          cashier: {
            refund_max: 40,
          },
          manager: {
            payment_max: 75_000,
          },
        },
      },
    })

    const employees = resolveRetailEmployees(config)

    expect(employees[0]?.approval_limits).toMatchObject({
      payment_max: 1_200,
      refund_max: 40,
    })
    expect(employees[1]?.approval_limits).toMatchObject({
      payment_max: 75_000,
      refund_max: 250,
      discount_max_pct: 15,
      can_override_price: true,
    })
  })

  it('selects the lowest eligible approver for a refund amount', () => {
    const employees = resolveRetailEmployees(
      createBaseConfig({
        employees: [
          {
            id: 'cash-1',
            name: 'Caja',
            role: 'cashier',
            approval_limits: {
              refund_max: 20,
            },
          },
          {
            id: 'mgr-1',
            name: 'Gerente',
            role: 'manager',
            approval_limits: {
              refund_max: 150,
            },
          },
          {
            id: 'sup-1',
            name: 'Supervisión',
            role: 'supervisor',
            approval_limits: {
              refund_max: 800,
            },
          },
        ],
      }),
    )
    const policies = createBaseConfig().policies

    expect(
      findEligibleRetailApprover(employees, { action: 'refund_create', amount: 15 }, policies)?.id,
    ).toBe('cash-1')
    expect(
      findEligibleRetailApprover(employees, { action: 'refund_create', amount: 120 }, policies)?.id,
    ).toBe('mgr-1')
    expect(
      findEligibleRetailApprover(employees, { action: 'refund_create', amount: 500 }, policies)?.id,
    ).toBe('sup-1')
  })

  it('keeps discount and price override authority on manager or higher roles', () => {
    const employees = resolveRetailEmployees(
      createBaseConfig({
        employees: [
          {
            id: 'cash-1',
            name: 'Caja',
            role: 'cashier',
            approval_limits: {},
          },
          {
            id: 'mgr-1',
            name: 'Gerente',
            role: 'manager',
            approval_limits: {},
          },
        ],
      }),
    )
    const cashier = employees[0]!
    const manager = employees[1]!
    const policies = createBaseConfig().policies

    expect(
      canEmployeeApproveRetailAction(
        cashier,
        { action: 'discount_apply', percentage: 5 },
        policies,
      ),
    ).toBe(false)
    expect(
      canEmployeeApproveRetailAction(
        manager,
        { action: 'discount_apply', percentage: 10 },
        policies,
      ),
    ).toBe(true)
    expect(canEmployeeApproveRetailAction(manager, { action: 'price_override' }, policies)).toBe(
      true,
    )
  })
})
