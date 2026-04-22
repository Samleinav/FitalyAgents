import { describe, expect, it } from 'vitest'
import { describeTTSOutputFormat } from './types.js'

describe('describeTTSOutputFormat', () => {
  it('marks piper PCM as browser-playable raw audio', () => {
    expect(
      describeTTSOutputFormat({ driver: 'piper', voice: 'voice-demo' }, { sampleRate: 16000 }),
    ).toEqual({
      encoding: 'pcm_s16le',
      mimeType: 'audio/raw',
      sampleRate: 16000,
      channels: 1,
      browserPlayable: true,
    })
  })

  it('describes elevenlabs mp3 output as browser-playable', () => {
    expect(
      describeTTSOutputFormat({
        driver: 'elevenlabs',
        voice_id: 'voice-demo',
        model: 'eleven_flash_v2_5',
        output_format: 'mp3_44100_128',
      }),
    ).toEqual({
      encoding: 'mp3',
      mimeType: 'audio/mpeg',
      sampleRate: 44100,
      channels: 1,
      browserPlayable: true,
    })
  })

  it('describes elevenlabs pcm output as raw browser-playable audio', () => {
    expect(
      describeTTSOutputFormat({
        driver: 'elevenlabs',
        voice_id: 'voice-demo',
        model: 'eleven_flash_v2_5',
        output_format: 'pcm_16000',
      }),
    ).toEqual({
      encoding: 'pcm_s16le',
      mimeType: 'audio/raw',
      sampleRate: 16000,
      channels: 1,
      browserPlayable: true,
    })
  })
})
