import type { IEventBus, Unsubscribe } from '../types/index.js'

// ── Audio Segment ───────────────────────────────────────────────────────────

/**
 * A unit of audio output to be played in sequence.
 */
export interface AudioSegment {
    /** Unique identifier for this segment */
    segmentId: string
    /** Text to be spoken (for TTS) */
    text: string
    /** Pre-rendered TTS audio URL (skip TTS if provided) */
    ttsReadyUrl?: string
    /** Priority: higher-priority segments can jump ahead in the queue */
    priority: number
}

/**
 * Result of pushing a segment to the queue.
 */
export interface PushResult {
    /** Position in the queue (0-indexed) */
    position: number
    /** Segment ID (echo back) */
    segmentId: string
}

/**
 * The current state of the playback worker for a session.
 */
export type PlaybackState = 'playing' | 'interrupted' | 'idle'

/**
 * Callback invoked when a segment is ready to be played.
 * In production this would trigger TTS + audio output.
 */
export type OnSegmentReady = (
    sessionId: string,
    segment: AudioSegment,
) => Promise<void>

// ── Interface ───────────────────────────────────────────────────────────────

/**
 * Service that manages ordered audio output queues per session.
 *
 * NOT an agent — this is a shared service used by InteractionAgent
 * and any agent that needs to output audio/speech.
 *
 * Features:
 * - Per-session FIFO queues with priority ordering
 * - Interrupt/continue/clear for barge-in handling
 * - Segment modification (e.g. replace filler with real response)
 * - Auto-interrupt on `bus:BARGE_IN` events
 * - Pluggable playback callback
 */
export interface IAudioQueueService {
    /** Push a segment to the session's audio queue */
    push(sessionId: string, segment: AudioSegment): Promise<PushResult>

    /** Interrupt playback for a session (pause output) */
    interrupt(sessionId: string): Promise<void>

    /** Resume playback after an interrupt */
    continue(sessionId: string): Promise<void>

    /** Clear all pending segments for a session */
    clear(sessionId: string): Promise<void>

    /** Replace a pending segment in the queue */
    modify(sessionId: string, segmentId: string, newSegment: AudioSegment): Promise<boolean>

    /** Get the current playback state for a session */
    getState(sessionId: string): PlaybackState

    /** Get all pending segments for a session (in order) */
    getPending(sessionId: string): AudioSegment[]

    /** Start listening for bus events (BARGE_IN auto-interrupt) */
    start(): Unsubscribe

    /** Stop and clean up all sessions */
    dispose(): void
}

// ── Dependencies ────────────────────────────────────────────────────────────

export interface AudioQueueServiceDeps {
    bus: IEventBus
    /** Called when a segment is dequeued and ready for playback */
    onSegmentReady: OnSegmentReady
}
