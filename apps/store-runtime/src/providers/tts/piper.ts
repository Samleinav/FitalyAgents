import { spawn } from 'node:child_process'
import type { ITTSProvider, TTSSynthesizeOptions } from './types.js'

export class PiperTTSProvider implements ITTSProvider {
  constructor(
    private readonly options: {
      voice: string
      modelPath?: string
    },
  ) {}

  async *synthesize(text: string, options?: TTSSynthesizeOptions): AsyncIterable<Buffer> {
    const model = this.options.modelPath ?? this.options.voice
    const child = spawn('piper', ['--model', model, '--output-raw'], {
      stdio: ['pipe', 'pipe', 'pipe'],
    })

    options?.signal?.addEventListener(
      'abort',
      () => {
        child.kill('SIGTERM')
      },
      { once: true },
    )

    child.stdin.write(text)
    child.stdin.end()

    for await (const chunk of child.stdout) {
      if (options?.signal?.aborted) {
        break
      }
      yield Buffer.from(chunk)
    }

    const exitCode = await new Promise<number>((resolve, reject) => {
      child.once('error', reject)
      child.once('close', (code) => resolve(code ?? 0))
    })

    if (exitCode !== 0 && !options?.signal?.aborted) {
      throw new Error(`Piper exited with code ${exitCode}`)
    }
  }

  dispose(): void {}
}
