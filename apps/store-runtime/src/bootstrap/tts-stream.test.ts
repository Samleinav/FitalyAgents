import { readFile } from 'node:fs/promises'
import path from 'node:path'
import { describe, expect, it } from 'vitest'
import { InMemoryBus } from 'fitalyagents'
import { TtsStreamService } from './tts-stream.js'
import type { ITTSProvider, TTSSynthesizeOptions } from '../providers/tts/types.js'
import { cleanupTempDir, createTempDir } from '../../test/helpers.js'

class FixtureTTSProvider implements ITTSProvider {
  constructor(private readonly chunks: Buffer[]) {}

  async *synthesize(_text: string, _options?: TTSSynthesizeOptions): AsyncIterable<Buffer> {
    for (const chunk of this.chunks) {
      yield chunk
    }
  }

  dispose(): void {}
}

describe('TtsStreamService', () => {
  it('writes local audio and publishes browser-facing TTS events', async () => {
    const dir = await createTempDir('tts-stream-')
    const outputPath = path.join(dir, 'audio.bin')
    const bus = new InMemoryBus()
    const segmentStarts: Array<Record<string, unknown>> = []
    const audioChunks: Array<Record<string, unknown>> = []
    const segmentEnds: Array<Record<string, unknown>> = []

    bus.subscribe('bus:TTS_SEGMENT_START', (payload) => {
      segmentStarts.push(payload as Record<string, unknown>)
    })
    bus.subscribe('bus:TTS_AUDIO_CHUNK', (payload) => {
      audioChunks.push(payload as Record<string, unknown>)
    })
    bus.subscribe('bus:TTS_SEGMENT_END', (payload) => {
      segmentEnds.push(payload as Record<string, unknown>)
    })

    const service = new TtsStreamService({
      bus,
      tts: new FixtureTTSProvider([Buffer.from([1, 2]), Buffer.from([3, 4, 5])]),
      audioFormat: {
        encoding: 'pcm_s16le',
        mimeType: 'audio/raw',
        sampleRate: 16000,
        channels: 1,
        browserPlayable: true,
      },
      outputPath,
    })
    service.start()

    try {
      await service.speakText('session-1', 'Hola mundo.', 5)
      await waitForCondition(() => segmentEnds.length === 1)

      const bytes = await readFile(outputPath)
      expect([...bytes]).toEqual([1, 2, 3, 4, 5])

      expect(segmentStarts[0]).toMatchObject({
        event: 'TTS_SEGMENT_START',
        session_id: 'session-1',
        encoding: 'pcm_s16le',
        browser_playable: true,
      })
      expect(audioChunks).toHaveLength(2)
      expect(audioChunks[0]).toMatchObject({
        event: 'TTS_AUDIO_CHUNK',
        session_id: 'session-1',
        chunk_index: 1,
      })
      expect(audioChunks[1]).toMatchObject({
        chunk_index: 2,
      })
      expect(segmentEnds[0]).toMatchObject({
        event: 'TTS_SEGMENT_END',
        session_id: 'session-1',
        reason: 'completed',
        chunk_count: 2,
        total_bytes: 5,
      })
    } finally {
      service.dispose()
      await cleanupTempDir(dir)
    }
  })
})

async function waitForCondition(condition: () => boolean, timeoutMs = 1_000): Promise<void> {
  const startedAt = Date.now()

  while (!condition()) {
    if (Date.now() - startedAt > timeoutMs) {
      throw new Error('Timed out waiting for condition')
    }

    await new Promise((resolve) => setTimeout(resolve, 20))
  }
}
