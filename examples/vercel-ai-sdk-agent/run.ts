import { streamText, type ModelMessage } from 'ai'
import { openai } from '@ai-sdk/openai'
import {
  InMemoryBus,
  InMemoryContextStore,
  InteractionAgent,
  SafetyGuard,
  type InteractionToolDef,
  type IStreamingLLM,
  type IToolExecutor,
  type LLMStreamChunk,
} from 'fitalyagents'

function requireEnv(name: string): string {
  const value = process.env[name]
  if (!value) {
    throw new Error(`Missing required environment variable: ${name}`)
  }
  return value
}

type InteractionHistoryMessage = {
  role: 'user' | 'assistant' | 'tool'
  content: string
  tool_call_id?: string
}

function toModelMessages(messages: InteractionHistoryMessage[]): ModelMessage[] {
  return messages.map((message) => {
    if (message.role === 'tool') {
      return {
        // AI SDK v6 tool prompt parts need the tool name as well.
        // InteractionAgent history only preserves tool_call_id, so this
        // baseline example folds prior tool outputs back into assistant text.
        role: 'assistant',
        content: `[Tool result ${message.tool_call_id ?? 'unknown'}]\n${message.content}`,
      }
    }

    return {
      role: message.role,
      content: message.content,
    }
  })
}

class VercelAIStreamingLLM implements IStreamingLLM {
  private readonly model = openai(process.env.VERCEL_AI_MODEL ?? 'gpt-4o-mini')

  constructor() {
    requireEnv('OPENAI_API_KEY')
  }

  async *stream(params: {
    system: string
    messages: InteractionHistoryMessage[]
    tools?: Array<{ name: string; description?: string; input_schema?: unknown }>
  }): AsyncIterable<LLMStreamChunk> {
    void params.tools

    const result = streamText({
      model: this.model,
      system: params.system,
      messages: toModelMessages(params.messages),
    })

    for await (const chunk of result.textStream) {
      if (chunk) {
        yield { type: 'text', text: chunk }
      }
    }

    yield { type: 'end', stop_reason: 'end_turn' }
  }
}

const noopExecutor: IToolExecutor = {
  async execute(toolId: string): Promise<unknown> {
    throw new Error(`No tool executor configured for "${toolId}" in this example`)
  },
}

async function main(): Promise<void> {
  const bus = new InMemoryBus()
  const contextStore = new InMemoryContextStore()
  const toolRegistry = new Map<string, InteractionToolDef>()
  const ttsChunks: string[] = []

  const agent = new InteractionAgent({
    bus,
    llm: new VercelAIStreamingLLM(),
    contextStore,
    toolRegistry,
    executor: noopExecutor,
    safetyGuard: new SafetyGuard({ toolConfigs: [] }),
    systemPrompt:
      'You are a concise retail assistant. Answer in 2 short sentences and avoid markdown.',
    ttsCallback: (text) => {
      ttsChunks.push(text)
      process.stdout.write(text)
    },
  })

  console.log('Vercel AI SDK InteractionAgent example')
  console.log('======================================')

  const result = await agent.handleSpeechFinal({
    session_id: 'vercel-ai-session-1',
    text: 'Write a short greeting for a customer entering a running store.',
    speaker_id: 'customer-1',
  })

  console.log('\n')
  console.log('Text chunks:', result.textChunks.length)
  console.log('Tool results:', result.toolResults.length)
  console.log('Trace ID:', result.traceId)
  console.log('Final text:', ttsChunks.join(''))
}

main().catch((error) => {
  console.error(error)
  process.exitCode = 1
})
