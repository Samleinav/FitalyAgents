import type { ITTSProvider, TTSSynthesizeOptions } from './types.js'

export class MockTTSProvider implements ITTSProvider {
  async *synthesize(text: string, _options?: TTSSynthesizeOptions): AsyncIterable<Buffer> {
    if (!text.trim()) {
      return
    }

    yield Buffer.from(`[mock-tts] ${text}\n`, 'utf8')
  }

  dispose(): void {}
}
