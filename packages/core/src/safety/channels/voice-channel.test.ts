import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest'
import { InMemoryBus } from '../../bus/in-memory-bus.js'
import { VoiceApprovalChannel } from './voice-channel.js'
import type { IEventBus } from '../../types/index.js'
import type { ApprovalRequest, HumanProfile } from './types.js'

function makeRequest(overrides?: Partial<ApprovalRequest>): ApprovalRequest {
  return {
    id: 'req_001',
    draft_id: 'draft_001',
    action: 'refund_create',
    amount: 15_000,
    session_id: 'session-1',
    required_role: 'manager',
    context: {},
    timeout_ms: 15_000,
    ...overrides,
  }
}

function makeApprover(overrides?: Partial<HumanProfile>): HumanProfile {
  return {
    id: 'emp_carlos',
    name: 'Don Carlos',
    role: 'manager',
    store_id: 'store_001',
    approval_limits: { refund_max: 100_000 },
    ...overrides,
  }
}

describe('VoiceApprovalChannel', () => {
  let bus: IEventBus
  let channel: VoiceApprovalChannel

  beforeEach(() => {
    vi.useFakeTimers()
    bus = new InMemoryBus()
    channel = new VoiceApprovalChannel({ bus })
  })

  afterEach(() => {
    vi.useRealTimers()
  })

  describe('notify()', () => {
    it('publishes APPROVAL_VOICE_REQUEST with prompt', async () => {
      const events: unknown[] = []
      bus.subscribe('bus:APPROVAL_VOICE_REQUEST', (data) => events.push(data))

      const request = makeRequest()
      const approver = makeApprover()
      await channel.notify(request, approver)

      expect(events).toHaveLength(1)
      expect(events[0]).toMatchObject({
        event: 'APPROVAL_VOICE_REQUEST',
        request_id: 'req_001',
        approver_id: 'emp_carlos',
      })
      expect((events[0] as Record<string, unknown>).prompt_text).toContain('Don Carlos')
    })
  })

  describe('waitForResponse()', () => {
    it('resolves when speaker says affirmative', async () => {
      const request = makeRequest()
      const promise = channel.waitForResponse(request, 15_000)

      // Simulate speaker response
      await bus.publish('bus:SPEECH_FINAL', {
        session_id: 'session-1',
        text: 'sí, aprobado',
        speaker_id: 'emp_carlos',
      })

      const result = await promise
      expect(result).not.toBeNull()
      expect(result!.approved).toBe(true)
      expect(result!.approver_id).toBe('emp_carlos')
      expect(result!.channel_used).toBe('voice')
    })

    it('resolves with rejected when speaker says negative', async () => {
      const request = makeRequest()
      const promise = channel.waitForResponse(request, 15_000)

      await bus.publish('bus:SPEECH_FINAL', {
        session_id: 'session-1',
        text: 'no, rechaza eso',
        speaker_id: 'emp_carlos',
      })

      const result = await promise
      expect(result).not.toBeNull()
      expect(result!.approved).toBe(false)
    })

    it('returns null on timeout', async () => {
      const request = makeRequest()
      const promise = channel.waitForResponse(request, 5_000)

      vi.advanceTimersByTime(5_000)

      const result = await promise
      expect(result).toBeNull()
    })

    it('ignores speech without speaker_id', async () => {
      const request = makeRequest()
      const promise = channel.waitForResponse(request, 5_000)

      await bus.publish('bus:SPEECH_FINAL', {
        session_id: 'session-1',
        text: 'sí',
      })

      vi.advanceTimersByTime(5_000)
      const result = await promise
      expect(result).toBeNull()
    })

    it('ignores speech from a different expected approver', async () => {
      const request = makeRequest({
        context: { expected_approver_id: 'emp_carlos' },
      })
      const promise = channel.waitForResponse(request, 5_000)

      await bus.publish('bus:SPEECH_FINAL', {
        session_id: 'session-1',
        text: 'sí, aprobado',
        speaker_id: 'emp_maria',
      })

      vi.advanceTimersByTime(5_000)
      const result = await promise
      expect(result).toBeNull()
    })

    it('ignores ambiguous speech (neither yes nor no)', async () => {
      const request = makeRequest()
      const promise = channel.waitForResponse(request, 5_000)

      await bus.publish('bus:SPEECH_FINAL', {
        session_id: 'session-1',
        text: 'hmm, déjame pensar',
        speaker_id: 'emp_carlos',
      })

      vi.advanceTimersByTime(5_000)
      const result = await promise
      expect(result).toBeNull()
    })
  })

  describe('cancel()', () => {
    it('resolves with null when cancelled', async () => {
      const request = makeRequest()
      const promise = channel.waitForResponse(request, 15_000)

      channel.cancel(request.id)

      const result = await promise
      expect(result).toBeNull()
    })
  })
})
