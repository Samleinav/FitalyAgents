import { describe, it, expect, beforeEach, afterEach } from 'vitest'
import { InMemoryAudioQueueService } from './in-memory-audio-queue-service.js'
import { InMemoryBus } from '../bus/in-memory-bus.js'
import type { AudioSegment } from './types.js'

function makeSeg(overrides: Partial<AudioSegment> = {}): AudioSegment {
    return {
        segmentId: 'seg_1',
        text: 'Hello, how can I help you?',
        priority: 5,
        ...overrides,
    }
}

describe('InMemoryAudioQueueService', () => {
    let bus: InMemoryBus
    let played: Array<{ sessionId: string; segment: AudioSegment }>
    let service: InMemoryAudioQueueService

    beforeEach(() => {
        bus = new InMemoryBus()
        played = []
        service = new InMemoryAudioQueueService({
            bus,
            onSegmentReady: async (sessionId, segment) => {
                played.push({ sessionId, segment })
            },
        })
    })

    afterEach(() => {
        service.dispose()
    })

    // ── Push & playback ───────────────────────────────────────────────────

    describe('push & playback', () => {
        it('pushes a segment and plays it via callback', async () => {
            const result = await service.push('sess_1', makeSeg())

            expect(result.segmentId).toBe('seg_1')
            expect(result.position).toBe(0)

            // Wait for async processing
            await new Promise((r) => setTimeout(r, 50))

            expect(played.length).toBe(1)
            expect(played[0]!.sessionId).toBe('sess_1')
            expect(played[0]!.segment.text).toBe('Hello, how can I help you?')
        })

        it('plays multiple segments in FIFO order', async () => {
            await service.push('sess_1', makeSeg({ segmentId: 'a', text: 'First', priority: 5 }))
            await service.push('sess_1', makeSeg({ segmentId: 'b', text: 'Second', priority: 5 }))
            await service.push('sess_1', makeSeg({ segmentId: 'c', text: 'Third', priority: 5 }))

            await new Promise((r) => setTimeout(r, 100))

            expect(played.map((p) => p.segment.segmentId)).toEqual(['a', 'b', 'c'])
        })

        it('higher priority segment jumps ahead', async () => {
            // Push a low-priority that will be processed quickly, then interrupt won't help
            // Instead, push several at once with different priorities
            // The service will sort them by priority on insert

            // We need to interrupt first to queue them up without processing
            await service.push('sess_1', makeSeg({ segmentId: 'low', text: 'Low', priority: 1 }))
            // Interrupt before processing gets to remaining
            await service.interrupt('sess_1')

            // Now push high-priority while interrupted
            await service.push('sess_1', makeSeg({ segmentId: 'high', text: 'High', priority: 10 }))
            await service.push('sess_1', makeSeg({ segmentId: 'mid', text: 'Mid', priority: 5 }))

            // Resume
            await service.continue('sess_1')
            await new Promise((r) => setTimeout(r, 100))

            // After the initial 'low' that already played, the remaining should be high, mid
            const remaining = played.filter((p) => p.segment.segmentId !== 'low')
            expect(remaining.map((p) => p.segment.segmentId)).toEqual(['high', 'mid'])
        })
    })

    // ── Interrupt / Continue ──────────────────────────────────────────────

    describe('interrupt / continue', () => {
        it('interrupt pauses playback', async () => {
            await service.push('sess_1', makeSeg({ segmentId: 'a' }))
            await service.interrupt('sess_1')

            expect(service.getState('sess_1')).toBe('interrupted')
        })

        it('continue resumes after interrupt', async () => {
            await service.interrupt('sess_1')
            await service.push('sess_1', makeSeg({ segmentId: 'a' }))

            // Nothing should play while interrupted
            await new Promise((r) => setTimeout(r, 50))
            expect(played.length).toBe(0)

            await service.continue('sess_1')
            await new Promise((r) => setTimeout(r, 50))

            expect(played.length).toBe(1)
            expect(played[0]!.segment.segmentId).toBe('a')
        })

        it('interrupt on non-existent session is a no-op', async () => {
            await service.interrupt('ghost')
            // Should not throw
        })
    })

    // ── Clear ─────────────────────────────────────────────────────────────

    describe('clear', () => {
        it('removes all pending segments', async () => {
            await service.interrupt('sess_1')
            await service.push('sess_1', makeSeg({ segmentId: 'a' }))
            await service.push('sess_1', makeSeg({ segmentId: 'b' }))

            await service.clear('sess_1')
            expect(service.getPending('sess_1')).toEqual([])

            // Resume — nothing to play
            await service.continue('sess_1')
            await new Promise((r) => setTimeout(r, 50))
            expect(played.length).toBe(0)
        })
    })

    // ── Modify ────────────────────────────────────────────────────────────

    describe('modify', () => {
        it('replaces a pending segment', async () => {
            await service.interrupt('sess_1')
            await service.push('sess_1', makeSeg({ segmentId: 'filler', text: 'One moment...' }))

            const modified = await service.modify(
                'sess_1',
                'filler',
                makeSeg({ segmentId: 'real', text: 'Here are your results!' }),
            )

            expect(modified).toBe(true)

            const pending = service.getPending('sess_1')
            expect(pending.length).toBe(1)
            expect(pending[0]!.segmentId).toBe('real')
            expect(pending[0]!.text).toBe('Here are your results!')
        })

        it('returns false for non-existent segment', async () => {
            const modified = await service.modify('sess_1', 'ghost', makeSeg())
            expect(modified).toBe(false)
        })

        it('returns false for non-existent session', async () => {
            const modified = await service.modify('ghost', 'seg_1', makeSeg())
            expect(modified).toBe(false)
        })
    })

    // ── Auto-interrupt on BARGE_IN ────────────────────────────────────────

    describe('auto-interrupt on BARGE_IN', () => {
        it('auto-interrupts when bus:BARGE_IN fires', async () => {
            service.start()

            await service.push('sess_1', makeSeg({ segmentId: 'a' }))
            await new Promise((r) => setTimeout(r, 50))

            // Push more segments
            await service.push('sess_1', makeSeg({ segmentId: 'b' }))

            // Fire BARGE_IN
            await bus.publish('bus:BARGE_IN', {
                event: 'BARGE_IN',
                session_id: 'sess_1',
                timestamp: Date.now(),
            })

            await new Promise((r) => setTimeout(r, 50))

            expect(service.getState('sess_1')).toBe('interrupted')
        })
    })

    // ── Bus events ────────────────────────────────────────────────────────

    describe('bus events', () => {
        it('emits AUDIO_SEGMENT_QUEUED on push', async () => {
            const events: unknown[] = []
            bus.subscribe('bus:AUDIO_SEGMENT_QUEUED', (data) => events.push(data))

            await service.push('sess_1', makeSeg())

            expect(events.length).toBe(1)
            expect(events[0]).toHaveProperty('segment_id', 'seg_1')
        })

        it('emits AUDIO_SEGMENT_PLAYING and AUDIO_SEGMENT_DONE', async () => {
            const playing: unknown[] = []
            const done: unknown[] = []
            bus.subscribe('bus:AUDIO_SEGMENT_PLAYING', (data) => playing.push(data))
            bus.subscribe('bus:AUDIO_SEGMENT_DONE', (data) => done.push(data))

            await service.push('sess_1', makeSeg())
            await new Promise((r) => setTimeout(r, 50))

            expect(playing.length).toBe(1)
            expect(done.length).toBe(1)
        })
    })

    // ── Session isolation ─────────────────────────────────────────────────

    describe('session isolation', () => {
        it('different sessions have independent queues', async () => {
            await service.push('sess_A', makeSeg({ segmentId: 'a', text: 'For A' }))
            await service.push('sess_B', makeSeg({ segmentId: 'b', text: 'For B' }))

            await new Promise((r) => setTimeout(r, 50))

            const forA = played.filter((p) => p.sessionId === 'sess_A')
            const forB = played.filter((p) => p.sessionId === 'sess_B')
            expect(forA.length).toBe(1)
            expect(forB.length).toBe(1)
            expect(forA[0]!.segment.text).toBe('For A')
            expect(forB[0]!.segment.text).toBe('For B')
        })

        it('interrupting one session does not affect another', async () => {
            await service.interrupt('sess_A')
            await service.push('sess_A', makeSeg({ segmentId: 'a' }))
            await service.push('sess_B', makeSeg({ segmentId: 'b' }))

            await new Promise((r) => setTimeout(r, 50))

            // sess_A interrupted — nothing played
            const forA = played.filter((p) => p.sessionId === 'sess_A')
            expect(forA.length).toBe(0)

            // sess_B should have played normally
            const forB = played.filter((p) => p.sessionId === 'sess_B')
            expect(forB.length).toBe(1)
        })
    })

    // ── getState / getPending ─────────────────────────────────────────────

    describe('getState / getPending', () => {
        it('returns idle for unknown session', () => {
            expect(service.getState('ghost')).toBe('idle')
        })

        it('returns empty array for unknown session pending', () => {
            expect(service.getPending('ghost')).toEqual([])
        })
    })
})
