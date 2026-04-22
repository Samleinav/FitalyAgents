import { AsyncLocalStorage } from 'node:async_hooks'
import type { LLMStreamChunk } from 'fitalyagents'
import type { SessionBoundLLM } from './types.js'

export abstract class BaseSessionBoundLLM implements SessionBoundLLM {
  private readonly storage = new AsyncLocalStorage<{ sessionId: string }>()
  private readonly controllers = new Map<string, AbortController>()

  runWithSession<T>(sessionId: string, fn: () => Promise<T>): Promise<T> {
    return this.storage.run({ sessionId }, async () => {
      const controller = new AbortController()
      this.controllers.set(sessionId, controller)

      try {
        return await fn()
      } finally {
        if (this.controllers.get(sessionId) === controller) {
          this.controllers.delete(sessionId)
        }
      }
    })
  }

  abortSession(sessionId: string): void {
    this.controllers.get(sessionId)?.abort()
  }

  dispose(): void {
    for (const controller of this.controllers.values()) {
      controller.abort()
    }
    this.controllers.clear()
  }

  protected getAbortSignal(): AbortSignal | undefined {
    const sessionId = this.storage.getStore()?.sessionId
    if (!sessionId) {
      return undefined
    }

    let controller = this.controllers.get(sessionId)
    if (!controller || controller.signal.aborted) {
      controller = new AbortController()
      this.controllers.set(sessionId, controller)
    }

    return controller.signal
  }

  protected async *yieldTextChunks(text: string): AsyncIterable<LLMStreamChunk> {
    for (const chunk of splitTextIntoChunks(text)) {
      yield { type: 'text', text: chunk }
    }
  }

  abstract stream(params: {
    system: string
    messages: Array<{ role: 'user' | 'assistant' | 'tool'; content: string; tool_call_id?: string }>
    tools?: Array<{ name: string; description?: string; input_schema?: unknown }>
  }): AsyncIterable<LLMStreamChunk>
}

export function requireEnv(name: string): string {
  const value = process.env[name]
  if (!value) {
    throw new Error(`Missing required environment variable: ${name}`)
  }
  return value
}

export function toOpenAICompatibleMessages(
  messages: Array<{ role: 'user' | 'assistant' | 'tool'; content: string; tool_call_id?: string }>,
) {
  return messages.map((message) => {
    if (message.role === 'tool') {
      return {
        role: 'tool',
        tool_call_id: message.tool_call_id ?? 'tool_call_missing',
        content: message.content,
      }
    }

    return {
      role: message.role,
      content: message.content,
    }
  })
}

export function toOpenAICompatibleTools(
  tools: Array<{ name: string; description?: string; input_schema?: unknown }> | undefined,
) {
  return tools?.map((tool) => ({
    type: 'function',
    function: {
      name: tool.name,
      description: tool.description ?? '',
      parameters:
        tool.input_schema && typeof tool.input_schema === 'object'
          ? tool.input_schema
          : { type: 'object', properties: {} },
    },
  }))
}

export function flattenResponseText(content: unknown): string {
  if (typeof content === 'string') {
    return content
  }

  if (!Array.isArray(content)) {
    return ''
  }

  return content
    .map((part) => {
      if (typeof part === 'string') {
        return part
      }

      if (part && typeof part === 'object') {
        if ('text' in part && typeof part.text === 'string') {
          return part.text
        }
        if (
          'type' in part &&
          part.type === 'output_text' &&
          'text' in part &&
          typeof part.text === 'string'
        ) {
          return part.text
        }
      }

      return ''
    })
    .join('')
}

function splitTextIntoChunks(text: string): string[] {
  const normalized = text.trim()
  if (!normalized) {
    return []
  }

  const sentenceChunks = normalized.match(/[^.!?…]+[.!?…]*\s*/g)?.map((chunk) => chunk.trim())
  if (sentenceChunks && sentenceChunks.length > 1) {
    return sentenceChunks.filter(Boolean)
  }

  const words = normalized.split(/\s+/)
  const chunks: string[] = []

  for (let index = 0; index < words.length; index += 10) {
    chunks.push(words.slice(index, index + 10).join(' '))
  }

  return chunks
}
