import { describe, it, expect } from 'vitest'
import { TargetGroupBridge } from './target-group-bridge.js'
import { InMemoryBus } from '../bus/in-memory-bus.js'
import { InMemorySessionManager } from '../session/in-memory-session-manager.js'
import type { TargetGroupSnapshot } from './target-group-bridge.js'

// ── Helpers ───────────────────────────────────────────────────────────────────

function createBridge() {
  const bus = new InMemoryBus()
  const sessionManager = new InMemorySessionManager()
  const snapshots: TargetGroupSnapshot[] = []

  bus.subscribe('bus:TARGET_GROUP_CHANGED', (data) => snapshots.push(data as TargetGroupSnapshot))

  const bridge = new TargetGroupBridge({
    bus,
    sessionManager,
    storeId: 'store_test',
  })

  return { bridge, bus, sessionManager, snapshots }
}

async function tick() {
  return new Promise<void>((r) => setTimeout(r, 10))
}

// ── Tests ─────────────────────────────────────────────────────────────────────

describe('TargetGroupBridge', () => {
  // ── Lifecycle ──────────────────────────────────────────────────────

  describe('lifecycle', () => {
    it('does not process events before start()', async () => {
      const { bridge, bus, snapshots } = createBridge()

      await bus.publish('bus:SPEAKER_DETECTED', {
        session_id: 'ses-1',
        speaker_id: 'spk-1',
        store_id: 'store_test',
      })
      await tick()

      expect(snapshots).toHaveLength(0)
      await bridge.stop()
    })

    it('stops processing after stop()', async () => {
      const { bridge, bus, snapshots } = createBridge()
      await bridge.start()
      await bridge.stop()

      await bus.publish('bus:SPEAKER_DETECTED', {
        session_id: 'ses-1',
        speaker_id: 'spk-1',
        store_id: 'store_test',
      })
      await tick()

      expect(snapshots).toHaveLength(0)
    })
  })

  // ── Single speaker flow ────────────────────────────────────────────

  describe('single speaker', () => {
    it('first speaker becomes primary target and session is created', async () => {
      const { bridge, bus, sessionManager, snapshots } = createBridge()
      await bridge.start()

      await bus.publish('bus:SPEAKER_DETECTED', {
        session_id: 'ses-1',
        speaker_id: 'spk-1',
        store_id: 'store_test',
      })
      await tick()

      // Snapshot published
      expect(snapshots).toHaveLength(1)
      expect(snapshots[0].primary).toBe('spk-1')
      expect(snapshots[0].queued).toHaveLength(0)
      expect(snapshots[0].store_id).toBe('store_test')

      // Session created
      const sessionId = bridge.getSessionForSpeaker('spk-1')
      expect(sessionId).toBeDefined()
      const session = await sessionManager.getSession(sessionId!)
      expect(session).not.toBeNull()
      expect(session!.status).toBe('active')
      expect(session!.metadata?.speaker_id).toBe('spk-1')

      await bridge.stop()
    })

    it('reuses the provided session_id for speaker routing', async () => {
      const { bridge, bus, sessionManager } = createBridge()
      await bridge.start()

      await bus.publish('bus:SPEAKER_DETECTED', {
        session_id: 'session_store_spk_1',
        speaker_id: 'spk-1',
        store_id: 'store_test',
      })
      await tick()

      expect(bridge.getSessionForSpeaker('spk-1')).toBe('session_store_spk_1')
      expect(await sessionManager.getSession('session_store_spk_1')).not.toBeNull()

      await bridge.stop()
    })

    it('supports custom runtime session resolution', async () => {
      const bus = new InMemoryBus()
      const sessionManager = new InMemorySessionManager()
      const bridge = new TargetGroupBridge({
        bus,
        sessionManager,
        storeId: 'store_test',
        resolveSessionId: (speakerId) => `runtime_${speakerId}`,
      })
      await bridge.start()

      await bus.publish('bus:SPEAKER_DETECTED', {
        session_id: 'source-room-a',
        speaker_id: 'spk-1',
        store_id: 'store_test',
      })
      await tick()

      expect(bridge.getSessionForSpeaker('spk-1')).toBe('runtime_spk-1')
      expect(await sessionManager.getSession('runtime_spk-1')).not.toBeNull()

      await bridge.stop()
    })

    it('FSM state is targeted for primary speaker', async () => {
      const { bridge, bus } = createBridge()
      await bridge.start()

      await bus.publish('bus:SPEAKER_DETECTED', {
        session_id: 'ses-1',
        speaker_id: 'spk-1',
        store_id: 'store_test',
      })
      await tick()

      expect(bridge.stateMachine.getTarget()).toBe('spk-1')

      await bridge.stop()
    })

    it('speaker lost → FSM resets, session removed from map', async () => {
      const { bridge, bus, snapshots } = createBridge()
      await bridge.start()

      await bus.publish('bus:SPEAKER_DETECTED', {
        session_id: 'ses-1',
        speaker_id: 'spk-1',
        store_id: 'store_test',
      })
      await tick()

      await bus.publish('bus:SPEAKER_LOST', {
        session_id: 'ses-1',
        speaker_id: 'spk-1',
      })
      await tick()

      expect(bridge.stateMachine.getTarget()).toBeNull()
      expect(bridge.getSessionForSpeaker('spk-1')).toBeUndefined()

      // Snapshot reflects no primary
      const last = snapshots[snapshots.length - 1]
      expect(last.primary).toBeNull()

      await bridge.stop()
    })
  })

  // ── Multi-speaker queuing ──────────────────────────────────────────

  describe('multi-speaker queuing', () => {
    it('second speaker while first is targeted → queued with priority 0', async () => {
      const { bridge, bus, sessionManager, snapshots } = createBridge()
      await bridge.start()

      // First speaker
      await bus.publish('bus:SPEAKER_DETECTED', {
        session_id: 'ses-1',
        speaker_id: 'spk-1',
        store_id: 'store_test',
      })
      await tick()

      // Second speaker
      await bus.publish('bus:SPEAKER_DETECTED', {
        session_id: 'ses-2',
        speaker_id: 'spk-2',
        store_id: 'store_test',
      })
      await tick()

      // FSM state
      expect(bridge.stateMachine.getTarget()).toBe('spk-1')
      expect(bridge.stateMachine.getQueued()).toContain('spk-2')

      // Snapshot
      const last = snapshots[snapshots.length - 1]
      expect(last.primary).toBe('spk-1')
      expect(last.queued).toContain('spk-2')

      // spk-2 session has priority 0
      const sessionId2 = bridge.getSessionForSpeaker('spk-2')
      expect(sessionId2).toBeDefined()
      const session2 = await sessionManager.getSession(sessionId2!)
      expect(session2!.priorityGroup).toBe(0)

      await bridge.stop()
    })

    it('falls back to a unique session when upstream reuses the same session_id for another speaker', async () => {
      const { bridge, bus } = createBridge()
      await bridge.start()

      await bus.publish('bus:SPEAKER_DETECTED', {
        session_id: 'shared-session',
        speaker_id: 'spk-1',
        store_id: 'store_test',
      })
      await tick()

      await bus.publish('bus:SPEAKER_DETECTED', {
        session_id: 'shared-session',
        speaker_id: 'spk-2',
        store_id: 'store_test',
      })
      await tick()

      expect(bridge.getSessionForSpeaker('spk-1')).toBe('shared-session')
      expect(bridge.getSessionForSpeaker('spk-2')).toBeDefined()
      expect(bridge.getSessionForSpeaker('spk-2')).not.toBe('shared-session')

      await bridge.stop()
    })

    it('primary lost → queued speaker promoted, priority upgraded to 1', async () => {
      const { bridge, bus, sessionManager } = createBridge()
      await bridge.start()

      await bus.publish('bus:SPEAKER_DETECTED', {
        session_id: 'ses-1',
        speaker_id: 'spk-1',
        store_id: 'store_test',
      })
      await tick()

      await bus.publish('bus:SPEAKER_DETECTED', {
        session_id: 'ses-2',
        speaker_id: 'spk-2',
        store_id: 'store_test',
      })
      await tick()

      // spk-1 lost
      await bus.publish('bus:SPEAKER_LOST', {
        session_id: 'ses-1',
        speaker_id: 'spk-1',
      })
      await tick()

      // spk-2 now primary
      expect(bridge.stateMachine.getTarget()).toBe('spk-2')

      // spk-2 session promoted to priority 1
      const sessionId2 = bridge.getSessionForSpeaker('spk-2')!
      const session2 = await sessionManager.getSession(sessionId2)
      expect(session2!.priorityGroup).toBe(1)

      await bridge.stop()
    })

    it('publishes snapshot with correct queued array after second speaker', async () => {
      const { bridge, bus, snapshots } = createBridge()
      await bridge.start()

      await bus.publish('bus:SPEAKER_DETECTED', {
        session_id: 'ses-1',
        speaker_id: 'spk-1',
        store_id: 'store_test',
      })
      await tick()

      await bus.publish('bus:SPEAKER_DETECTED', {
        session_id: 'ses-2',
        speaker_id: 'spk-2',
        store_id: 'store_test',
      })
      await tick()

      const last = snapshots[snapshots.length - 1]
      expect(last.queued).toEqual(['spk-2'])
      expect(last.speakers).toHaveLength(2)

      await bridge.stop()
    })
  })

  // ── Ambient handling ───────────────────────────────────────────────

  describe('ambient speaker', () => {
    it('ambient speaker → state set to ambient, no session created', async () => {
      const { bridge, bus, snapshots } = createBridge()
      await bridge.start()

      await bus.publish('bus:SPEAKER_AMBIENT', {
        session_id: 'ses-ambient',
        speaker_id: 'spk-ambient',
        text: 'hablando de fondo',
      })
      await tick()

      expect(bridge.stateMachine.getSpeakerState('spk-ambient')).toBe('ambient')
      expect(bridge.getSessionForSpeaker('spk-ambient')).toBeUndefined()

      const last = snapshots[snapshots.length - 1]
      expect(last.ambient).toContain('spk-ambient')

      await bridge.stop()
    })
  })

  // ── Response transitions ───────────────────────────────────────────

  describe('response transitions', () => {
    it('RESPONSE_START sets speaker to responding', async () => {
      const { bridge, bus, snapshots } = createBridge()
      await bridge.start()

      await bus.publish('bus:SPEAKER_DETECTED', {
        session_id: 'ses-1',
        speaker_id: 'spk-1',
        store_id: 'store_test',
      })
      await tick()

      await bus.publish('bus:RESPONSE_START', { speaker_id: 'spk-1' })
      await tick()

      expect(bridge.stateMachine.getSpeakerState('spk-1')).toBe('responding')

      const last = snapshots[snapshots.length - 1]
      expect(last.speakers.find((s) => s.speakerId === 'spk-1')?.state).toBe('responding')

      await bridge.stop()
    })

    it('RESPONSE_END restores speaker to targeted', async () => {
      const { bridge, bus } = createBridge()
      await bridge.start()

      await bus.publish('bus:SPEAKER_DETECTED', {
        session_id: 'ses-1',
        speaker_id: 'spk-1',
        store_id: 'store_test',
      })
      await tick()

      await bus.publish('bus:RESPONSE_START', { speaker_id: 'spk-1' })
      await tick()

      await bus.publish('bus:RESPONSE_END', { speaker_id: 'spk-1' })
      await tick()

      expect(bridge.stateMachine.getSpeakerState('spk-1')).toBe('targeted')

      await bridge.stop()
    })
  })

  // ── Snapshot structure ─────────────────────────────────────────────

  describe('snapshot', () => {
    it('snapshot includes timestamp and store_id', async () => {
      const { bridge, bus, snapshots } = createBridge()
      await bridge.start()

      await bus.publish('bus:SPEAKER_DETECTED', {
        session_id: 'ses-1',
        speaker_id: 'spk-1',
        store_id: 'store_test',
      })
      await tick()

      expect(snapshots[0].event).toBe('TARGET_GROUP_CHANGED')
      expect(snapshots[0].store_id).toBe('store_test')
      expect(typeof snapshots[0].timestamp).toBe('number')

      await bridge.stop()
    })

    it('publishes one snapshot per event', async () => {
      const { bridge, bus, snapshots } = createBridge()
      await bridge.start()

      await bus.publish('bus:SPEAKER_DETECTED', {
        session_id: 'ses-1',
        speaker_id: 'spk-1',
        store_id: 'store_test',
      })
      await tick()
      await bus.publish('bus:RESPONSE_START', { speaker_id: 'spk-1' })
      await tick()
      await bus.publish('bus:RESPONSE_END', { speaker_id: 'spk-1' })
      await tick()
      await bus.publish('bus:SPEAKER_LOST', {
        session_id: 'ses-1',
        speaker_id: 'spk-1',
      })
      await tick()

      expect(snapshots).toHaveLength(4)

      await bridge.stop()
    })
  })

  // ── Re-entry / idempotency ─────────────────────────────────────────

  describe('re-entry', () => {
    it('same speaker detected twice → session reused (not duplicated)', async () => {
      const { bridge, bus, sessionManager } = createBridge()
      await bridge.start()

      await bus.publish('bus:SPEAKER_DETECTED', {
        session_id: 'ses-1',
        speaker_id: 'spk-1',
        store_id: 'store_test',
      })
      await tick()

      const firstSessionId = bridge.getSessionForSpeaker('spk-1')

      await bus.publish('bus:SPEAKER_DETECTED', {
        session_id: 'ses-1',
        speaker_id: 'spk-1',
        store_id: 'store_test',
      })
      await tick()

      const secondSessionId = bridge.getSessionForSpeaker('spk-1')
      expect(secondSessionId).toBe(firstSessionId)

      const sessions = await sessionManager.listActiveSessions()
      const spk1Sessions = sessions.filter((id) => id === firstSessionId)
      expect(spk1Sessions).toHaveLength(1)

      await bridge.stop()
    })
  })
})
