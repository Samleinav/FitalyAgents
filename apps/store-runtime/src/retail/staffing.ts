import type { ApprovalLimitsConfig } from '../config/approval-limits.js'
import type { StoreConfig } from '../config/schema.js'

const ROLE_RANK = {
  customer: 0,
  user: 0,
  staff: 1,
  agent: 1,
  cashier: 2,
  operator: 2,
  manager: 3,
  supervisor: 4,
  owner: 5,
} as const

const MANAGED_RETAIL_ROLES = ['cashier', 'operator', 'manager', 'supervisor', 'owner'] as const

type ManagedRetailRole = (typeof MANAGED_RETAIL_ROLES)[number]

export type ResolvedRetailRoleApprovalDefaults = Record<ManagedRetailRole, ApprovalLimitsConfig>

export interface RetailApprovalCheckInput {
  action: string
  amount?: number
  percentage?: number
}

export function buildDefaultRetailRoleApprovalDefaults(
  policies: StoreConfig['policies'],
): ResolvedRetailRoleApprovalDefaults {
  return {
    cashier: {
      payment_max: 5_000,
      refund_max: Math.min(policies.refund_max, 25),
    },
    operator: {
      payment_max: 5_000,
      refund_max: Math.min(policies.refund_max, 25),
    },
    manager: {
      payment_max: 50_000,
      refund_max: policies.refund_max,
      discount_max_pct: policies.discount_max_pct,
      can_override_price: hasRoleAuthority('manager', policies.price_override_requires_role),
    },
    supervisor: {
      payment_max: 250_000,
      refund_max: Math.max(policies.refund_max, 1_000),
      discount_max_pct: Math.max(policies.discount_max_pct, 30),
      can_override_price: true,
      can_adjust_inventory: true,
    },
    owner: {
      payment_max: 1_000_000,
      refund_max: Math.max(policies.refund_max, 100_000),
      discount_max_pct: 100,
      can_override_price: true,
      can_adjust_inventory: true,
    },
  }
}

export function resolveRetailRoleApprovalDefaults(
  policies: StoreConfig['policies'],
): ResolvedRetailRoleApprovalDefaults {
  const defaults = buildDefaultRetailRoleApprovalDefaults(policies)

  return {
    cashier: mergeApprovalLimits(defaults.cashier, policies.role_approval_defaults.cashier),
    operator: mergeApprovalLimits(defaults.operator, policies.role_approval_defaults.operator),
    manager: mergeApprovalLimits(defaults.manager, policies.role_approval_defaults.manager),
    supervisor: mergeApprovalLimits(
      defaults.supervisor,
      policies.role_approval_defaults.supervisor,
    ),
    owner: mergeApprovalLimits(defaults.owner, policies.role_approval_defaults.owner),
  }
}

export function resolveRetailEmployeeApprovalLimits(
  employee: StoreConfig['employees'][number],
  policies: StoreConfig['policies'],
): ApprovalLimitsConfig {
  const defaults = resolveRetailRoleApprovalDefaults(policies)
  const roleDefaults = isManagedRetailRole(employee.role) ? defaults[employee.role] : {}
  return mergeApprovalLimits(roleDefaults, employee.approval_limits)
}

export function resolveRetailEmployees(
  config: Pick<StoreConfig, 'employees' | 'policies'>,
): StoreConfig['employees'] {
  return config.employees.map((employee) => ({
    ...employee,
    approval_limits: resolveRetailEmployeeApprovalLimits(employee, config.policies),
  }))
}

export function resolveApprovalLimitsForRole(
  role: StoreConfig['employees'][number]['role'],
  policies: StoreConfig['policies'],
): ApprovalLimitsConfig {
  const defaults = resolveRetailRoleApprovalDefaults(policies)
  return isManagedRetailRole(role) ? defaults[role] : {}
}

export function canEmployeeApproveRetailAction(
  employee: Pick<StoreConfig['employees'][number], 'role' | 'approval_limits'>,
  input: RetailApprovalCheckInput,
  policies: StoreConfig['policies'],
): boolean {
  const limits = employee.approval_limits ?? {}

  if (employee.role === 'owner') {
    return true
  }

  if (input.action.includes('refund')) {
    return (limits.refund_max ?? 0) >= (input.amount ?? 0)
  }

  if (input.action.includes('discount')) {
    return (
      hasRoleAuthority(employee.role, 'manager') &&
      (limits.discount_max_pct ?? 0) >= (input.percentage ?? 0)
    )
  }

  if (input.action.includes('price_override')) {
    return (
      hasRoleAuthority(employee.role, policies.price_override_requires_role) &&
      limits.can_override_price === true
    )
  }

  if (input.action.includes('payment')) {
    return (limits.payment_max ?? 0) >= (input.amount ?? 0)
  }

  return false
}

export function findEligibleRetailApprover(
  employees: StoreConfig['employees'],
  input: RetailApprovalCheckInput,
  policies: StoreConfig['policies'],
): StoreConfig['employees'][number] | null {
  const eligible = employees
    .filter((employee) => canEmployeeApproveRetailAction(employee, input, policies))
    .sort((left, right) => {
      const rankDelta = ROLE_RANK[left.role] - ROLE_RANK[right.role]
      if (rankDelta !== 0) {
        return rankDelta
      }

      return left.id.localeCompare(right.id)
    })

  return eligible[0] ?? null
}

export function resolveRequiredApprovalRole(
  employees: StoreConfig['employees'],
  input: RetailApprovalCheckInput,
  policies: StoreConfig['policies'],
): StoreConfig['employees'][number]['role'] {
  const approver = findEligibleRetailApprover(employees, input, policies)
  if (approver) {
    return approver.role
  }

  if (input.action.includes('price_override')) {
    return policies.price_override_requires_role
  }

  if (input.action.includes('refund')) {
    return 'manager'
  }

  if (input.action.includes('discount')) {
    return 'manager'
  }

  return 'manager'
}

function mergeApprovalLimits(
  base: ApprovalLimitsConfig | undefined,
  override: ApprovalLimitsConfig | undefined,
): ApprovalLimitsConfig {
  return {
    ...(base ?? {}),
    ...(override ?? {}),
  }
}

function hasRoleAuthority(
  actorRole: StoreConfig['employees'][number]['role'],
  minimumRole: StoreConfig['employees'][number]['role'],
): boolean {
  return ROLE_RANK[actorRole] >= ROLE_RANK[minimumRole]
}

function isManagedRetailRole(
  role: StoreConfig['employees'][number]['role'],
): role is ManagedRetailRole {
  return MANAGED_RETAIL_ROLES.includes(role as ManagedRetailRole)
}
