import type { IStreamingSTTProvider, STTSession, STTTranscriptChunk } from './types.js'

export class MockSTTProvider implements IStreamingSTTProvider {
  async *transcribe(audioStream: AsyncIterable<Buffer>): AsyncIterable<STTTranscriptChunk> {
    let text = ''

    for await (const chunk of audioStream) {
      text += chunk.toString('utf8')
    }

    const normalized = text.trim()
    if (!normalized) {
      return
    }

    yield {
      type: 'partial',
      text: normalized,
      confidence: 1,
      timestamp: Date.now(),
    }

    yield {
      type: 'final',
      text: normalized,
      confidence: 1,
      timestamp: Date.now(),
    }
  }

  async startSession(
    onChunk: (chunk: STTTranscriptChunk) => void,
    onError?: (error: Error) => void,
  ): Promise<STTSession> {
    let buffer = ''
    let closed = false

    const emit = (text: string) => {
      const normalized = text.trim()
      if (!normalized) {
        return
      }

      onChunk({
        type: 'partial',
        text: normalized,
        confidence: 1,
        timestamp: Date.now(),
      })

      onChunk({
        type: 'final',
        text: normalized,
        confidence: 1,
        timestamp: Date.now(),
      })
    }

    return {
      push(audio: Buffer) {
        if (closed) {
          onError?.(new Error('Cannot push into a closed mock STT session'))
          return
        }

        buffer += audio.toString('utf8')
        const parts = buffer.split(/\r?\n/)
        buffer = parts.pop() ?? ''

        for (const part of parts) {
          emit(part)
        }
      },
      end() {
        if (closed) {
          return
        }

        emit(buffer)
        buffer = ''
      },
      close() {
        closed = true
      },
    }
  }

  dispose(): void {}
}
