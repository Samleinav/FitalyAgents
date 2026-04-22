import type { StoreConfig } from '../../config/schema.js'
import { ElevenLabsTTSProvider } from './elevenlabs.js'
import { MockTTSProvider } from './mock.js'
import { PiperTTSProvider } from './piper.js'

export interface ITTSProvider {
  synthesize(text: string, options?: TTSSynthesizeOptions): AsyncIterable<Buffer>
  dispose(): void
}

export interface TTSSynthesizeOptions {
  voice?: string
  language?: string
  speed?: number
  signal?: AbortSignal
}

export interface TTSAudioFormat {
  encoding: 'mock_text' | 'pcm_s16le' | 'mp3' | 'wav' | 'opus' | 'binary'
  mimeType: string
  sampleRate: number | null
  channels: number
  browserPlayable: boolean
}

export function createTTSProvider(config: StoreConfig['providers']['tts']): ITTSProvider {
  switch (config.driver) {
    case 'mock':
      return new MockTTSProvider()
    case 'elevenlabs':
      return new ElevenLabsTTSProvider({
        voiceId: config.voice_id,
        model: config.model,
        outputFormat: config.output_format,
      })
    case 'piper':
      return new PiperTTSProvider({
        voice: config.voice,
        modelPath: config.model_path,
      })
    case 'openai-tts':
      throw new Error('openai-tts adapter is not implemented in Phase 1')
  }
}

export function describeTTSOutputFormat(
  config: StoreConfig['providers']['tts'],
  options?: { sampleRate?: number },
): TTSAudioFormat {
  switch (config.driver) {
    case 'mock':
      return {
        encoding: 'mock_text',
        mimeType: 'text/plain; charset=utf-8',
        sampleRate: null,
        channels: 1,
        browserPlayable: false,
      }
    case 'piper':
      return {
        encoding: 'pcm_s16le',
        mimeType: 'audio/raw',
        sampleRate: options?.sampleRate ?? 16000,
        channels: 1,
        browserPlayable: true,
      }
    case 'elevenlabs':
      return describeElevenLabsOutputFormat(config.output_format)
    case 'openai-tts':
      return {
        encoding: 'binary',
        mimeType: 'application/octet-stream',
        sampleRate: null,
        channels: 1,
        browserPlayable: false,
      }
  }
}

function describeElevenLabsOutputFormat(outputFormat: string): TTSAudioFormat {
  const parts = outputFormat.split('_').filter(Boolean)
  const codec = parts[0]?.toLowerCase() ?? 'binary'
  const sampleRateToken = parts.find((part, index) => index > 0 && /^\d+$/.test(part))
  const sampleRate = sampleRateToken ? Number(sampleRateToken) : null

  switch (codec) {
    case 'mp3':
      return {
        encoding: 'mp3',
        mimeType: 'audio/mpeg',
        sampleRate,
        channels: 1,
        browserPlayable: true,
      }
    case 'wav':
      return {
        encoding: 'wav',
        mimeType: 'audio/wav',
        sampleRate,
        channels: 1,
        browserPlayable: true,
      }
    case 'pcm':
      return {
        encoding: 'pcm_s16le',
        mimeType: 'audio/raw',
        sampleRate,
        channels: 1,
        browserPlayable: true,
      }
    case 'opus':
      return {
        encoding: 'opus',
        mimeType: 'audio/ogg; codecs=opus',
        sampleRate,
        channels: 1,
        browserPlayable: true,
      }
    default:
      return {
        encoding: 'binary',
        mimeType: 'application/octet-stream',
        sampleRate,
        channels: 1,
        browserPlayable: false,
      }
  }
}
