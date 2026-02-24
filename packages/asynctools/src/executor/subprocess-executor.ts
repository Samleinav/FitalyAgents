import { spawn } from 'node:child_process'
import type { IExecutor } from './types.js'
import type { SubprocessExecutorConfig } from '../types/index.js'

/**
 * Executes tools by spawning a child process.
 *
 * Sends JSON input via stdin and reads JSON output from stdout.
 * Supports AbortSignal for timeout/cancellation via process kill.
 */
export class SubprocessExecutor implements IExecutor {
  async execute(toolId: string, input: unknown, signal?: AbortSignal): Promise<unknown> {
    const config = (input as { __executor_config: SubprocessExecutorConfig }).__executor_config
    const payload = (input as { __payload: unknown }).__payload

    return new Promise<unknown>((resolve, reject) => {
      const proc = spawn(config.command, config.args ?? [], {
        cwd: config.cwd,
        env: config.env ? { ...process.env, ...config.env } : process.env,
        stdio: ['pipe', 'pipe', 'pipe'],
      })

      let stdout = ''
      let stderr = ''

      proc.stdout.on('data', (chunk: Buffer) => {
        stdout += chunk.toString()
      })

      proc.stderr.on('data', (chunk: Buffer) => {
        stderr += chunk.toString()
      })

      proc.on('close', (code) => {
        if (code !== 0) {
          reject(new Error(`Subprocess "${toolId}" exited with code ${code}: ${stderr}`))
          return
        }

        try {
          resolve(JSON.parse(stdout))
        } catch {
          // If stdout is not JSON, return raw string
          resolve(stdout.trim())
        }
      })

      proc.on('error', (err) => {
        reject(new Error(`Subprocess "${toolId}" failed to start: ${err.message}`))
      })

      // Handle abort signal
      if (signal) {
        const onAbort = () => {
          proc.kill('SIGTERM')
          reject(new Error(`Subprocess "${toolId}" aborted`))
        }
        if (signal.aborted) {
          proc.kill('SIGTERM')
          reject(new Error(`Subprocess "${toolId}" aborted`))
          return
        }
        signal.addEventListener('abort', onAbort, { once: true })
        proc.on('close', () => signal.removeEventListener('abort', onAbort))
      }

      // Send input via stdin
      if (payload !== undefined) {
        proc.stdin.write(JSON.stringify(payload))
      }
      proc.stdin.end()
    })
  }
}
