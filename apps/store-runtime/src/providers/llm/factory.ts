import type { StoreConfig } from '../../config/schema.js'
import type { SessionBoundLLM } from './types.js'
import { AnthropicStreamingLLM } from './anthropic.js'
import { GroqStreamingLLM } from './groq.js'
import { OpenAIStreamingLLM } from './openai.js'

export function createLLMProvider(config: StoreConfig['providers']['llm']): SessionBoundLLM {
  switch (config.driver) {
    case 'groq':
      return new GroqStreamingLLM({ model: config.model })
    case 'anthropic':
      return new AnthropicStreamingLLM({ model: config.model })
    case 'openai':
      return new OpenAIStreamingLLM({ model: config.model })
  }
}
