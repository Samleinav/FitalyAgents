import { z } from 'zod'

export interface ChatMessage {
  role: 'system' | 'user' | 'assistant' | 'tool'
  content: string | null
  name?: string
  tool_calls?: any[]
  tool_call_id?: string
}

interface OpenRouterOptions {
  model?: string
  temperature?: number
}

export class OpenRouterProvider {
  private apiKey: string
  private model: string
  private temperature: number

  constructor(options: OpenRouterOptions = {}) {
    this.apiKey =
      process.env.OPENROUTER_API_KEY ||
      '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'
    if (!this.apiKey) {
      console.warn('⚠️ OPENROUTER_API_KEY is not set in environment variables! API calls may fail.')
    }

    this.model = options.model || process.env.OPENROUTER_MODEL || 'openai/gpt-5.2'
    this.temperature = options.temperature ?? 0.2
  }

  async chat(messages: ChatMessage[], tools?: any[], model?: string): Promise<any> {
    const start = performance.now()
    try {
      const response = await fetch('https://openrouter.ai/api/v1/chat/completions', {
        method: 'POST',
        headers: {
          Authorization: `Bearer ${this.apiKey}`,
          'Content-Type': 'application/json',
          'HTTP-Referer': 'http://localhost:3000',
          'X-Title': 'FitalyAgents E2E Comparison',
        },
        body: JSON.stringify({
          model: model ?? this.model,
          messages,
          tools,
          temperature: this.temperature,
          tool_choice: tools?.length ? 'auto' : undefined,
        }),
      })

      if (!response.ok) {
        const errorText = await response.text()
        throw new Error(`OpenRouter API error: ${response.status} - ${errorText}`)
      }

      const data: any = (await response.json()) ?? {}
      const end = performance.now()

      return {
        response: data?.choices?.[0]?.message,
        latencyMs: Math.round(end - start),
      }
    } catch (error) {
      console.error('OpenRouter Chat Error:', error)
      throw error
    }
  }

  /**
   * Streams a chat completion token-by-token using SSE.
   * Uses a fast/cheap model suitable for short filler responses.
   * @param messages - The conversation messages
   * @param onToken - Called with each text token as it arrives
   * @param model - Override the model (defaults to gpt-4o-mini for speed)
   */
  async streamChat(
    messages: ChatMessage[],
    onToken: (token: string) => void,
    model = 'openai/gpt-4o-mini',
  ): Promise<void> {
    const response = await fetch('https://openrouter.ai/api/v1/chat/completions', {
      method: 'POST',
      headers: {
        Authorization: `Bearer ${this.apiKey}`,
        'Content-Type': 'application/json',
        'HTTP-Referer': 'http://localhost:3000',
        'X-Title': 'FitalyAgents E2E Comparison',
      },
      body: JSON.stringify({
        model,
        messages,
        stream: true,
        temperature: 0.3,
        max_tokens: 30, // filler is always a short sentence
      }),
    })

    if (!response.ok || !response.body) {
      // Filler failure is non-fatal — swallow silently
      return
    }

    const reader = response.body.getReader()
    const decoder = new TextDecoder()
    let buffer = ''

    while (true) {
      const { done, value } = await reader.read()
      if (done) break

      buffer += decoder.decode(value, { stream: true })
      const lines = buffer.split('\n')
      buffer = lines.pop() ?? ''

      for (const line of lines) {
        const trimmed = line.trim()
        if (!trimmed.startsWith('data: ')) continue
        const data = trimmed.slice(6)
        if (data === '[DONE]') return
        try {
          const parsed = JSON.parse(data)
          const token: string | undefined = parsed.choices?.[0]?.delta?.content
          if (token) onToken(token)
        } catch {
          // malformed SSE chunk — skip
        }
      }
    }
  }
}
