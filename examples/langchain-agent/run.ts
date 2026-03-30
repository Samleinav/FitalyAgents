import { AIMessage, HumanMessage, SystemMessage, ToolMessage } from '@langchain/core/messages'
import { ChatOpenAI } from '@langchain/openai'
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

function flattenLangChainContent(content: unknown): string {
  if (typeof content === 'string') return content
  if (!Array.isArray(content)) return ''

  return content
    .map((item) => {
      if (typeof item === 'string') return item
      if (item && typeof item === 'object' && 'text' in item) {
        return String((item as { text: unknown }).text)
      }
      return ''
    })
    .join('')
}

class LangChainStreamingLLM implements IStreamingLLM {
  private readonly model: ChatOpenAI

  constructor() {
    requireEnv('OPENAI_API_KEY')
    this.model = new ChatOpenAI({
      model: process.env.LANGCHAIN_MODEL ?? 'gpt-4o-mini',
      temperature: 0.2,
    })
  }

  async *stream(params: {
    system: string
    messages: Array<{ role: 'user' | 'assistant' | 'tool'; content: string; tool_call_id?: string }>
    tools?: Array<{ name: string; description?: string; input_schema?: unknown }>
  }): AsyncIterable<LLMStreamChunk> {
    void params.tools

    const response = await this.model.invoke([
      new SystemMessage(params.system),
      ...params.messages.map((message) => {
        if (message.role === 'assistant') {
          return new AIMessage(message.content)
        }
        if (message.role === 'tool') {
          return new ToolMessage({
            content: message.content,
            tool_call_id: message.tool_call_id ?? 'tool_call_missing',
          })
        }
        return new HumanMessage(message.content)
      }),
    ])

    const text = flattenLangChainContent(response.content)
    if (text) {
      yield { type: 'text', text }
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
    llm: new LangChainStreamingLLM(),
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

  console.log('LangChain InteractionAgent example')
  console.log('==================================')

  const result = await agent.handleSpeechFinal({
    session_id: 'langchain-session-1',
    text: 'Write a short greeting for a customer entering a premium sneaker store.',
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
