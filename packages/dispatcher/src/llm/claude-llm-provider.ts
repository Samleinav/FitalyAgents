import type { LLMProvider } from './types.js'

// Ambient declaration (available in Node.js but not in ES2022 lib)
declare const process: { env: Record<string, string | undefined> }

/** Default model — fast and cost-efficient for classification and generation tasks */
const DEFAULT_MODEL = 'claude-haiku-4-5-20251001'
const DEFAULT_MAX_TOKENS = 1024

/**
 * LLMProvider implementation backed by Claude (Anthropic API).
 *
 * Uses `claude-haiku-4-5-20251001` by default — the fastest and most
 * cost-efficient model for intent classification and example generation.
 *
 * Requires `@anthropic-ai/sdk` to be installed:
 * ```bash
 * npm install @anthropic-ai/sdk
 * ```
 *
 * @example
 * ```typescript
 * import { ClaudeLLMProvider } from 'fitalyagents/dispatcher'
 *
 * const llm = new ClaudeLLMProvider({
 *   apiKey: process.env.ANTHROPIC_API_KEY,
 * })
 *
 * const response = await llm.complete(
 *   'You are a helpful assistant.',
 *   'What is 2 + 2?',
 * )
 * ```
 */
export class ClaudeLLMProvider implements LLMProvider {
  private readonly apiKey: string
  private readonly model: string
  private readonly maxTokens: number

  constructor(options?: {
    /** Anthropic API key. Defaults to ANTHROPIC_API_KEY env var. */
    apiKey?: string
    /** Model ID. Defaults to 'claude-haiku-4-5-20251001'. */
    model?: string
    /** Max output tokens. Default: 1024. */
    maxTokens?: number
  }) {
    const key = options?.apiKey ?? process.env['ANTHROPIC_API_KEY'] ?? ''
    if (!key) {
      throw new Error(
        'ClaudeLLMProvider: No API key provided. ' +
          'Pass apiKey or set ANTHROPIC_API_KEY environment variable.',
      )
    }
    this.apiKey = key
    this.model = options?.model ?? DEFAULT_MODEL
    this.maxTokens = options?.maxTokens ?? DEFAULT_MAX_TOKENS
  }

  async complete(system: string, user: string): Promise<string> {
    // Dynamic import — avoids hard dependency at module load time

    const { default: Anthropic } = await import('@anthropic-ai/sdk')

    const client = new Anthropic({ apiKey: this.apiKey })

    const message = await client.messages.create({
      model: this.model,
      max_tokens: this.maxTokens,
      system,
      messages: [{ role: 'user', content: user }],
    })

    const block = message.content[0]
    if (!block || block.type !== 'text') {
      throw new Error('ClaudeLLMProvider: unexpected response shape from API')
    }

    return block.text
  }
}
