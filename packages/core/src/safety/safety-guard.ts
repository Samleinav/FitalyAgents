import type {
  SafetyLevel,
  SafetyDecision,
  HumanProfile,
  HumanRole,
  ApprovalLimits,
  ChannelConfig,
} from './channels/types.js'

// ── Role hierarchy ────────────────────────────────────────────────────────────

const ROLE_HIERARCHY: Record<HumanRole, number> = {
  customer: 0,
  user: 0,
  staff: 1,
  agent: 1,
  cashier: 2,
  operator: 2,
  manager: 3,
  supervisor: 3,
  owner: 4,
}

// ── Default limits per role ───────────────────────────────────────────────────

export const defaultLimits: Record<HumanRole, ApprovalLimits> = {
  customer: {},
  user: {},
  staff: {},
  agent: {},
  cashier: {
    payment_max: 50_000,
  },
  operator: {
    payment_max: 50_000,
  },
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

// ── ToolSafetyConfig ──────────────────────────────────────────────────────────

export interface ToolSafetyConfig {
  name: string
  safety: SafetyLevel
  required_role?: HumanRole
  confirm_prompt?: string
  approval_channels?: ChannelConfig[]
  approval_strategy?: 'parallel' | 'sequential'
}

// ── SafetyGuard ───────────────────────────────────────────────────────────────

/**
 * SafetyGuard — evaluates whether an action can proceed based on
 * the tool's safety level and the speaker's role/limits.
 *
 * @example
 * ```typescript
 * const guard = new SafetyGuard({ toolConfigs })
 *
 * const decision = guard.evaluate('payment_process', { amount: 15000 }, cashierProfile)
 * // → { allowed: true, execute: true } if cashier.payment_max >= 15000
 * ```
 */
export class SafetyGuard {
  private readonly toolConfigs: Map<string, ToolSafetyConfig>

  constructor(deps: { toolConfigs: ToolSafetyConfig[] }) {
    this.toolConfigs = new Map(deps.toolConfigs.map((t) => [t.name, t]))
  }

  /**
   * Evaluate whether an action can be executed by this speaker.
   */
  evaluate(action: string, params: Record<string, unknown>, speaker: HumanProfile): SafetyDecision {
    const tool = this.toolConfigs.get(action)

    // Unknown tool → treat as RESTRICTED for safety
    if (!tool) {
      return {
        allowed: false,
        reason: 'needs_approval',
        escalate_to: 'owner',
        channels: [],
      }
    }

    switch (tool.safety) {
      case 'safe':
        return { allowed: true, execute: true }

      case 'staged':
        return { allowed: true, execute: false, action: 'draft' }

      case 'protected':
        return {
          allowed: false,
          reason: 'needs_confirmation',
          prompt: tool.confirm_prompt,
        }

      case 'restricted': {
        const requiredRole = tool.required_role ?? 'manager'

        // Check if speaker has sufficient permissions
        if (this.roleHasPermission(speaker, action, params)) {
          return { allowed: true, execute: true }
        }

        return {
          allowed: false,
          reason: 'needs_approval',
          escalate_to: requiredRole,
          channels: tool.approval_channels ?? [],
        }
      }
    }
  }

  /**
   * Check if the speaker's role and limits allow executing this tool.
   */
  roleHasPermission(
    speaker: HumanProfile,
    toolName: string,
    params: Record<string, unknown>,
  ): boolean {
    const limits = speaker.approval_limits

    // Owner can always do everything
    if (speaker.role === 'owner') return true

    const tool = this.toolConfigs.get(toolName)
    if (!tool) return false

    // SAFE and STAGED tools don't require role checks
    if (tool.safety === 'safe' || tool.safety === 'staged') return true

    // Check specific limits based on tool name
    const amount = typeof params.amount === 'number' ? params.amount : 0
    const percentage = typeof params.percentage === 'number' ? params.percentage : 0

    // Payment checks — any role with payment_max can process
    if (toolName.includes('payment')) {
      return (limits.payment_max ?? 0) >= amount
    }

    // Refund checks — needs role hierarchy + refund_max
    if (toolName.includes('refund')) {
      const requiredRole = tool.required_role ?? 'manager'
      if (ROLE_HIERARCHY[speaker.role] < ROLE_HIERARCHY[requiredRole]) return false
      return (limits.refund_max ?? 0) >= amount
    }

    // Discount checks — needs role hierarchy + discount_max_pct
    if (toolName.includes('discount')) {
      const requiredRole = tool.required_role ?? 'manager'
      if (ROLE_HIERARCHY[speaker.role] < ROLE_HIERARCHY[requiredRole]) return false
      return (limits.discount_max_pct ?? 0) >= percentage
    }

    // Price override
    if (toolName.includes('price_override')) {
      const requiredRole = tool.required_role ?? 'manager'
      if (ROLE_HIERARCHY[speaker.role] < ROLE_HIERARCHY[requiredRole]) return false
      return limits.can_override_price === true
    }

    // Inventory adjustment
    if (toolName.includes('inventory')) {
      const requiredRole = tool.required_role ?? 'manager'
      if (ROLE_HIERARCHY[speaker.role] < ROLE_HIERARCHY[requiredRole]) return false
      return limits.can_adjust_inventory === true
    }

    // For RESTRICTED tools without specific limit checks, use role hierarchy
    if (tool.safety === 'restricted') {
      const requiredRole = tool.required_role ?? 'manager'
      return ROLE_HIERARCHY[speaker.role] >= ROLE_HIERARCHY[requiredRole]
    }

    // PROTECTED tools without specific limit checks → allowed (client confirms)
    return true
  }

  /**
   * Get the safety config for a tool.
   */
  getToolConfig(toolName: string): ToolSafetyConfig | undefined {
    return this.toolConfigs.get(toolName)
  }
}
