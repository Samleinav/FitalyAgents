import type { LLMStreamChunk } from 'fitalyagents'
import { BaseSessionBoundLLM, requireEnv } from './base.js'

export class AnthropicStreamingLLM extends BaseSessionBoundLLM {
  constructor(private readonly options: { model: string }) {
    super()
  }

  async *stream(params: {
    system: string
    messages: Array<{ role: 'user' | 'assistant' | 'tool'; content: string; tool_call_id?: string }>
    tools?: Array<{ name: string; description?: string; input_schema?: unknown }>
  }): AsyncIterable<LLMStreamChunk> {
    const response = await fetch('https://api.anthropic.com/v1/messages', {
      method: 'POST',
      headers: {
        'x-api-key': requireEnv('ANTHROPIC_API_KEY'),
        'anthropic-version': '2023-06-01',
        'content-type': 'application/json',
      },
      signal: this.getAbortSignal(),
      body: JSON.stringify({
        model: this.options.model,
        max_tokens: 1024,
        system: params.system,
        messages: params.messages.map((message) => ({
          role: message.role === 'assistant' ? 'assistant' : 'user',
          content: message.role === 'tool' ? `[Tool result] ${message.content}` : message.content,
        })),
        tools: params.tools?.map((tool) => ({
          name: tool.name,
          description: tool.description ?? '',
          input_schema:
            tool.input_schema && typeof tool.input_schema === 'object'
              ? tool.input_schema
              : { type: 'object', properties: {} },
        })),
      }),
    })

    if (!response.ok) {
      throw new Error(`Anthropic request failed: ${response.status} ${await response.text()}`)
    }

    const payload = (await response.json()) as {
      content?: Array<
        | {
            type: 'text'
            text: string
          }
        | {
            type: 'tool_use'
            id: string
            name: string
            input: unknown
          }
      >
      stop_reason?: 'end_turn' | 'tool_use' | 'max_tokens'
    }

    for (const block of payload.content ?? []) {
      if (block.type === 'text') {
        yield* this.yieldTextChunks(block.text)
        continue
      }

      yield {
        type: 'tool_call',
        id: block.id,
        name: block.name,
        input: block.input,
      }
    }

    yield {
      type: 'end',
      stop_reason: payload.stop_reason ?? 'end_turn',
    }
  }
}
