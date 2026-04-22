import WebSocket from 'ws'
import type { IStreamingSTTProvider, STTSession, STTTranscriptChunk } from './types.js'

export class VoskWebSocketSTTProvider implements IStreamingSTTProvider {
  private readonly sockets = new Set<WebSocket>()

  constructor(
    private readonly options: {
      url: string
      language: string
      sampleRate: number
    },
  ) {}

  async *transcribe(audioStream: AsyncIterable<Buffer>): AsyncIterable<STTTranscriptChunk> {
    const chunks: STTTranscriptChunk[] = []
    const errors: Error[] = []
    const session = await this.startSession(
      (chunk) => {
        chunks.push(chunk)
      },
      (error) => {
        errors.push(error)
      },
    )

    for await (const chunk of audioStream) {
      session.push(chunk)
    }

    session.end()
    session.close()

    if (errors.length > 0) {
      throw errors[0]
    }

    for (const chunk of chunks) {
      yield chunk
    }
  }

  async startSession(
    onChunk: (chunk: STTTranscriptChunk) => void,
    onError?: (error: Error) => void,
  ): Promise<STTSession> {
    const socket = new WebSocket(this.options.url)
    this.sockets.add(socket)

    const pendingAudio: Buffer[] = []
    let isOpen = false
    let isClosed = false

    const ready = new Promise<void>((resolve, reject) => {
      socket.once('open', () => {
        isOpen = true
        socket.send(
          JSON.stringify({
            config: {
              sample_rate: this.options.sampleRate,
              lang: this.options.language,
            },
          }),
        )

        for (const chunk of pendingAudio.splice(0)) {
          socket.send(chunk)
        }

        resolve()
      })

      socket.once('error', (error) => {
        reject(error)
      })
    })

    socket.on('message', (data) => {
      try {
        const message = JSON.parse(data.toString()) as {
          partial?: string
          text?: string
          result?: Array<{ conf?: number }>
        }

        if (typeof message.partial === 'string' && message.partial.trim()) {
          onChunk({
            type: 'partial',
            text: message.partial.trim(),
            timestamp: Date.now(),
          })
          return
        }

        if (typeof message.text === 'string' && message.text.trim()) {
          const confidence = average(
            (message.result ?? [])
              .map((entry) => (typeof entry.conf === 'number' ? entry.conf : null))
              .filter((value): value is number => value != null),
          )

          onChunk({
            type: 'final',
            text: message.text.trim(),
            confidence,
            timestamp: Date.now(),
          })
        }
      } catch (error) {
        onError?.(error instanceof Error ? error : new Error(String(error)))
      }
    })

    socket.on('error', (error) => {
      onError?.(error instanceof Error ? error : new Error(String(error)))
    })

    socket.on('close', () => {
      isClosed = true
      this.sockets.delete(socket)
    })

    try {
      await ready
    } catch (error) {
      onError?.(error instanceof Error ? error : new Error(String(error)))
    }

    return {
      push: (audio: Buffer) => {
        if (isClosed) {
          return
        }

        if (!isOpen) {
          pendingAudio.push(audio)
          return
        }

        socket.send(audio)
      },
      end: () => {
        if (!isClosed && isOpen) {
          socket.send(JSON.stringify({ eof: 1 }))
        }
      },
      close: () => {
        if (!isClosed) {
          socket.close()
        }
      },
    }
  }

  dispose(): void {
    for (const socket of this.sockets) {
      socket.close()
    }
    this.sockets.clear()
  }
}

function average(values: number[]): number | undefined {
  if (values.length === 0) {
    return undefined
  }

  return values.reduce((sum, value) => sum + value, 0) / values.length
}
