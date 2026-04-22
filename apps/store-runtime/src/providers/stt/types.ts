import type { StoreConfig } from '../../config/schema.js'
import { MockSTTProvider } from './mock.js'
import { VoskWebSocketSTTProvider } from './vosk.js'

export interface STTTranscriptChunk {
  type: 'partial' | 'final'
  text: string
  confidence?: number
  timestamp: number
}

export interface IStreamingSTTProvider {
  transcribe(audioStream: AsyncIterable<Buffer>): AsyncIterable<STTTranscriptChunk>
  startSession(
    onChunk: (chunk: STTTranscriptChunk) => void,
    onError?: (error: Error) => void,
  ): Promise<STTSession>
  dispose(): void
}

export interface STTSession {
  push(audio: Buffer): void
  end(): void
  close(): void
}

export function createSTTProvider(config: StoreConfig['providers']['stt']): IStreamingSTTProvider {
  switch (config.driver) {
    case 'vosk':
      return new VoskWebSocketSTTProvider({
        url: config.url,
        language: config.language,
        sampleRate: config.sample_rate,
      })
    case 'mock':
      return new MockSTTProvider()
    case 'sherpa-onnx':
      throw new Error('sherpa-onnx adapter is not implemented in Phase 1')
  }
}
