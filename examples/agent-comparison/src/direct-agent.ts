import { OpenRouterProvider, type ChatMessage } from './openrouter-provider.js'
import { VoiceSimulator } from './voice-simulator.js'
import { searchProducts, getProductById } from './db.js'

export interface DirectPhases {
  stt: number // STT simulation
  llm1: number // LLM Turn 1 (decides whether to call tools)
  tools: number // Sequential tool execution (0 if no tools called)
  llm2: number // LLM Turn 2 after tools (0 if no tools called)
  tts: number // TTS simulation
}

export class DirectAgent {
  private llm: OpenRouterProvider
  private voice: VoiceSimulator

  constructor(sttDelayMs = 150, ttsDelayMs = 250) {
    this.llm = new OpenRouterProvider()
    this.voice = new VoiceSimulator(sttDelayMs, ttsDelayMs)
  }

  private tools = [
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

  async run(userQuery: string): Promise<{ text: string; latencyMs: number; phases: DirectPhases }> {
    const t0 = performance.now()
    const ms = () => Math.round(performance.now() - t0)

    // 1. STT
    const textQuery = await this.voice.simulateSTT(userQuery)
    const stt = ms()

    // 2. LLM loop
    let messages: ChatMessage[] = [
      {
        role: 'system',
        content:
          'You are a helpful retail assistant. Answer queries using the provided tools. Be concise. If a search returns no results, do NOT announce that — ask one short clarifying question to refine the search (e.g., brand, category, color, budget).',
      },
      { role: 'user', content: textQuery },
    ]

    let finalResponseText = ''
    let turnCount = 0
    const llmDurations: number[] = []
    let toolsMs = 0

    while (true) {
      const llmStart = ms()
      const { response } = await this.llm.chat(messages, this.tools)
      llmDurations.push(ms() - llmStart)
      messages.push(response)

      if (response.tool_calls && response.tool_calls.length > 0) {
        const toolStart = ms()
        for (const toolCall of response.tool_calls) {
          const args = JSON.parse(toolCall.function.arguments)
          let resultStr = ''
          try {
            if (toolCall.function.name === 'product_search') {
              const products = await searchProducts(args.query)
              resultStr = JSON.stringify(products)
            } else if (toolCall.function.name === 'product_detail') {
              const product = await getProductById(args.product_id)
              resultStr = JSON.stringify(product || { error: 'Product not found' })
            } else {
              resultStr = JSON.stringify({ error: 'Unknown tool' })
            }
          } catch (e: any) {
            resultStr = JSON.stringify({ error: e.message })
          }
          messages.push({ role: 'tool', tool_call_id: toolCall.id, content: resultStr })
        }
        toolsMs += ms() - toolStart
      } else {
        finalResponseText = response.content || ''
        break
      }
      turnCount++
    }

    // 3. TTS
    const ttsStart = ms()
    const audioOutput = await this.voice.simulateTTS(finalResponseText)
    const tts = ms() - ttsStart

    return {
      text: audioOutput,
      latencyMs: ms(),
      phases: {
        stt,
        llm1: llmDurations[0] ?? 0,
        tools: toolsMs,
        llm2: llmDurations[1] ?? 0,
        tts,
      },
    }
  }
}
