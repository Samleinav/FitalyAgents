// ── Target / Multi-Speaker Types ──────────────────────────────────────────────

/**
 * State of a speaker within the TargetGroup.
 *
 * - `idle`       — no one is actively interacting
 * - `targeted`   — speaker is the primary target (agent responds to them)
 * - `responding` — agent is currently responding to the targeted speaker
 * - `queued`     — speaker arrived while another is targeted, waiting in line
 * - `ambient`    — speaker is overheard but not directly addressed
 */
export type TargetState = 'idle' | 'targeted' | 'responding' | 'queued' | 'ambient'

/**
 * Events that can trigger a state transition.
 */
export type TargetEvent =
  | 'SPEECH_START'
  | 'SPEECH_END'
  | 'RESPONSE_START'
  | 'RESPONSE_END'
  | 'TARGET_LOST'
  | 'AMBIENT_DETECTED'

/**
 * Snapshot of a speaker in the group.
 */
export interface SpeakerEntry {
  speakerId: string
  state: TargetState
  enteredAt: number
}

// ── TargetGroupStateMachine ───────────────────────────────────────────────────

/**
 * TargetGroupStateMachine — manages multi-speaker turn-taking.
 *
 * In a retail store, multiple people may be talking near the mic.
 * This FSM determines who the agent should respond to (the "target"),
 * who is waiting in queue, and who is just ambient background.
 *
 * @example
 * ```typescript
 * const group = new TargetGroupStateMachine()
 *
 * group.transition('customer_1', 'SPEECH_START')
 * // → 'targeted' (first speaker becomes target)
 *
 * group.transition('customer_2', 'SPEECH_START')
 * // → 'queued' (second speaker while first is targeted)
 *
 * group.transition('customer_1', 'TARGET_LOST')
 * // → customer_2 promoted to 'targeted'
 * ```
 */
export class TargetGroupStateMachine {
  private speakers: Map<string, SpeakerEntry> = new Map()
  private queue: string[] = []
  private primaryId: string | null = null

  /**
   * Process a state transition for a speaker.
   * Returns the new state of the speaker after the transition.
   */
  transition(speakerId: string, event: TargetEvent): TargetState {
    const entry = this.speakers.get(speakerId)

    switch (event) {
      case 'SPEECH_START': {
        if (!entry) {
          // New speaker
          if (this.primaryId === null) {
            // No one is targeted → become primary
            return this.addSpeaker(speakerId, 'targeted')
          } else {
            // Someone else is targeted → queue
            return this.addSpeaker(speakerId, 'queued')
          }
        }

        // Existing speaker
        if (entry.state === 'ambient') {
          if (this.primaryId === null) {
            return this.setSpeakerState(speakerId, 'targeted')
          }
          return this.setSpeakerState(speakerId, 'queued')
        }

        // Already targeted or queued — no change
        return entry.state
      }

      case 'SPEECH_END': {
        // Speech ended but speaker doesn't lose target yet
        // (agent may still be thinking/responding)
        if (!entry) return 'idle'
        return entry.state
      }

      case 'RESPONSE_START': {
        if (!entry) return 'idle'
        if (entry.state === 'targeted') {
          return this.setSpeakerState(speakerId, 'responding')
        }
        return entry.state
      }

      case 'RESPONSE_END': {
        if (!entry) return 'idle'
        if (entry.state === 'responding') {
          return this.setSpeakerState(speakerId, 'targeted')
        }
        return entry.state
      }

      case 'TARGET_LOST': {
        if (!entry) return 'idle'
        this.removeSpeaker(speakerId)
        this.promoteNextInQueue()
        return 'idle'
      }

      case 'AMBIENT_DETECTED': {
        if (!entry) {
          return this.addSpeaker(speakerId, 'ambient')
        }
        // If already in a higher state, don't demote
        if (entry.state === 'idle') {
          return this.setSpeakerState(speakerId, 'ambient')
        }
        return entry.state
      }
    }
  }

  /**
   * Get the current primary target speaker, or null if idle.
   */
  getTarget(): string | null {
    return this.primaryId
  }

  /**
   * Get all queued speaker IDs in order.
   */
  getQueued(): string[] {
    return [...this.queue]
  }

  /**
   * Get all speakers in the ambient state.
   */
  getAmbient(): string[] {
    return [...this.speakers.values()].filter((s) => s.state === 'ambient').map((s) => s.speakerId)
  }

  /**
   * Manually set a speaker as ambient (overheard but not addressed).
   */
  setAmbient(speakerId: string): void {
    const entry = this.speakers.get(speakerId)
    if (entry) {
      if (entry.state === 'targeted' || entry.state === 'responding') {
        this.primaryId = null
      }
      if (entry.state === 'queued') {
        this.queue = this.queue.filter((id) => id !== speakerId)
      }
      entry.state = 'ambient'
    } else {
      this.addSpeaker(speakerId, 'ambient')
    }
  }

  /**
   * Get the state of a specific speaker.
   */
  getSpeakerState(speakerId: string): TargetState | null {
    return this.speakers.get(speakerId)?.state ?? null
  }

  /**
   * Get all speakers and their states.
   */
  getAllSpeakers(): SpeakerEntry[] {
    return [...this.speakers.values()]
  }

  /**
   * Reset to idle state.
   */
  reset(): void {
    this.speakers.clear()
    this.queue = []
    this.primaryId = null
  }

  // ── Private ──────────────────────────────────────────────────────────

  private addSpeaker(speakerId: string, state: TargetState): TargetState {
    this.speakers.set(speakerId, {
      speakerId,
      state,
      enteredAt: Date.now(),
    })

    if (state === 'targeted') {
      this.primaryId = speakerId
    } else if (state === 'queued') {
      this.queue.push(speakerId)
    }

    return state
  }

  private setSpeakerState(speakerId: string, state: TargetState): TargetState {
    const entry = this.speakers.get(speakerId)
    if (!entry) return state

    const oldState = entry.state

    // Remove from queue if transitioning out of queued
    if (oldState === 'queued' && state !== 'queued') {
      this.queue = this.queue.filter((id) => id !== speakerId)
    }

    // Update primary tracking
    if (state === 'targeted' || state === 'responding') {
      this.primaryId = speakerId
    } else if (oldState === 'targeted' || oldState === 'responding') {
      this.primaryId = null
    }

    entry.state = state
    return state
  }

  private removeSpeaker(speakerId: string): void {
    const entry = this.speakers.get(speakerId)
    if (!entry) return

    if (entry.state === 'queued') {
      this.queue = this.queue.filter((id) => id !== speakerId)
    }
    if (this.primaryId === speakerId) {
      this.primaryId = null
    }
    this.speakers.delete(speakerId)
  }

  private promoteNextInQueue(): void {
    if (this.queue.length === 0) return

    const nextId = this.queue.shift()!
    const entry = this.speakers.get(nextId)
    if (entry) {
      entry.state = 'targeted'
      this.primaryId = nextId
    }
  }
}
