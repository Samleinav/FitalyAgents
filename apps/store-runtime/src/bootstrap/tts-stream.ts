import { InMemoryAudioQueueService, type AudioSegment, type IEventBus } from 'fitalyagents'
import type { ITTSProvider, TTSAudioFormat } from '../providers/tts/types.js'
import { SentenceChunker } from './sentence-chunker.js'
import {
  BusTtsAudioSink,
  CompositeTtsAudioSink,
  type TtsAudioSegmentEnd,
  type TtsAudioSegmentMeta,
  WritableTtsAudioSink,
} from './tts-audio-sink.js'

export class TtsStreamService {
  private readonly chunker = new SentenceChunker()
  private readonly audioQueue: InMemoryAudioQueueService
  private readonly audioSink: CompositeTtsAudioSink
  private readonly unsubs: Array<() => void> = []
  private readonly abortControllers = new Map<string, AbortController>()
  private segmentCounter = 0

  constructor(
    private readonly deps: {
      bus: IEventBus
      tts: ITTSProvider
      audioFormat: TTSAudioFormat
      outputPath?: string
    },
  ) {
    this.audioSink = new CompositeTtsAudioSink([
      new WritableTtsAudioSink(deps.outputPath),
      new BusTtsAudioSink(deps.bus),
    ])

    this.audioQueue = new InMemoryAudioQueueService({
      bus: deps.bus,
      onSegmentReady: (sessionId, segment) => this.playSegment(sessionId, segment),
    })
  }

  start(): void {
    this.unsubs.push(this.audioQueue.start())

    this.unsubs.push(
      this.deps.bus.subscribe('bus:RESPONSE_END', (payload) => {
        const event = payload as { session_id?: string }
        if (event.session_id) {
          void this.flushSession(event.session_id)
        }
      }),
    )

    this.unsubs.push(
      this.deps.bus.subscribe('bus:BARGE_IN', (payload) => {
        const event = payload as { session_id?: string }
        if (event.session_id) {
          void this.handleBargeIn(event.session_id)
        }
      }),
    )

    this.unsubs.push(
      this.deps.bus.subscribe('bus:APPROVAL_VOICE_REQUEST', (payload) => {
        const event = payload as { request_id?: string; prompt_text?: string }
        if (event.request_id && event.prompt_text) {
          void this.speakText(`approval:${event.request_id}`, event.prompt_text, 10)
        }
      }),
    )
  }

  async handleTextChunk(sessionId: string, text: string): Promise<void> {
    const sentences = this.chunker.push(sessionId, text)
    for (const sentence of sentences) {
      await this.speakText(sessionId, sentence, 5)
    }
  }

  async speakText(sessionId: string, text: string, priority = 5): Promise<void> {
    const normalized = text.trim()
    if (!normalized) {
      return
    }

    if (this.audioQueue.getState(sessionId) === 'interrupted') {
      await this.audioQueue.continue(sessionId)
    }

    this.segmentCounter += 1
    await this.audioQueue.push(sessionId, {
      segmentId: `segment_${Date.now()}_${this.segmentCounter}`,
      text: normalized,
      priority,
    })
  }

  isSessionBusy(sessionId: string): boolean {
    return (
      this.audioQueue.getState(sessionId) !== 'idle' ||
      this.audioQueue.getPending(sessionId).length > 0
    )
  }

  async flushSession(sessionId: string): Promise<void> {
    const remainder = this.chunker.flush(sessionId)
    if (remainder) {
      await this.speakText(sessionId, remainder, 5)
    }
  }

  dispose(): void {
    for (const unsub of this.unsubs) {
      unsub()
    }
    this.unsubs.length = 0

    for (const controller of this.abortControllers.values()) {
      controller.abort()
    }
    this.abortControllers.clear()

    this.audioQueue.dispose()
    this.audioSink.dispose()
    this.deps.tts.dispose()
  }

  private async handleBargeIn(sessionId: string): Promise<void> {
    this.chunker.reset(sessionId)
    this.abortControllers.get(sessionId)?.abort()
    await this.audioQueue.clear(sessionId)
  }

  private async playSegment(sessionId: string, segment: AudioSegment): Promise<void> {
    const controller = new AbortController()
    this.abortControllers.set(sessionId, controller)
    const meta: TtsAudioSegmentMeta = {
      sessionId,
      segmentId: segment.segmentId,
      text: segment.text,
      audioFormat: this.deps.audioFormat,
    }
    let chunkCount = 0
    let totalBytes = 0
    let endState: TtsAudioSegmentEnd = {
      reason: 'completed',
      chunkCount: 0,
      totalBytes: 0,
    }

    try {
      await this.audioSink.startSegment(meta)

      for await (const chunk of this.deps.tts.synthesize(segment.text, {
        signal: controller.signal,
      })) {
        if (controller.signal.aborted) {
          endState = {
            reason: 'interrupted',
            chunkCount,
            totalBytes,
          }
          break
        }

        chunkCount += 1
        totalBytes += chunk.length
        await this.audioSink.writeChunk(meta, chunk, chunkCount)
      }

      if (controller.signal.aborted) {
        endState = {
          reason: 'interrupted',
          chunkCount,
          totalBytes,
        }
      } else {
        endState = {
          reason: 'completed',
          chunkCount,
          totalBytes,
        }
      }
    } catch (error) {
      endState = {
        reason: 'error',
        chunkCount,
        totalBytes,
        errorMessage: error instanceof Error ? error.message : String(error),
      }
      console.error(
        '[store-runtime] TTS segment failed:',
        error instanceof Error ? error.message : error,
      )
    } finally {
      await this.audioSink.endSegment(meta, endState).catch(() => {})
      if (this.abortControllers.get(sessionId) === controller) {
        this.abortControllers.delete(sessionId)
      }
    }
  }
}
