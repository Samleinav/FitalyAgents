# Human Roles - FitalyAgents v2

> In v2, roles belong to the humans interacting with the system, not to the AI agents.
> They define who can approve what, and with which limits.

---

## The 5 permission levels

The runtime accepts two naming schemes for the same hierarchy:

```
user / customer         No approval permissions. Can interact with the agent.
agent / staff           No approval permissions. Can ask the agent for help.
operator / cashier      Can approve payments up to payment_max.
supervisor / manager    Can approve refunds, discounts, and overrides.
owner                   Full permissions.
```

Use the generic names in multi-tenant or non-retail systems.
Use the retail aliases in store workflows.
Both are valid and map to the same effective levels.

---

## Types

```typescript
type HumanRole =
  | 'user'
  | 'customer'
  | 'agent'
  | 'staff'
  | 'operator'
  | 'cashier'
  | 'supervisor'
  | 'manager'
  | 'owner'

interface HumanProfile {
  id: string
  name: string
  role: HumanRole
  org_id?: string // preferred for generic deployments
  store_id?: string // retail alias, still supported
  voice_embedding?: Float32Array
  approval_limits: ApprovalLimits
  is_present?: boolean
}

interface ApprovalLimits {
  payment_max?: number
  discount_max_pct?: number
  refund_max?: number
  can_override_price?: boolean
  can_adjust_inventory?: boolean
}
```

`org_id` is the preferred identifier in generic or multi-tenant deployments.
`store_id` remains valid for retail deployments and backwards compatibility.

---

## Default limits

```typescript
const defaultLimits: Record<HumanRole, ApprovalLimits> = {
  customer: {},
  user: {},

  staff: {},
  agent: {},

  cashier: { payment_max: 50_000 },
  operator: { payment_max: 50_000 },

  manager: {
    payment_max: Infinity,
    discount_max_pct: 30,
    refund_max: 100_000,
    can_override_price: true,
    can_adjust_inventory: true,
  },
  supervisor: {
    payment_max: Infinity,
    discount_max_pct: 30,
    refund_max: 100_000,
    can_override_price: true,
    can_adjust_inventory: true,
  },

  owner: {
    payment_max: Infinity,
    discount_max_pct: 100,
    refund_max: Infinity,
    can_override_price: true,
    can_adjust_inventory: true,
  },
}
```

`operator` and `cashier` share defaults.
`supervisor` and `manager` share defaults.
Limits can still be customized per human.

---

## How roles are identified

### 1. Voice identification

Employees can be enrolled with sample phrases.
The system stores `voice_embedding + name + role + org_id/store_id`.
When someone speaks, the voice identifier resolves a `HumanProfile` if there is a match.

### 2. App or dashboard session

A signed-in employee can have an active `HumanProfile` associated with the current `org_id` or `store_id`.

### 3. Fallback

Unknown speakers default to `customer` / `user`.

---

## How SafetyGuard uses roles

`SafetyGuard.evaluate()` checks:

1. The tool safety level.
2. The required role for the action.
3. The speaker's approval limits.

If the speaker already has the required role and is within limits, the action executes directly.
If not, the action escalates to approval.

Examples:

```typescript
// operator/cashier can process payments within payment_max
guard.roleHasPermission(profile, 'payment_process', { amount: 25_000 })

// supervisor/manager can refund within refund_max
guard.roleHasPermission(profile, 'refund_create', { amount: 80_000 })
```

---

## Permission matrix

| Action                   | user/customer | agent/staff | operator/cashier | supervisor/manager | owner |
| ------------------------ | :-----------: | :---------: | :--------------: | :----------------: | :---: |
| product_search           |      YES      |     YES     |       YES        |        YES         |  YES  |
| order_create (draft)     |      YES      |     YES     |       YES        |        YES         |  YES  |
| payment_process <= limit |      NO       |     NO      |       YES        |        YES         |  YES  |
| payment_process > limit  |      NO       |     NO      |        NO        |        YES         |  YES  |
| refund_create <= 100k    |      NO       |     NO      |        NO        |        YES         |  YES  |
| refund_create > 100k     |      NO       |     NO      |        NO        |         NO         |  YES  |
| discount_apply <= 30%    |      NO       |     NO      |        NO        |        YES         |  YES  |
| price_override           |      NO       |     NO      |        NO        |        YES         |  YES  |
| inventory_adjustment     |      NO       |     NO      |        NO        |        YES         |  YES  |
| config_agent             |      NO       |     NO      |        NO        |         NO         |  YES  |

---

## Example scenarios

### Customer requests a payment

`customer` / `user` has no approval permissions.
The request escalates to an `operator` / `cashier` or higher.

### Cashier requests a refund

`cashier` / `operator` can process payments, but cannot approve refunds.
The request escalates to `manager` / `supervisor`.

### Manager requests a 25% discount

`manager` / `supervisor` can approve it directly because the default discount limit is 30%.

### Manager requests a 40% discount

That exceeds the default limit.
The request escalates to `owner`.

---

## Registration

When registering an employee, store:

1. Name
2. Role
3. Voice embedding
4. `org_id` or `store_id`
5. Any customized approval limits

That is enough for `SafetyGuard`, approval channels, and voice-driven approval flows.
