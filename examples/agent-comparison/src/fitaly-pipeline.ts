import {
  AsyncAgent,
  ToolRegistry,
  ExecutorPool,
  InMemoryPendingStateTracker,
  registerFunctionHandler,
  type IInnerAgent,
  type Message,
  type AgentResponse,
} from '@fitalyagents/asynctools'
import { OpenRouterProvider, type ChatMessage } from './openrouter-provider.js'
import { searchProducts, getProductById } from './db.js'
import { VoiceSimulator } from './voice-simulator.js'

export interface FitalyPhases {
  stt: number // STT simulation
  llm1: number // LLM Turn 1 (tool decision)
  toolsParallel: number // Tool execution — ran in parallel with filler
  fillerFirstTokenMs: number // ms from pipeline start when first filler token arrived (-1 if none)
  fillerDoneMs: number // ms from pipeline start when filler stream finished (-1 if none)
  llm2: number // LLM Turn 2 (final answer after tools)
  tts: number // TTS simulation
}

class OpenRouterAsyncAdapter implements IInnerAgent {
  private llm: OpenRouterProvider
  private messages: ChatMessage[] = []
  private onFillerToken?: (token: string, done: boolean) => void
  private pipelineStart: number
  private turnCount = 0
  private fillerFired = false

  // Collected timing data — read by FitalyPipeline after agent.run() resolves
  public llmDurations: number[] = []
  public toolsStartedAt = -1

  constructor(pipelineStart: number, onFillerToken?: (token: string, done: boolean) => void) {
    this.llm = new OpenRouterProvider()
    this.pipelineStart = pipelineStart
    this.onFillerToken = onFillerToken
    this.messages.push({
      role: 'system',
      content:
        'You are a helpful retail assistant. Answer queries using the provided tools. Be concise. If a search returns no results, do NOT announce that — ask one short clarifying question to refine the search (e.g., brand, category, color, budget).',
    })
  }

  private elapsed(): number {
    return Math.round(performance.now() - this.pipelineStart)
  }

  /**
   * Fires a fast streaming LLM call in the background to generate a filler sentence.
   * Runs in parallel with tool execution — fire & forget, errors are swallowed.
   */
  private startStreamingFiller(userQuery: string, toolNames: string[]): void {
    if (!this.onFillerToken || this.fillerFired) return
    this.fillerFired = true

    const fillerMessages: ChatMessage[] = [
      {
        role: 'system',
        content: [
          'You are a voice retail assistant.',
          'Respond with ONE short sentence (max 8 words, no markdown, natural speech, end with "…").',
          'Tell the customer what you are looking up for them right now.',
        ].join(' '),
      },
      {
        role: 'user',
        content: `Customer said: "${userQuery}". You are calling: ${toolNames.join(', ')}.`,
      },
    ]

    const cb = this.onFillerToken
    this.llm
      .streamChat(fillerMessages, (token) => cb(token, false), 'openai/gpt-4o-mini')
      .then(() => cb('', true))
      .catch(() => cb('', true))
  }

  async run(newMessages: Message[]): Promise<AgentResponse> {
    let lastUserQuery = ''
    for (const m of newMessages) {
      if (m.role === 'user') lastUserQuery = m.content as string
      if (m.role === 'user' || m.role === 'assistant') {
        this.messages.push({ role: m.role, content: m.content as string })
      } else if (m.role === 'tool') {
        this.messages.push({
          role: 'tool',
          tool_call_id: m.tool_call_id,
          content: typeof m.content === 'string' ? m.content : JSON.stringify(m.content),
        })
      }
    }

    const tools = [
      {
        type: 'function',
        function: {
          name: 'product_search',
          description: 'Search for products in the catalog',
          parameters: {
            type: 'object',
            properties: {
              query: { type: 'string', description: 'Product name or category to search for' },
            },
            required: ['query'],
          },
        },
      },
      {
        type: 'function',
        function: {
          name: 'product_detail',
          description: 'Get details of a specific product by ID',
          parameters: {
            type: 'object',
            properties: {
              product_id: { type: 'string', description: 'The ID of the product' },
            },
            required: ['product_id'],
          },
        },
      },
    ]

    const llmStart = this.elapsed()
    const { response } = await this.llm.chat(this.messages, tools)
    this.llmDurations.push(this.elapsed() - llmStart)
    this.messages.push(response)

    if (response.tool_calls && response.tool_calls.length > 0) {
      this.toolsStartedAt = this.elapsed()
      const toolNames = response.tool_calls.map((tc: any) => tc.function.name)
      // Launch fast streaming filler in background — runs while AsyncAgent dispatches tools
      this.startStreamingFiller(lastUserQuery, toolNames)

      this.turnCount++
      return {
        tool_calls: response.tool_calls.map((tc: any) => ({
          id: tc.id,
          tool_id: tc.function.name,
          input: JSON.parse(tc.function.arguments),
        })),
        stop_reason: 'tool_use',
      }
    }

    return {
      content: response.content || '',
      stop_reason: 'end_turn',
    }
  }
}

export class FitalyPipeline {
  private voice: VoiceSimulator
  private registry: ToolRegistry
  private pool: ExecutorPool
  private tracker: InMemoryPendingStateTracker

  constructor(sttDelayMs = 150, ttsDelayMs = 250) {
    this.voice = new VoiceSimulator(sttDelayMs, ttsDelayMs)
    this.registry = new ToolRegistry()

    this.registry.registerMany([
      {
        tool_id: 'product_search',
        description: 'Search for products in the catalog',
        executor: { type: 'ts_fn' },
        execution_mode: 'async',
        timeout_ms: 10_000,
      },
      {
        tool_id: 'product_detail',
        description: 'Get details of a specific product by ID',
        executor: { type: 'ts_fn' },
        execution_mode: 'async',
        timeout_ms: 10_000,
      },
    ])

    registerFunctionHandler('product_search', async (input) => {
      const { query } = input as { query: string }
      return await searchProducts(query)
    })

    registerFunctionHandler('product_detail', async (input) => {
      const { product_id } = input as { product_id: string }
      return (await getProductById(product_id)) || { error: 'Not found' }
    })

    this.pool = new ExecutorPool(this.registry)
    this.tracker = new InMemoryPendingStateTracker()
  }

  async run(
    userQuery: string,
    onFillerToken?: (token: string, done: boolean) => void,
  ): Promise<{ text: string; latencyMs: number; phases: FitalyPhases }> {
    const t0 = performance.now()
    const ms = () => Math.round(performance.now() - t0)

    // 1. STT
    const textQuery = await this.voice.simulateSTT(userQuery)
    const stt = ms()

    // Track filler timing from outside the adapter via the callback wrapper
    let fillerFirstTokenMs = -1
    let fillerDoneMs = -1

    const wrappedFiller = onFillerToken
      ? (token: string, done: boolean) => {
          if (!done && fillerFirstTokenMs < 0) fillerFirstTokenMs = ms()
          if (done && fillerFirstTokenMs >= 0) fillerDoneMs = ms()
          onFillerToken(token, done)
        }
      : undefined

    // 2. AsyncAgent run
    const adapter = new OpenRouterAsyncAdapter(t0, wrappedFiller)

    const agent = new AsyncAgent({
      inner: adapter,
      toolRegistry: this.registry,
      executorPool: this.pool,
      tracker: this.tracker,
      injectionStrategy: 'inject_when_all',
      globalTimeoutMs: 60_000,
      maxTurns: 10,
    })

    const response = await agent.run(textQuery)

    // Derive toolsParallel: from when tools were dispatched to when LLM Turn 2 started
    const toolsParallel =
      adapter.toolsStartedAt >= 0 && adapter.llmDurations.length >= 2
        ? ms() - adapter.llmDurations[1] - adapter.toolsStartedAt
        : 0

    // 3. TTS
    const ttsStart = ms()
    const finalAudioText = await this.voice.simulateTTS(response.content || '')
    const tts = ms() - ttsStart

    return {
      text: finalAudioText,
      latencyMs: ms(),
      phases: {
        stt,
        llm1: adapter.llmDurations[0] ?? 0,
        toolsParallel,
        fillerFirstTokenMs,
        fillerDoneMs,
        llm2: adapter.llmDurations[1] ?? 0,
        tts,
      },
    }
  }
}
