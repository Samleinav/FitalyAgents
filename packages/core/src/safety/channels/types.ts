import type { IEventBus } from '../../types/index.js'
import type { IPresenceManager } from '../../presence/types.js'

// Safety levels

export type SafetyLevel = 'safe' | 'staged' | 'protected' | 'restricted'

// Human roles

export const HUMAN_ROLE_VALUES = [
  'customer',
  'user',
  'staff',
  'agent',
  'cashier',
  'operator',
  'manager',
  'supervisor',
  'owner',
] as const

export type HumanRole = (typeof HUMAN_ROLE_VALUES)[number]

export interface ApprovalLimits {
  /** Max payment amount (undefined = no permission) */
  payment_max?: number
  /** Max discount percentage */
  discount_max_pct?: number
  /** Max refund amount */
  refund_max?: number
  /** Can override prices */
  can_override_price?: boolean
  /** Can adjust inventory */
  can_adjust_inventory?: boolean
}

export interface HumanProfile {
  id: string
  name: string
  role: HumanRole
  /** Preferred tenant/org identifier used by the README and generic deployments. */
  org_id?: string
  /** Legacy retail alias retained for backwards compatibility. */
  store_id?: string
  voice_embedding?: Float32Array
  approval_limits: ApprovalLimits
  is_present?: boolean
}

// Approval channel interface

export type ApprovalChannelType = 'voice' | 'webhook' | 'external_tool'

export type ApprovalStrategy = 'parallel' | 'sequential'

export interface ApprovalRequest {
  id: string
  draft_id: string
  action: string
  amount?: number
  session_id: string
  required_role: HumanRole
  context: Record<string, unknown>
  timeout_ms: number
}

export interface ApprovalResponse {
  approved: boolean
  approver_id: string
  channel_used: string
  reason?: string
  timestamp: number
}

export interface ChannelConfig {
  type: ApprovalChannelType
  timeout_ms: number
  config?: {
    url?: string
    method?: 'POST' | 'GET'
    auth?: string
  }
}

/**
 * IApprovalChannel - interface for approval channels.
 *
 * Each channel represents a way to reach a human approver:
 * voice, webhook (push notification), or external tool (API call).
 */
export interface IApprovalChannel {
  id: string
  type: ApprovalChannelType

  /**
   * Notify the approver that there's a pending action.
   */
  notify(request: ApprovalRequest, approver: HumanProfile): Promise<void>

  /**
   * Wait for the approver's response on this channel.
   * Resolves with ApprovalResponse if they respond before timeout.
   * Resolves with null if timeout expires.
   */
  waitForResponse(request: ApprovalRequest, timeoutMs: number): Promise<ApprovalResponse | null>

  /**
   * Cancel the active wait (called when another channel already responded).
   */
  cancel(requestId: string): void
}

// SafetyDecision

export type SafetyDecision =
  | { allowed: true; execute: true }
  | { allowed: true; execute: false; action: 'draft' }
  | { allowed: false; reason: 'needs_confirmation'; prompt?: string }
  | {
      allowed: false
      reason: 'needs_approval'
      escalate_to: HumanRole
      channels: ChannelConfig[]
    }

// ApprovalOrchestrator deps

export interface ApprovalOrchestratorDeps {
  bus: IEventBus
  channelRegistry: Map<string, IApprovalChannel>
  presenceManager?: IPresenceManager
  defaultTimeoutMs?: number
}
