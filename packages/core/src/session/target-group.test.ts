import { describe, it, expect, beforeEach } from 'vitest'
import { TargetGroupStateMachine } from './target-group.js'

describe('TargetGroupStateMachine', () => {
  let group: TargetGroupStateMachine

  beforeEach(() => {
    group = new TargetGroupStateMachine()
  })

  // ── Basic transitions ──────────────────────────────────────────────

  describe('idle → targeted', () => {
    it('first speaker becomes the target', () => {
      const state = group.transition('customer_1', 'SPEECH_START')
      expect(state).toBe('targeted')
      expect(group.getTarget()).toBe('customer_1')
    })
  })

  describe('targeted → queued (second client)', () => {
    it('second speaker is queued while someone is targeted', () => {
      group.transition('customer_1', 'SPEECH_START')
      const state = group.transition('customer_2', 'SPEECH_START')

      expect(state).toBe('queued')
      expect(group.getTarget()).toBe('customer_1')
      expect(group.getQueued()).toEqual(['customer_2'])
    })
  })

  describe('targeted → responding → targeted', () => {
    it('cycles through response states', () => {
      group.transition('customer_1', 'SPEECH_START')

      const responding = group.transition('customer_1', 'RESPONSE_START')
      expect(responding).toBe('responding')
      expect(group.getTarget()).toBe('customer_1')

      const back = group.transition('customer_1', 'RESPONSE_END')
      expect(back).toBe('targeted')
    })
  })

  // ── Queue promotion ────────────────────────────────────────────────

  describe('queue promotion on TARGET_LOST', () => {
    it('promotes next in queue when target leaves', () => {
      group.transition('customer_1', 'SPEECH_START')
      group.transition('customer_2', 'SPEECH_START')
      group.transition('customer_3', 'SPEECH_START')

      const lost = group.transition('customer_1', 'TARGET_LOST')
      expect(lost).toBe('idle')

      expect(group.getTarget()).toBe('customer_2')
      expect(group.getQueued()).toEqual(['customer_3'])
    })

    it('goes to idle when last target leaves with empty queue', () => {
      group.transition('customer_1', 'SPEECH_START')
      group.transition('customer_1', 'TARGET_LOST')

      expect(group.getTarget()).toBeNull()
      expect(group.getQueued()).toEqual([])
    })
  })

  // ── Ambient ────────────────────────────────────────────────────────

  describe('ambient speakers', () => {
    it('AMBIENT_DETECTED adds speaker as ambient', () => {
      const state = group.transition('bystander', 'AMBIENT_DETECTED')
      expect(state).toBe('ambient')
      expect(group.getAmbient()).toEqual(['bystander'])
    })

    it('ambient speaker can be promoted to targeted if no one else is', () => {
      group.transition('bystander', 'AMBIENT_DETECTED')
      const state = group.transition('bystander', 'SPEECH_START')

      expect(state).toBe('targeted')
      expect(group.getTarget()).toBe('bystander')
      expect(group.getAmbient()).toEqual([])
    })

    it('ambient speaker goes to queued if someone else is targeted', () => {
      group.transition('customer_1', 'SPEECH_START')
      group.transition('bystander', 'AMBIENT_DETECTED')
      const state = group.transition('bystander', 'SPEECH_START')

      expect(state).toBe('queued')
    })

    it('setAmbient() manually sets a speaker to ambient', () => {
      group.transition('customer_1', 'SPEECH_START')
      group.setAmbient('customer_1')

      expect(group.getSpeakerState('customer_1')).toBe('ambient')
      expect(group.getTarget()).toBeNull()
    })

    it('setAmbient() removes speaker from queue', () => {
      group.transition('customer_1', 'SPEECH_START')
      group.transition('customer_2', 'SPEECH_START')

      group.setAmbient('customer_2')

      expect(group.getQueued()).toEqual([])
      expect(group.getAmbient()).toEqual(['customer_2'])
    })

    it('setAmbient() on unknown speaker adds them as ambient', () => {
      group.setAmbient('new_bystander')
      expect(group.getSpeakerState('new_bystander')).toBe('ambient')
    })
  })

  // ── SPEECH_END ─────────────────────────────────────────────────────

  describe('SPEECH_END', () => {
    it('does not lose target on SPEECH_END', () => {
      group.transition('customer_1', 'SPEECH_START')
      const state = group.transition('customer_1', 'SPEECH_END')

      expect(state).toBe('targeted')
      expect(group.getTarget()).toBe('customer_1')
    })

    it('returns idle for unknown speaker', () => {
      const state = group.transition('unknown', 'SPEECH_END')
      expect(state).toBe('idle')
    })
  })

  // ── No-op transitions ──────────────────────────────────────────────

  describe('no-op transitions', () => {
    it('RESPONSE_START on non-targeted speaker is no-op', () => {
      group.transition('customer_1', 'SPEECH_START')
      group.transition('customer_2', 'SPEECH_START')

      const state = group.transition('customer_2', 'RESPONSE_START')
      expect(state).toBe('queued') // still queued
    })

    it('AMBIENT_DETECTED on already targeted speaker is no-op', () => {
      group.transition('customer_1', 'SPEECH_START')
      const state = group.transition('customer_1', 'AMBIENT_DETECTED')
      expect(state).toBe('targeted') // doesn't demote
    })

    it('SPEECH_START on already targeted speaker keeps state', () => {
      group.transition('customer_1', 'SPEECH_START')
      const state = group.transition('customer_1', 'SPEECH_START')
      expect(state).toBe('targeted')
    })
  })

  // ── Multi-speaker scenario ─────────────────────────────────────────

  describe('full multi-speaker scenario', () => {
    it('handles realistic store interaction', () => {
      // Customer 1 arrives and is targeted
      expect(group.transition('C1', 'SPEECH_START')).toBe('targeted')

      // Bystander overheard
      expect(group.transition('B1', 'AMBIENT_DETECTED')).toBe('ambient')

      // Customer 2 arrives → queued
      expect(group.transition('C2', 'SPEECH_START')).toBe('queued')

      // Agent starts responding to C1
      expect(group.transition('C1', 'RESPONSE_START')).toBe('responding')

      // Agent finishes response
      expect(group.transition('C1', 'RESPONSE_END')).toBe('targeted')

      // C1 leaves
      expect(group.transition('C1', 'TARGET_LOST')).toBe('idle')

      // C2 promoted
      expect(group.getTarget()).toBe('C2')
      expect(group.getSpeakerState('C2')).toBe('targeted')

      // Bystander still ambient
      expect(group.getSpeakerState('B1')).toBe('ambient')
    })
  })

  // ── Utility ────────────────────────────────────────────────────────

  describe('utilities', () => {
    it('getAllSpeakers returns all', () => {
      group.transition('C1', 'SPEECH_START')
      group.transition('C2', 'SPEECH_START')
      group.transition('B1', 'AMBIENT_DETECTED')

      const all = group.getAllSpeakers()
      expect(all).toHaveLength(3)
    })

    it('reset clears everything', () => {
      group.transition('C1', 'SPEECH_START')
      group.transition('C2', 'SPEECH_START')
      group.reset()

      expect(group.getTarget()).toBeNull()
      expect(group.getQueued()).toEqual([])
      expect(group.getAllSpeakers()).toEqual([])
    })

    it('getSpeakerState returns null for unknown', () => {
      expect(group.getSpeakerState('unknown')).toBeNull()
    })
  })
})
