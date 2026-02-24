import type { IExecutor } from './types.js'
import type { HttpExecutorConfig } from '../types/index.js'
import { HttpExecutorError } from '../errors.js'

/**
 * Executes tools via HTTP requests using native `fetch()` (Node 18+).
 *
 * Supports GET, POST, PUT methods with JSON serialization,
 * custom headers, and AbortSignal for timeout/cancellation.
 */
export class HttpExecutor implements IExecutor {
  async execute(toolId: string, input: unknown, signal?: AbortSignal): Promise<unknown> {
    // The config is passed as part of the input context
    const config = (input as { __executor_config: HttpExecutorConfig }).__executor_config
    const payload = (input as { __payload: unknown }).__payload

    const method = config.method ?? 'POST'
    const headers: Record<string, string> = {
      'Content-Type': 'application/json',
      ...config.headers,
    }

    const fetchOptions: RequestInit = {
      method,
      headers,
      signal: signal as globalThis.AbortSignal | undefined,
    }

    if (method !== 'GET' && payload !== undefined) {
      fetchOptions.body = JSON.stringify(payload)
    }

    const response = await fetch(config.url, fetchOptions)

    if (!response.ok) {
      const body = await response.text()
      throw new HttpExecutorError(response.status, body, config.url)
    }

    const contentType = response.headers.get('content-type') ?? ''
    if (contentType.includes('application/json')) {
      return response.json()
    }
    return response.text()
  }
}
