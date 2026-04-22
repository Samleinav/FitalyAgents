import type {
  SafetyLevel,
  SafetyDecision,
  HumanProfile,
  HumanRole,
  ApprovalLimits,
  ChannelConfig,
  QuorumConfig,
} from './channels/types.js'

export interface SafetyEvaluationContext {
  session_id?: string
  ctx?: Record<string, unknown>
}

export interface ContextualSafetyInput {
  action: string
  params: Record<string, unknown>
  speaker: HumanProfile
  session_id?: string
  context?: Record<string, unknown>
}

export type ContextualSafetyResolver = (
  input: ContextualSafetyInput,
) => SafetyLevel | null | undefined | Promise<SafetyLevel | null | undefined>

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
  approval_strategy?: 'parallel' | 'sequential' | 'quorum'
  quorum?: QuorumConfig
}

export interface SafetyGuardDeps {
  toolConfigs: ToolSafetyConfig[]
  contextualResolver?: ContextualSafetyResolver
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
  private readonly contextualResolver: ContextualSafetyResolver | undefined

  constructor(deps: SafetyGuardDeps) {
    this.toolConfigs = new Map(deps.toolConfigs.map((t) => [t.name, t]))
    this.contextualResolver = deps.contextualResolver
  }

  /**
   * Evaluate whether an action can be executed by this speaker.
   *
   * This method remains synchronous for backwards compatibility. If the guard
   * was configured with an async contextual resolver, use `evaluateAsync()`.
   */
  evaluate(
    action: string,
    params: Record<string, unknown>,
    speaker: HumanProfile,
    context?: SafetyEvaluationContext,
  ): SafetyDecision {
    const contextualSafety = this.resolveContextualSafetySync(action, params, speaker, context)
    return this.evaluateWithSafety(action, params, speaker, contextualSafety ?? undefined)
  }

  /**
   * Async-safe evaluation for contextual resolvers that read memory, sentiment,
   * fraud signals, or other external session state.
   */
  async evaluateAsync(
    action: string,
    params: Record<string, unknown>,
    speaker: HumanProfile,
    context?: SafetyEvaluationContext,
  ): Promise<SafetyDecision> {
    const contextualSafety = await this.resolveContextualSafety(action, params, speaker, context)
    return this.evaluateWithSafety(action, params, speaker, contextualSafety ?? undefined)
  }

  private evaluateWithSafety(
    action: string,
    params: Record<string, unknown>,
    speaker: HumanProfile,
    contextualSafety?: SafetyLevel,
  ): SafetyDecision {
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

    const effectiveTool =
      contextualSafety && contextualSafety !== tool.safety
        ? { ...tool, safety: contextualSafety }
        : tool

    switch (effectiveTool.safety) {
      case 'safe':
        return { allowed: true, execute: true }

      case 'staged':
        return { allowed: true, execute: false, action: 'draft' }

      case 'protected':
        return {
          allowed: false,
          reason: 'needs_confirmation',
          prompt: effectiveTool.confirm_prompt,
        }

      case 'restricted': {
        const requiredRole = effectiveTool.required_role ?? 'manager'

        // Check if speaker has sufficient permissions
        if (this.roleHasPermissionForTool(speaker, action, params, effectiveTool)) {
          return { allowed: true, execute: true }
        }

        return {
          allowed: false,
          reason: 'needs_approval',
          escalate_to: requiredRole,
          channels: effectiveTool.approval_channels ?? [],
          quorum: effectiveTool.quorum,
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
    const tool = this.toolConfigs.get(toolName)
    if (!tool) return false

    return this.roleHasPermissionForTool(speaker, toolName, params, tool)
  }

  private roleHasPermissionForTool(
    speaker: HumanProfile,
    toolName: string,
    params: Record<string, unknown>,
    tool: ToolSafetyConfig,
  ): boolean {
    const limits = speaker.approval_limits

    // Owner can always do everything
    if (speaker.role === 'owner') return true

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

  private resolveContextualSafetySync(
    action: string,
    params: Record<string, unknown>,
    speaker: HumanProfile,
    context?: SafetyEvaluationContext,
  ): SafetyLevel | null | undefined {
    if (!this.contextualResolver) return null

    const result = this.contextualResolver(
      this.createResolverInput(action, params, speaker, context),
    )

    if (isPromiseLike(result)) {
      throw new Error('SafetyGuard contextualResolver returned a Promise. Use evaluateAsync().')
    }

    return result
  }

  private async resolveContextualSafety(
    action: string,
    params: Record<string, unknown>,
    speaker: HumanProfile,
    context?: SafetyEvaluationContext,
  ): Promise<SafetyLevel | null | undefined> {
    if (!this.contextualResolver) return null
    return this.contextualResolver(this.createResolverInput(action, params, speaker, context))
  }

  private createResolverInput(
    action: string,
    params: Record<string, unknown>,
    speaker: HumanProfile,
    context?: SafetyEvaluationContext,
  ): ContextualSafetyInput {
    return {
      action,
      params,
      speaker,
      session_id: context?.session_id,
      context: context?.ctx,
    }
  }
}

export function composeContextualSafetyResolvers(
  ...resolvers: ContextualSafetyResolver[]
): ContextualSafetyResolver {
  return async (input) => {
    for (const resolver of resolvers) {
      const result = await resolver(input)
      if (result != null) return result
    }

    return null
  }
}

function isPromiseLike<T>(value: T | Promise<T>): value is Promise<T> {
  return (
    typeof value === 'object' &&
    value !== null &&
    'then' in value &&
    typeof (value as { then?: unknown }).then === 'function'
  )
}
