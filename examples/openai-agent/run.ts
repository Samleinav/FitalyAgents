import OpenAI from 'openai'
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

function flattenOpenAIContent(content: unknown): string {
  if (typeof content === 'string') return content
  if (!Array.isArray(content)) return ''

  return content
    .map((item) => {
      if (
        item &&
        typeof item === 'object' &&
        'type' in item &&
        (item as { type?: unknown }).type === 'text' &&
        'text' in item
      ) {
        return String((item as { text: unknown }).text)
      }
      return ''
    })
    .join('')
}

class OpenAIStreamingLLM implements IStreamingLLM {
  private readonly client: OpenAI
  private readonly model: string

  constructor() {
    this.client = new OpenAI({ apiKey: requireEnv('OPENAI_API_KEY') })
    this.model = process.env.OPENAI_MODEL ?? 'gpt-4o-mini'
  }

  async *stream(params: {
    system: string
    messages: Array<{ role: 'user' | 'assistant' | 'tool'; content: string; tool_call_id?: string }>
    tools?: Array<{ name: string; description?: string; input_schema?: unknown }>
  }): AsyncIterable<LLMStreamChunk> {
    const response = await this.client.chat.completions.create({
      model: this.model,
      temperature: 0.2,
      messages: [
        { role: 'system', content: params.system },
        ...params.messages.map((message) => {
          if (message.role === 'tool') {
            return {
              role: 'tool' as const,
              tool_call_id: message.tool_call_id ?? 'tool_call_missing',
              content: message.content,
            }
          }

          return {
            role: message.role,
            content: message.content,
          }
        }),
      ],
      tools: params.tools?.map((tool) => ({
        type: 'function' as const,
        function: {
          name: tool.name,
          description: tool.description ?? '',
          parameters:
            tool.input_schema && typeof tool.input_schema === 'object'
              ? (tool.input_schema as Record<string, unknown>)
              : {
                  type: 'object',
                  properties: {},
                },
        },
      })),
    })

    const message = response.choices[0]?.message
    const text = flattenOpenAIContent(message?.content)

    if (text) {
      yield { type: 'text', text }
    }

    for (const toolCall of message?.tool_calls ?? []) {
      let input: unknown = {}
      try {
        input = JSON.parse(toolCall.function.arguments || '{}')
      } catch {
        input = {}
      }

      yield {
        type: 'tool_call',
        id: toolCall.id,
        name: toolCall.function.name,
        input,
      }
    }

    yield {
      type: 'end',
      stop_reason: (message?.tool_calls?.length ?? 0) > 0 ? 'tool_use' : 'end_turn',
    }
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

  bus.subscribe('bus:AGENT_ERROR', (data) => {
    console.error('AGENT_ERROR', data)
  })

  const agent = new InteractionAgent({
    bus,
    llm: new OpenAIStreamingLLM(),
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

  console.log('OpenAI InteractionAgent example')
  console.log('================================')

  const result = await agent.handleSpeechFinal({
    session_id: 'openai-session-1',
    text: 'Recommend a short greeting for a customer entering a sports store.',
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
