import { StreamAgent } from './stream-agent.js'
import type { IEventBus } from '../types/index.js'
import type { ISessionManager } from '../session/types.js'
import { TargetGroupStateMachine } from '../session/target-group.js'
import type { TargetState, TargetEvent } from '../session/target-group.js'

// ── Types ──────────────────────────────────────────────────────────────────────

/**
 * Bus event payloads consumed by TargetGroupBridge.
 */
export interface SpeakerDetectedPayload {
  session_id: string
  speaker_id: string
  store_id: string
}

export interface SpeakerLostPayload {
  session_id: string
  speaker_id: string
}

export interface SpeakerAmbientPayload {
  session_id: string
  speaker_id: string
  text?: string
}

/**
 * Bus channels that TargetGroupBridge listens to.
 */
export const TARGET_BRIDGE_CHANNELS = [
  'bus:SPEAKER_DETECTED',
  'bus:SPEAKER_LOST',
  'bus:SPEAKER_AMBIENT',
  'bus:RESPONSE_START',
  'bus:RESPONSE_END',
] as const

/**
 * Published by the bridge after every state transition.
 */
export interface TargetGroupSnapshot {
  event: 'TARGET_GROUP_CHANGED'
  store_id: string
  primary: string | null
  queued: string[]
  ambient: string[]
  speakers: Array<{ speakerId: string; state: TargetState }>
  timestamp: number
}

/**
 * Configuration for the TargetGroupBridge.
 */
export interface TargetGroupBridgeConfig {
  /** The event bus instance. */
  bus: IEventBus
  /** Session manager to create/update sessions. */
  sessionManager: ISessionManager
  /** Store ID this bridge manages (multi-store deployments). */
  storeId: string
  /**
   * Default metadata to attach to new sessions.
   * Can be overridden per-speaker via `SPEAKER_DETECTED.metadata`.
   */
  defaultSessionMetadata?: Record<string, unknown>
}

// ── TargetGroupBridge ──────────────────────────────────────────────────────────

/**
 * TargetGroupBridge — connects TargetGroupStateMachine to the bus + SessionManager.
 *
 * Listens to speaker detection events on the bus, drives the FSM,
 * and orchestrates session lifecycle:
 *
 * - `SPEAKER_DETECTED` → FSM.transition(SPEECH_START) → if targeted, createSession()
 * - `SPEAKER_LOST`     → FSM.transition(TARGET_LOST) → if was primary, check queue promotion
 * - `SPEAKER_AMBIENT`  → FSM.transition(AMBIENT_DETECTED)
 * - `RESPONSE_START`   → FSM.transition(RESPONSE_START)
 * - `RESPONSE_END`     → FSM.transition(RESPONSE_END)
 *
 * After every transition, publishes `bus:TARGET_GROUP_CHANGED` with the full snapshot.
 *
 * @example
 * ```typescript
 * const bridge = new TargetGroupBridge({
 *   bus,
 *   sessionManager,
 *   storeId: 'store_123',
 * })
 * await bridge.start()
 * // Speaker detected → session created → agent responds
 * ```
 */
export class TargetGroupBridge extends StreamAgent {
  private readonly fsm = new TargetGroupStateMachine()
  private readonly sessionManager: ISessionManager
  private readonly storeId: string
  private readonly defaultMetadata: Record<string, unknown>

  // Track which speakers already have sessions
  private readonly speakerSessions = new Map<string, string>()

  constructor(config: TargetGroupBridgeConfig) {
    super(config.bus)
    this.sessionManager = config.sessionManager
    this.storeId = config.storeId
    this.defaultMetadata = config.defaultSessionMetadata ?? {}
  }

  async onEvent(channel: string, payload: unknown): Promise<void> {
    switch (channel) {
      case 'bus:SPEAKER_DETECTED': {
        const data = payload as SpeakerDetectedPayload
        await this.handleSpeakerDetected(data)
        break
      }
      case 'bus:SPEAKER_LOST': {
        const data = payload as SpeakerLostPayload
        await this.handleSpeakerLost(data)
        break
      }
      case 'bus:SPEAKER_AMBIENT': {
        const data = payload as SpeakerAmbientPayload
        await this.handleSpeakerAmbient(data)
        break
      }
      case 'bus:RESPONSE_START': {
        const data = payload as { speaker_id: string }
        this.handleResponseTransition(data.speaker_id, 'RESPONSE_START')
        await this.publishSnapshot()
        break
      }
      case 'bus:RESPONSE_END': {
        const data = payload as { speaker_id: string }
        this.handleResponseTransition(data.speaker_id, 'RESPONSE_END')
        await this.publishSnapshot()
        break
      }
    }
  }

  protected get channels(): string[] {
    return [...TARGET_BRIDGE_CHANNELS]
  }

  // ── Handlers ─────────────────────────────────────────────────────────────────

  private async handleSpeakerDetected(data: SpeakerDetectedPayload): Promise<void> {
    const newState = this.fsm.transition(data.speaker_id, 'SPEECH_START')

    if (newState === 'targeted') {
      // Create session if none exists
      await this.ensureSession(data.speaker_id)
    } else if (newState === 'queued') {
      // Create session and set priority to 0 (lower, waiting)
      const sessionId = await this.ensureSession(data.speaker_id)
      await this.sessionManager.setPriorityGroup(sessionId, 0)
    }

    await this.publishSnapshot()
  }

  private async handleSpeakerLost(data: SpeakerLostPayload): Promise<void> {
    const wasPrimary = this.fsm.getTarget() === data.speaker_id

    this.fsm.transition(data.speaker_id, 'TARGET_LOST')
    this.speakerSessions.delete(data.speaker_id)

    // If someone was promoted from queue, upgrade their priority
    if (wasPrimary) {
      const newPrimary = this.fsm.getTarget()
      if (newPrimary) {
        const sessionId = this.speakerSessions.get(newPrimary)
        if (sessionId) {
          await this.sessionManager.setPriorityGroup(sessionId, 1)
        }
      }
    }

    await this.publishSnapshot()
  }

  private async handleSpeakerAmbient(data: SpeakerAmbientPayload): Promise<void> {
    this.fsm.transition(data.speaker_id, 'AMBIENT_DETECTED')
    await this.publishSnapshot()
  }

  private handleResponseTransition(speakerId: string, event: TargetEvent): void {
    this.fsm.transition(speakerId, event)
  }

  // ── Session lifecycle ────────────────────────────────────────────────────────

  /**
   * Ensure a session exists for the speaker. Returns the session ID.
   */
  private async ensureSession(speakerId: string): Promise<string> {
    const existing = this.speakerSessions.get(speakerId)
    if (existing) {
      // Verify session still exists in manager
      const session = await this.sessionManager.getSession(existing)
      if (session && session.status === 'active') return existing
    }

    // Create new session
    const sessionId = `session_${speakerId}_${Date.now()}`
    await this.sessionManager.createSession(sessionId, {
      ...this.defaultMetadata,
      speaker_id: speakerId,
      store_id: this.storeId,
    })
    this.speakerSessions.set(speakerId, sessionId)

    return sessionId
  }

  // ── Snapshot publishing ──────────────────────────────────────────────────────

  private async publishSnapshot(): Promise<void> {
    const snapshot: TargetGroupSnapshot = {
      event: 'TARGET_GROUP_CHANGED',
      store_id: this.storeId,
      primary: this.fsm.getTarget(),
      queued: this.fsm.getQueued(),
      ambient: this.fsm.getAmbient(),
      speakers: this.fsm.getAllSpeakers().map((s) => ({
        speakerId: s.speakerId,
        state: s.state,
      })),
      timestamp: Date.now(),
    }

    await this.bus.publish('bus:TARGET_GROUP_CHANGED', snapshot)
  }

  // ── Accessors ────────────────────────────────────────────────────────────────

  /** Get the FSM for direct inspection (testing). */
  get stateMachine(): TargetGroupStateMachine {
    return this.fsm
  }

  /** Get the session ID for a speaker, if one exists. */
  getSessionForSpeaker(speakerId: string): string | undefined {
    return this.speakerSessions.get(speakerId)
  }
}
