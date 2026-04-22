import fs from 'node:fs'
import type { Writable } from 'node:stream'
import type { IEventBus } from 'fitalyagents'
import type { TTSAudioFormat } from '../providers/tts/types.js'

export interface TtsAudioSegmentMeta {
  sessionId: string
  segmentId: string
  text: string
  audioFormat: TTSAudioFormat
}

export interface TtsAudioSegmentEnd {
  reason: 'completed' | 'interrupted' | 'error'
  chunkCount: number
  totalBytes: number
  errorMessage?: string
}

export interface TtsAudioSink {
  startSegment(meta: TtsAudioSegmentMeta): Promise<void>
  writeChunk(meta: TtsAudioSegmentMeta, chunk: Buffer, chunkIndex: number): Promise<void>
  endSegment(meta: TtsAudioSegmentMeta, result: TtsAudioSegmentEnd): Promise<void>
  dispose(): void
}

export class CompositeTtsAudioSink implements TtsAudioSink {
  constructor(private readonly sinks: TtsAudioSink[]) {}

  async startSegment(meta: TtsAudioSegmentMeta): Promise<void> {
    await Promise.all(this.sinks.map((sink) => sink.startSegment(meta)))
  }

  async writeChunk(meta: TtsAudioSegmentMeta, chunk: Buffer, chunkIndex: number): Promise<void> {
    await Promise.all(this.sinks.map((sink) => sink.writeChunk(meta, chunk, chunkIndex)))
  }

  async endSegment(meta: TtsAudioSegmentMeta, result: TtsAudioSegmentEnd): Promise<void> {
    await Promise.all(this.sinks.map((sink) => sink.endSegment(meta, result)))
  }

  dispose(): void {
    for (const sink of this.sinks) {
      sink.dispose()
    }
  }
}

export class WritableTtsAudioSink implements TtsAudioSink {
  private readonly output: Writable

  constructor(outputPath?: string) {
    this.output = outputPath ? fs.createWriteStream(outputPath, { flags: 'a' }) : process.stdout
  }

  async startSegment(_meta: TtsAudioSegmentMeta): Promise<void> {}

  async writeChunk(_meta: TtsAudioSegmentMeta, chunk: Buffer): Promise<void> {
    await writeChunk(this.output, chunk)
  }

  async endSegment(_meta: TtsAudioSegmentMeta, _result: TtsAudioSegmentEnd): Promise<void> {}

  dispose(): void {
    if (this.output !== process.stdout) {
      this.output.end()
    }
  }
}

export class BusTtsAudioSink implements TtsAudioSink {
  constructor(private readonly bus: IEventBus) {}

  async startSegment(meta: TtsAudioSegmentMeta): Promise<void> {
    await this.bus.publish('bus:TTS_SEGMENT_START', {
      event: 'TTS_SEGMENT_START',
      session_id: meta.sessionId,
      segment_id: meta.segmentId,
      text: meta.text,
      encoding: meta.audioFormat.encoding,
      mime_type: meta.audioFormat.mimeType,
      sample_rate: meta.audioFormat.sampleRate,
      channels: meta.audioFormat.channels,
      browser_playable: meta.audioFormat.browserPlayable,
      timestamp: Date.now(),
    })
  }

  async writeChunk(meta: TtsAudioSegmentMeta, chunk: Buffer, chunkIndex: number): Promise<void> {
    await this.bus.publish('bus:TTS_AUDIO_CHUNK', {
      event: 'TTS_AUDIO_CHUNK',
      session_id: meta.sessionId,
      segment_id: meta.segmentId,
      chunk_index: chunkIndex,
      chunk_base64: chunk.toString('base64'),
      encoding: meta.audioFormat.encoding,
      mime_type: meta.audioFormat.mimeType,
      sample_rate: meta.audioFormat.sampleRate,
      channels: meta.audioFormat.channels,
      browser_playable: meta.audioFormat.browserPlayable,
      timestamp: Date.now(),
    })
  }

  async endSegment(meta: TtsAudioSegmentMeta, result: TtsAudioSegmentEnd): Promise<void> {
    await this.bus.publish('bus:TTS_SEGMENT_END', {
      event: 'TTS_SEGMENT_END',
      session_id: meta.sessionId,
      segment_id: meta.segmentId,
      reason: result.reason,
      chunk_count: result.chunkCount,
      total_bytes: result.totalBytes,
      error_message: result.errorMessage,
      encoding: meta.audioFormat.encoding,
      mime_type: meta.audioFormat.mimeType,
      sample_rate: meta.audioFormat.sampleRate,
      channels: meta.audioFormat.channels,
      browser_playable: meta.audioFormat.browserPlayable,
      timestamp: Date.now(),
    })
  }

  dispose(): void {}
}

async function writeChunk(output: Writable, chunk: Buffer): Promise<void> {
  if (output.write(chunk)) {
    return
  }

  await new Promise<void>((resolve) => {
    output.once('drain', () => resolve())
  })
}
