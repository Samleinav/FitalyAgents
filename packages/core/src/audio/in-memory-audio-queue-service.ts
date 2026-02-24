import type {
    IAudioQueueService,
    AudioSegment,
    PushResult,
    PlaybackState,
    AudioQueueServiceDeps,
    OnSegmentReady,
} from './types.js'
import type { Unsubscribe } from '../types/index.js'

/**
 * Per-session queue state.
 */
interface SessionQueue {
    segments: AudioSegment[]
    state: PlaybackState
    processing: boolean
}

/**
 * In-memory AudioQueueService.
 *
 * Manages ordered audio output queues per session with interrupt/continue
 * semantics for barge-in handling. Each session has its own FIFO queue
 * with priority-based insertion.
 *
 * The `onSegmentReady` callback is invoked for each segment in order.
 * In production, this triggers TTS rendering + audio playback.
 *
 * @example
 * ```typescript
 * const audio = new InMemoryAudioQueueService({
 *   bus,
 *   onSegmentReady: async (sessionId, seg) => {
 *     await tts.speak(seg.text)
 *   },
 * })
 * const unsub = audio.start()
 *
 * await audio.push('sess_1', { segmentId: 's1', text: 'Hello!', priority: 5 })
 * ```
 */
export class InMemoryAudioQueueService implements IAudioQueueService {
    private readonly bus: AudioQueueServiceDeps['bus']
    private readonly onSegmentReady: OnSegmentReady
    private queues: Map<string, SessionQueue> = new Map()
    private unsubs: Unsubscribe[] = []

    constructor(deps: AudioQueueServiceDeps) {
        this.bus = deps.bus
        this.onSegmentReady = deps.onSegmentReady
    }

    // ── Queue operations ──────────────────────────────────────────────────

    async push(sessionId: string, segment: AudioSegment): Promise<PushResult> {
        const queue = this.getOrCreateQueue(sessionId)

        // Priority-based insertion: higher priority goes closer to front
        let insertIdx = queue.segments.length
        for (let i = 0; i < queue.segments.length; i++) {
            if (segment.priority > queue.segments[i]!.priority) {
                insertIdx = i
                break
            }
        }
        queue.segments.splice(insertIdx, 0, segment)

        await this.bus.publish('bus:AUDIO_SEGMENT_QUEUED', {
            event: 'AUDIO_SEGMENT_QUEUED',
            session_id: sessionId,
            segment_id: segment.segmentId,
            position: insertIdx,
            queue_length: queue.segments.length,
        })

        // Trigger processing if idle and not interrupted
        if (queue.state === 'idle' && !queue.processing) {
            void this.processQueue(sessionId)
        }

        return { position: insertIdx, segmentId: segment.segmentId }
    }

    async interrupt(sessionId: string): Promise<void> {
        const queue = this.getOrCreateQueue(sessionId)

        queue.state = 'interrupted'

        await this.bus.publish('bus:AUDIO_INTERRUPTED', {
            event: 'AUDIO_INTERRUPTED',
            session_id: sessionId,
            pending_count: queue.segments.length,
        })
    }

    async continue(sessionId: string): Promise<void> {
        const queue = this.queues.get(sessionId)
        if (!queue || queue.state !== 'interrupted') return

        queue.state = 'idle'

        await this.bus.publish('bus:AUDIO_RESUMED', {
            event: 'AUDIO_RESUMED',
            session_id: sessionId,
        })

        // Resume processing
        if (queue.segments.length > 0 && !queue.processing) {
            void this.processQueue(sessionId)
        }
    }

    async clear(sessionId: string): Promise<void> {
        const queue = this.queues.get(sessionId)
        if (!queue) return

        const cleared = queue.segments.length
        queue.segments = []

        await this.bus.publish('bus:AUDIO_CLEARED', {
            event: 'AUDIO_CLEARED',
            session_id: sessionId,
            segments_cleared: cleared,
        })
    }

    async modify(
        sessionId: string,
        segmentId: string,
        newSegment: AudioSegment,
    ): Promise<boolean> {
        const queue = this.queues.get(sessionId)
        if (!queue) return false

        const idx = queue.segments.findIndex((s) => s.segmentId === segmentId)
        if (idx === -1) return false

        queue.segments[idx] = newSegment

        await this.bus.publish('bus:AUDIO_SEGMENT_MODIFIED', {
            event: 'AUDIO_SEGMENT_MODIFIED',
            session_id: sessionId,
            segment_id: segmentId,
            new_segment_id: newSegment.segmentId,
        })

        return true
    }

    // ── State queries ─────────────────────────────────────────────────────

    getState(sessionId: string): PlaybackState {
        return this.queues.get(sessionId)?.state ?? 'idle'
    }

    getPending(sessionId: string): AudioSegment[] {
        return [...(this.queues.get(sessionId)?.segments ?? [])]
    }

    // ── Lifecycle ─────────────────────────────────────────────────────────

    start(): Unsubscribe {
        // Auto-interrupt on BARGE_IN
        const unsub = this.bus.subscribe('bus:BARGE_IN', (data) => {
            const event = data as { session_id: string }
            void this.interrupt(event.session_id)
        })
        this.unsubs.push(unsub)

        return () => this.dispose()
    }

    dispose(): void {
        for (const unsub of this.unsubs) unsub()
        this.unsubs = []
        this.queues.clear()
    }

    // ── Private ───────────────────────────────────────────────────────────

    private getOrCreateQueue(sessionId: string): SessionQueue {
        let queue = this.queues.get(sessionId)
        if (!queue) {
            queue = { segments: [], state: 'idle', processing: false }
            this.queues.set(sessionId, queue)
        }
        return queue
    }

    private async processQueue(sessionId: string): Promise<void> {
        const queue = this.queues.get(sessionId)
        if (!queue || queue.processing) return

        queue.processing = true

        while (queue.segments.length > 0) {
            // Check if interrupted
            if (queue.state === 'interrupted') {
                break
            }

            const segment = queue.segments.shift()!
            queue.state = 'playing'

            await this.bus.publish('bus:AUDIO_SEGMENT_PLAYING', {
                event: 'AUDIO_SEGMENT_PLAYING',
                session_id: sessionId,
                segment_id: segment.segmentId,
            })

            // Invoke the playback callback
            await this.onSegmentReady(sessionId, segment)

            await this.bus.publish('bus:AUDIO_SEGMENT_DONE', {
                event: 'AUDIO_SEGMENT_DONE',
                session_id: sessionId,
                segment_id: segment.segmentId,
            })
        }

        // Only go idle if not interrupted
        if (queue.state !== 'interrupted') {
            queue.state = 'idle'
        }
        queue.processing = false
    }
}
