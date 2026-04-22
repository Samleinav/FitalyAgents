import type { ITTSProvider, TTSSynthesizeOptions } from './types.js'

export class ElevenLabsTTSProvider implements ITTSProvider {
  constructor(
    private readonly options: {
      voiceId: string
      model: string
      outputFormat: string
    },
  ) {}

  async *synthesize(text: string, options?: TTSSynthesizeOptions): AsyncIterable<Buffer> {
    const apiKey = process.env.ELEVENLABS_API_KEY
    if (!apiKey) {
      throw new Error('Missing required environment variable: ELEVENLABS_API_KEY')
    }

    const response = await fetch(
      `https://api.elevenlabs.io/v1/text-to-speech/${this.options.voiceId}/stream?output_format=${encodeURIComponent(this.options.outputFormat)}`,
      {
        method: 'POST',
        headers: {
          'xi-api-key': apiKey,
          'Content-Type': 'application/json',
        },
        signal: options?.signal,
        body: JSON.stringify({
          text,
          model_id: this.options.model,
          optimize_streaming_latency: 3,
          voice_settings: {
            stability: 0.5,
            similarity_boost: 0.8,
          },
        }),
      },
    )

    if (!response.ok || !response.body) {
      throw new Error(`ElevenLabs request failed: ${response.status} ${await response.text()}`)
    }

    const reader = response.body.getReader()

    while (true) {
      const { done, value } = await reader.read()
      if (done) {
        break
      }

      if (options?.signal?.aborted) {
        break
      }

      yield Buffer.from(value.buffer, value.byteOffset, value.byteLength)
    }
  }

  dispose(): void {}
}
