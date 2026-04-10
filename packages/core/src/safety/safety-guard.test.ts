import { describe, it, expect, beforeEach } from 'vitest'
import { SafetyGuard, composeContextualSafetyResolvers, defaultLimits } from './safety-guard.js'
import type { HumanProfile } from './channels/types.js'
import type { ContextualSafetyResolver, ToolSafetyConfig } from './safety-guard.js'

// ── Test fixtures ─────────────────────────────────────────────────────────────

const toolConfigs: ToolSafetyConfig[] = [
  { name: 'product_search', safety: 'safe' },
  { name: 'order_create', safety: 'staged' },
  {
    name: 'payment_process',
    safety: 'protected',
    confirm_prompt: '¿Confirma el cobro de {amount}?',
  },
  {
    name: 'refund_create',
    safety: 'restricted',
    required_role: 'manager',
    approval_channels: [
      { type: 'voice', timeout_ms: 15_000 },
      { type: 'webhook', timeout_ms: 90_000 },
    ],
    approval_strategy: 'parallel',
  },
  {
    name: 'price_override',
    safety: 'restricted',
    required_role: 'manager',
  },
  {
    name: 'inventory_adjustment',
    safety: 'restricted',
    required_role: 'manager',
  },
  {
    name: 'discount_apply',
    safety: 'restricted',
    required_role: 'manager',
  },
]

function makeProfile(
  overrides: Partial<HumanProfile> & { role: HumanProfile['role'] },
): HumanProfile {
  return {
    id: `user_${overrides.role}`,
    name: overrides.role.charAt(0).toUpperCase() + overrides.role.slice(1),
    role: overrides.role,
    org_id: 'org_001',
    store_id: 'store_001',
    approval_limits: defaultLimits[overrides.role],
    ...overrides,
  }
}

// ── Tests ─────────────────────────────────────────────────────────────────────

describe('SafetyGuard', () => {
  let guard: SafetyGuard

  beforeEach(() => {
    guard = new SafetyGuard({ toolConfigs })
  })

  // ── evaluate() ─────────────────────────────────────────────────────

  describe('evaluate()', () => {
    it('returns allowed+execute for SAFE tools regardless of role', () => {
      const customer = makeProfile({ role: 'customer' })
      const decision = guard.evaluate('product_search', {}, customer)

      expect(decision).toEqual({ allowed: true, execute: true })
    })

    it('returns allowed+draft for STAGED tools', () => {
      const customer = makeProfile({ role: 'customer' })
      const decision = guard.evaluate('order_create', {}, customer)

      expect(decision).toEqual({ allowed: true, execute: false, action: 'draft' })
    })

    it('returns needs_confirmation for PROTECTED tools', () => {
      const customer = makeProfile({ role: 'customer' })
      const decision = guard.evaluate('payment_process', { amount: 15000 }, customer)

      expect(decision).toEqual({
        allowed: false,
        reason: 'needs_confirmation',
        prompt: '¿Confirma el cobro de {amount}?',
      })
    })

    it('returns needs_approval for RESTRICTED tools when speaker lacks permission', () => {
      const customer = makeProfile({ role: 'customer' })
      const decision = guard.evaluate('refund_create', { amount: 15000 }, customer)

      expect(decision).toMatchObject({
        allowed: false,
        reason: 'needs_approval',
        escalate_to: 'manager',
      })
      if (decision.allowed === false && decision.reason === 'needs_approval') {
        expect(decision.channels).toHaveLength(2)
      }
    })

    it('includes quorum config in needs_approval decisions', () => {
      const customer = makeProfile({ role: 'customer' })
      const quorumGuard = new SafetyGuard({
        toolConfigs: [
          {
            name: 'inventory_writeoff',
            safety: 'restricted',
            required_role: 'manager',
            approval_channels: [{ type: 'webhook', timeout_ms: 30_000 }],
            approval_strategy: 'quorum',
            quorum: {
              required: 2,
              eligible_roles: ['manager', 'owner'],
            },
          },
        ],
      })

      const decision = quorumGuard.evaluate('inventory_writeoff', { amount: 50_000 }, customer)

      expect(decision).toMatchObject({
        allowed: false,
        reason: 'needs_approval',
        escalate_to: 'manager',
        quorum: {
          required: 2,
          eligible_roles: ['manager', 'owner'],
        },
      })
    })

    it('returns allowed+execute for RESTRICTED tools when speaker has sufficient role', () => {
      const manager = makeProfile({ role: 'manager' })
      const decision = guard.evaluate('refund_create', { amount: 50_000 }, manager)

      expect(decision).toEqual({ allowed: true, execute: true })
    })

    it('accepts README generic roles and org_id without retail aliases', () => {
      const operator = makeProfile({
        role: 'operator',
        org_id: 'org_main',
        store_id: undefined,
      })
      const decision = guard.evaluate('refund_create', { amount: 15_000 }, operator)

      expect(decision).toMatchObject({
        allowed: false,
        reason: 'needs_approval',
        escalate_to: 'manager',
      })
    })

    it('returns needs_approval for unknown tools', () => {
      const customer = makeProfile({ role: 'customer' })
      const decision = guard.evaluate('unknown_tool', {}, customer)

      expect(decision).toMatchObject({
        allowed: false,
        reason: 'needs_approval',
        escalate_to: 'owner',
      })
    })

    it('uses a sync contextual resolver to lower the safety level for one evaluation', () => {
      const vipResolver: ContextualSafetyResolver = ({ action, context }) => {
        if (action === 'payment_process' && context?.customer_tier === 'vip') return 'safe'
        return null
      }
      const vipGuard = new SafetyGuard({ toolConfigs, contextualResolver: vipResolver })
      const customer = makeProfile({ role: 'customer' })

      const decision = vipGuard.evaluate('payment_process', { amount: 15_000 }, customer, {
        session_id: 'session_vip',
        ctx: { customer_tier: 'vip' },
      })

      expect(decision).toEqual({ allowed: true, execute: true })
    })

    it('uses a sync contextual resolver to raise a safe tool to restricted', () => {
      const elevatedGuard = new SafetyGuard({
        toolConfigs: [{ name: 'manual_override', safety: 'safe', required_role: 'manager' }],
        contextualResolver: () => 'restricted',
      })
      const customer = makeProfile({ role: 'customer' })

      const decision = elevatedGuard.evaluate(
        'manual_override',
        { reason: 'policy exception' },
        customer,
        { session_id: 'session_1', ctx: { fraud_signal: true } },
      )

      expect(decision).toEqual({
        allowed: false,
        reason: 'needs_approval',
        escalate_to: 'manager',
        channels: [],
      })
    })

    it('keeps the static safety level when the contextual resolver returns null', () => {
      const passthroughGuard = new SafetyGuard({
        toolConfigs,
        contextualResolver: () => null,
      })
      const customer = makeProfile({ role: 'customer' })

      const decision = passthroughGuard.evaluate('payment_process', { amount: 15_000 }, customer, {
        session_id: 'session_1',
        ctx: { customer_tier: 'standard' },
      })

      expect(decision).toEqual({
        allowed: false,
        reason: 'needs_confirmation',
        prompt: '¿Confirma el cobro de {amount}?',
      })
    })

    it('supports async contextual resolvers through evaluateAsync()', async () => {
      const asyncGuard = new SafetyGuard({
        toolConfigs,
        contextualResolver: async ({ action, context }) => {
          if (action === 'payment_process' && context?.fraud_signal === true) return 'restricted'
          return null
        },
      })
      const customer = makeProfile({ role: 'customer' })

      const decision = await asyncGuard.evaluateAsync(
        'payment_process',
        { amount: 15_000 },
        customer,
        { session_id: 'session_risk', ctx: { fraud_signal: true } },
      )

      expect(decision).toEqual({
        allowed: false,
        reason: 'needs_approval',
        escalate_to: 'manager',
        channels: [],
      })
    })

    it('throws a clear error when evaluate() receives an async resolver', () => {
      const asyncGuard = new SafetyGuard({
        toolConfigs,
        contextualResolver: async () => 'safe',
      })
      const customer = makeProfile({ role: 'customer' })

      expect(() => asyncGuard.evaluate('payment_process', { amount: 15_000 }, customer)).toThrow(
        'Use evaluateAsync()',
      )
    })

    it('composes contextual resolvers in order', async () => {
      const resolver = composeContextualSafetyResolvers(
        () => null,
        ({ action }) => (action === 'payment_process' ? 'safe' : null),
        () => 'restricted',
      )
      const composedGuard = new SafetyGuard({ toolConfigs, contextualResolver: resolver })
      const customer = makeProfile({ role: 'customer' })

      const decision = await composedGuard.evaluateAsync(
        'payment_process',
        { amount: 15_000 },
        customer,
      )

      expect(decision).toEqual({ allowed: true, execute: true })
    })
  })

  // ── roleHasPermission() ────────────────────────────────────────────

  describe('roleHasPermission()', () => {
    it('cashier can pay ≤ 50,000', () => {
      const cashier = makeProfile({ role: 'cashier' })
      expect(guard.roleHasPermission(cashier, 'payment_process', { amount: 50_000 })).toBe(true)
    })

    it('cashier cannot pay > 50,000', () => {
      const cashier = makeProfile({ role: 'cashier' })
      expect(guard.roleHasPermission(cashier, 'payment_process', { amount: 50_001 })).toBe(false)
    })

    it('cashier cannot refund at all', () => {
      const cashier = makeProfile({ role: 'cashier' })
      expect(guard.roleHasPermission(cashier, 'refund_create', { amount: 1 })).toBe(false)
    })

    it('manager can refund ≤ 100,000', () => {
      const manager = makeProfile({ role: 'manager' })
      expect(guard.roleHasPermission(manager, 'refund_create', { amount: 100_000 })).toBe(true)
    })

    it('manager cannot refund > 100,000', () => {
      const manager = makeProfile({ role: 'manager' })
      expect(guard.roleHasPermission(manager, 'refund_create', { amount: 100_001 })).toBe(false)
    })

    it('manager can override prices', () => {
      const manager = makeProfile({ role: 'manager' })
      expect(guard.roleHasPermission(manager, 'price_override', {})).toBe(true)
    })

    it('manager can adjust inventory', () => {
      const manager = makeProfile({ role: 'manager' })
      expect(guard.roleHasPermission(manager, 'inventory_adjustment', {})).toBe(true)
    })

    it('manager can discount ≤ 30%', () => {
      const manager = makeProfile({ role: 'manager' })
      expect(guard.roleHasPermission(manager, 'discount_apply', { percentage: 30 })).toBe(true)
    })

    it('manager cannot discount > 30%', () => {
      const manager = makeProfile({ role: 'manager' })
      expect(guard.roleHasPermission(manager, 'discount_apply', { percentage: 31 })).toBe(false)
    })

    it('owner can do everything', () => {
      const owner = makeProfile({ role: 'owner' })
      expect(guard.roleHasPermission(owner, 'refund_create', { amount: 999_999 })).toBe(true)
      expect(guard.roleHasPermission(owner, 'price_override', {})).toBe(true)
      expect(guard.roleHasPermission(owner, 'discount_apply', { percentage: 100 })).toBe(true)
    })

    it('customer has no permissions on restricted tools', () => {
      const customer = makeProfile({ role: 'customer' })
      expect(guard.roleHasPermission(customer, 'payment_process', { amount: 1 })).toBe(false)
      expect(guard.roleHasPermission(customer, 'refund_create', { amount: 1 })).toBe(false)
    })

    it('SAFE tools are allowed for anyone', () => {
      const customer = makeProfile({ role: 'customer' })
      expect(guard.roleHasPermission(customer, 'product_search', {})).toBe(true)
    })

    it('cashier with custom limits can pay more', () => {
      const cashier = makeProfile({
        role: 'cashier',
        approval_limits: { payment_max: 80_000 },
      })
      expect(guard.roleHasPermission(cashier, 'payment_process', { amount: 80_000 })).toBe(true)
    })

    it('operator shares cashier-level permissions', () => {
      const operator = makeProfile({ role: 'operator' })
      expect(guard.roleHasPermission(operator, 'payment_process', { amount: 50_000 })).toBe(true)
      expect(guard.roleHasPermission(operator, 'refund_create', { amount: 1 })).toBe(false)
    })

    it('supervisor shares manager-level permissions', () => {
      const supervisor = makeProfile({ role: 'supervisor' })
      expect(guard.roleHasPermission(supervisor, 'refund_create', { amount: 100_000 })).toBe(true)
      expect(guard.roleHasPermission(supervisor, 'discount_apply', { percentage: 30 })).toBe(true)
    })
  })

  // ── getToolConfig() ────────────────────────────────────────────────

  describe('getToolConfig()', () => {
    it('returns config for known tool', () => {
      const config = guard.getToolConfig('product_search')
      expect(config).toMatchObject({ name: 'product_search', safety: 'safe' })
    })

    it('returns undefined for unknown tool', () => {
      expect(guard.getToolConfig('unknown')).toBeUndefined()
    })
  })

  // ── defaultLimits ──────────────────────────────────────────────────

  describe('defaultLimits', () => {
    it('customer has no limits', () => {
      expect(defaultLimits.customer).toEqual({})
    })

    it('cashier has payment_max 50k', () => {
      expect(defaultLimits.cashier.payment_max).toBe(50_000)
    })

    it('operator matches cashier defaults', () => {
      expect(defaultLimits.operator.payment_max).toBe(50_000)
    })

    it('manager has refund_max 100k and can override price', () => {
      expect(defaultLimits.manager.refund_max).toBe(100_000)
      expect(defaultLimits.manager.can_override_price).toBe(true)
    })

    it('supervisor matches manager defaults', () => {
      expect(defaultLimits.supervisor.refund_max).toBe(100_000)
      expect(defaultLimits.supervisor.can_override_price).toBe(true)
    })

    it('owner has infinite limits', () => {
      expect(defaultLimits.owner.payment_max).toBe(Infinity)
      expect(defaultLimits.owner.refund_max).toBe(Infinity)
      expect(defaultLimits.owner.discount_max_pct).toBe(100)
    })
  })
})
