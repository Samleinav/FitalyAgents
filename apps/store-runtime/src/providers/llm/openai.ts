import type { LLMStreamChunk } from 'fitalyagents'
import {
  BaseSessionBoundLLM,
  flattenResponseText,
  requireEnv,
  toOpenAICompatibleMessages,
  toOpenAICompatibleTools,
} from './base.js'

export class OpenAIStreamingLLM extends BaseSessionBoundLLM {
  constructor(private readonly options: { model: string }) {
    super()
  }

  async *stream(params: {
    system: string
    messages: Array<{ role: 'user' | 'assistant' | 'tool'; content: string; tool_call_id?: string }>
    tools?: Array<{ name: string; description?: string; input_schema?: unknown }>
  }): AsyncIterable<LLMStreamChunk> {
    const response = await fetch('https://api.openai.com/v1/chat/completions', {
      method: 'POST',
      headers: {
        Authorization: `Bearer ${requireEnv('OPENAI_API_KEY')}`,
        'Content-Type': 'application/json',
      },
      signal: this.getAbortSignal(),
      body: JSON.stringify({
        model: this.options.model,
        temperature: 0.2,
        messages: [
          { role: 'system', content: params.system },
          ...toOpenAICompatibleMessages(params.messages),
        ],
        tools: toOpenAICompatibleTools(params.tools),
      }),
    })

    if (!response.ok) {
      throw new Error(`OpenAI request failed: ${response.status} ${await response.text()}`)
    }

    const payload = (await response.json()) as {
      choices?: Array<{
        message?: {
          content?: unknown
          tool_calls?: Array<{
            id: string
            function: { name: string; arguments: string }
          }>
        }
      }>
    }

    const message = payload.choices?.[0]?.message
    const text = flattenResponseText(message?.content)

    yield* this.yieldTextChunks(text)

    for (const toolCall of message?.tool_calls ?? []) {
      yield {
        type: 'tool_call',
        id: toolCall.id,
        name: toolCall.function.name,
        input: parseArguments(toolCall.function.arguments),
      }
    }

    yield {
      type: 'end',
      stop_reason: (message?.tool_calls?.length ?? 0) > 0 ? 'tool_use' : 'end_turn',
    }
  }
}

function parseArguments(raw: string): unknown {
  try {
    return JSON.parse(raw)
  } catch {
    return {}
  }
}
