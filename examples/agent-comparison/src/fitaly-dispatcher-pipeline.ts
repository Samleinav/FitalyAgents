/**
 * FitalyDispatcherPipeline — Fitaly + cascaded pre-classification + IntentRegistry.
 *
 * Architecture vs standard Fitaly:
 *
 * Standard Fitaly (2 LLM calls):
 *   STT(150ms) → LLM Turn 1(1800ms) → tools(300ms) → LLM Turn 2(1800ms) → TTS(250ms)
 *   Total: ~4300ms
 *
 * With Dispatcher + IntentRegistry (Option B — speculative intercept):
 *   STT(150ms) ─┐
 *   Dispatcher(10ms) → tool starts(background) ─┐
 *               ├─ filler fires (~+15ms)         │
 *               └─► LLM Turn 1(1000ms TTFT) ─────┤ tool done during LLM1 TTFT
 *                       LLM calls tool → HIT: 0ms wait
 *                       LLM Turn 2(800ms) → TTS(250ms)
 *   Total: ~2200ms  (-2100ms, -48%)
 *
 * Key improvement over Option A (pre-loaded context):
 *   - LLM starts at t=150ms (right after STT) instead of t=310ms (after tools)
 *   - Tools execute during LLM Turn 1 TTFT → effectively free
 *   - LLM can disagree with dispatcher → CORRECTION recorded → dispatcher learns
 *
 * Dispatch cascade:
 *   Level 1 — KeywordDispatcher  ~1ms   (ID regex, deterministic)
 *   Level 2 — EmbeddingDispatcher ~10ms  (semantic, margin-based, confident-none skip)
 *   Level 3 — LLM Classifier      ~200ms (fast model, only classifies)
 *   Level 4 — Full two-turn LLM   (last resort, no speculation)
 */

import { OpenRouterProvider, type ChatMessage } from './openrouter-provider.js'
import { VoiceSimulator } from './voice-simulator.js'
import { KeywordDispatcher, type DispatchResult, type Intent } from './dispatcher.js'
import { EmbeddingDispatcher } from './embedding-dispatcher.js'
import { extractParams } from './param-extractor.js'
import { searchProducts, getProductById } from './db.js'
import { IntentRegistry, type OutcomeType } from './intent-registry.js'
import { IntentScoreStore, type LearningMode, type ScoreEntry } from './intent-score-store.js'
import { IntentTeacher, type TeacherResult } from './intent-teacher.js'

export type DispatcherMode = 'keyword' | 'embedding'
export type FallbackLevel = 'keyword' | 'embedding' | 'llm_classifier' | 'full_llm'
export type { LearningMode }

export interface DispatcherPhases {
  stt: number
  dispatcher: number // L1/L2/L3 classification time
  llm1: number // LLM Turn 1 (decides which tool to call)
  toolWait: number // 0ms on cache HIT, actual tool time on MISS/CORRECTION
  llm2: number // LLM Turn 2 (generates final answer)
  tts: number
  dispatcherHit: boolean // true if L1/L2/L3 classified + speculated
  fallbackLevel: FallbackLevel
  outcome: OutcomeType | null
}

// ─── Tool execution ───────────────────────────────────────────────────────────

async function executeTool(tool_name: string, params: Record<string, string>): Promise<unknown> {
  if (tool_name === 'product_search') return await searchProducts(params.query ?? '')
  if (tool_name === 'product_detail')
    return (await getProductById(params.product_id ?? '')) ?? { error: 'Not found' }
  return { error: 'Unknown tool' }
}

// ─── LLM classifier (Level 3) ─────────────────────────────────────────────────

const LLM_CLASSIFIER_SYSTEM = `You are an intent classifier for a retail voice assistant.
Classify the user query into one of these intents:
- product_search: user wants to browse or find products by name, category, or brand
- product_detail: user wants details about a specific product (usually by ID like P001)
- none: greeting, small talk, questions about store policy, or anything else

Respond with JSON only. Examples:
{"intent":"product_search","params":{"query":"Nike shoes"}}
{"intent":"product_detail","params":{"product_id":"P001"}}
{"intent":"none"}`

async function llmClassify(
  llm: OpenRouterProvider,
  textQuery: string,
): Promise<(DispatchResult & { level: FallbackLevel }) | null> {
  try {
    const { response } = await llm.chat(
      [
        { role: 'system', content: LLM_CLASSIFIER_SYSTEM },
        { role: 'user', content: textQuery },
      ],
      undefined,
    )

    const raw = response?.content?.trim() ?? ''
    const jsonMatch = raw.match(/\{[\s\S]*\}/)
    if (!jsonMatch) return null

    const parsed = JSON.parse(jsonMatch[0])
    const intent = parsed.intent as Intent
    if (!intent || intent === 'none') return null

    const params = extractParams(intent, textQuery)
    return {
      intent,
      params: Object.keys(parsed.params ?? {}).length > 0 ? parsed.params : params,
      confidence: 1.0,
      latencyMs: 0,
      level: 'llm_classifier',
    }
  } catch {
    return null
  }
}

// ─── Tool schema (shared for all LLM calls) ───────────────────────────────────

const TOOLS_SCHEMA = [
  {
    type: 'function',
    function: {
      name: 'product_search',
      description: 'Search for products in the catalog by name, category, or brand.',
      parameters: {
        type: 'object',
        properties: {
          query: { type: 'string', description: 'Product name, category or brand to search for' },
        },
        required: ['query'],
      },
    },
  },
  {
    type: 'function',
    function: {
      name: 'product_detail',
      description: 'Get full details of a specific product by its ID.',
      parameters: {
        type: 'object',
        properties: { product_id: { type: 'string', description: 'Product ID, e.g. P001' } },
        required: ['product_id'],
      },
    },
  },
]

const SYSTEM_PROMPT =
  'You are a helpful retail assistant. Answer queries using the provided tools. Be concise. If a search returns no results, do NOT announce that — ask one short clarifying question to refine the search (e.g., brand, category, color, budget).'

// ─── Confident-none threshold ─────────────────────────────────────────────────
// When L2 embedding returns intent=none with margin >= this threshold,
// skip L3 (saves ~700ms of LLM classifier latency for greetings/small-talk).
const CONFIDENT_NONE_MARGIN = 0.08 // same as MARGIN_THRESHOLD in embedding-dispatcher

// ─── Pipeline ─────────────────────────────────────────────────────────────────

export class FitalyDispatcherPipeline {
  private llm: OpenRouterProvider
  private voice: VoiceSimulator
  private kwDispatcher: KeywordDispatcher
  private embDispatcher: EmbeddingDispatcher | null
  readonly mode: DispatcherMode
  readonly registry: IntentRegistry
  readonly scoreStore: IntentScoreStore
  private teacher: IntentTeacher | null
  private onTeacherAction: ((result: TeacherResult, query: string) => void) | null

  constructor(
    sttDelayMs = 150,
    ttsDelayMs = 250,
    mode: DispatcherMode = 'embedding',
    learningMode: LearningMode = 'training',
    scoreStorePath?: string,
    teacherExamplesPath?: string,
    teacher?: IntentTeacher,
    onTeacherAction?: (result: TeacherResult, query: string) => void,
  ) {
    this.llm = new OpenRouterProvider()
    this.voice = new VoiceSimulator(sttDelayMs, ttsDelayMs)
    this.mode = mode
    this.kwDispatcher = new KeywordDispatcher(1)
    this.embDispatcher = mode === 'embedding' ? new EmbeddingDispatcher(teacherExamplesPath) : null
    this.registry = new IntentRegistry()
    this.scoreStore = new IntentScoreStore(scoreStorePath)
    this.scoreStore.setMode(learningMode)
    this.teacher = teacher ?? null
    this.onTeacherAction = onTeacherAction ?? null
  }

  setLearningMode(mode: LearningMode): void {
    this.scoreStore.setMode(mode)
  }

  getLearningMode(): LearningMode {
    return this.scoreStore.getMode()
  }

  getScoreStats(): { mode: LearningMode; scores: ScoreEntry[]; hitRate: number } {
    return {
      mode: this.scoreStore.getMode(),
      scores: this.scoreStore.getAll(),
      hitRate: this.registry.getHitRate(),
    }
  }

  async warmup(): Promise<void> {
    await this.embDispatcher?.init()
  }

  /**
   * Levels 1+2 cascade. Returns:
   *   { hit: DispatchResult, confidentNone: false } — classified an actionable intent
   *   { hit: null, confidentNone: true }            — embedding confident it's none → skip L3
   *   { hit: null, confidentNone: false }           — uncertain → let L3 try
   */
  private async cascadeLevel1And2(query: string): Promise<{
    hit: (DispatchResult & { level: FallbackLevel }) | null
    confidentNone: boolean
  }> {
    // Level 1: keyword (regex, ~1ms)
    const kw = await this.kwDispatcher.classify(query)
    if (kw.intent !== 'none') return { hit: { ...kw, level: 'keyword' }, confidentNone: false }

    // Level 2: embedding (top-k voting + margin, ~10ms)
    if (this.embDispatcher) {
      const emb = await this.embDispatcher.classify(query)
      if (emb.intent !== 'none')
        return { hit: { ...emb, level: 'embedding' }, confidentNone: false }
      // Confident none: embedding is sure this is not a tool query
      if (emb.confidence >= CONFIDENT_NONE_MARGIN) return { hit: null, confidentNone: true }
    }

    return { hit: null, confidentNone: false }
  }

  async run(
    userQuery: string,
    onFillerToken?: (token: string, done: boolean) => void,
  ): Promise<{ text: string; latencyMs: number; phases: DispatcherPhases }> {
    const t0 = performance.now()
    const ms = () => Math.round(performance.now() - t0)

    this.registry.onNoToolCall() // clear any leftover state from previous request

    // Levels 1+2 run in parallel with STT — both finish well before 150ms
    const [textQuery, cascade] = await Promise.all([
      this.voice.simulateSTT(userQuery),
      this.cascadeLevel1And2(userQuery),
    ])
    const afterParallel = ms()

    let dispatchHit: (DispatchResult & { level: FallbackLevel }) | null = cascade.hit
    let fallbackLevel: FallbackLevel = 'full_llm'
    let dispatcherMs = dispatchHit?.latencyMs ?? 0

    // Level 3: LLM classifier — only if L1/L2 uncertain (not if confident none)
    if (!dispatchHit && !cascade.confidentNone) {
      const t3 = ms()
      const llmResult = await llmClassify(this.llm, textQuery)
      dispatcherMs = ms() - t3
      if (llmResult) {
        dispatchHit = llmResult
        fallbackLevel = 'llm_classifier'
      }
    } else if (dispatchHit) {
      fallbackLevel = dispatchHit.level
    } else if (cascade.confidentNone) {
      // Confident none from L2 — skip L3, go straight to conversational LLM
      fallbackLevel = 'embedding'
    }

    // In production mode, skip speculation for tools with low confidence scores
    const canSpeculate =
      dispatchHit !== null &&
      dispatchHit.intent !== 'none' &&
      this.scoreStore.shouldSpeculate(dispatchHit.intent)

    const didSpeculate = canSpeculate

    // If dispatcher classified an actionable intent → speculate + fire filler
    if (didSpeculate) {
      const { intent, params } = dispatchHit!
      // Speculation: start tool in background immediately (runs during LLM Turn 1 TTFT)
      this.registry.speculate(intent, intent, () => executeTool(intent, params))

      if (onFillerToken) {
        const fillerMessages: ChatMessage[] = [
          {
            role: 'system',
            content:
              'You are a voice retail assistant. Respond with ONE short sentence (max 8 words, no markdown, natural speech, end with "…"). Tell the customer what you are looking up.',
          },
          { role: 'user', content: `Customer said: "${userQuery}". You are calling: ${intent}.` },
        ]
        const cb = onFillerToken
        this.llm
          .streamChat(fillerMessages, (tok) => cb(tok, false), 'openai/gpt-4o-mini')
          .then(() => cb('', true))
          .catch(() => cb('', true))
      }
    }

    // ── Unified LLM loop with speculative intercept ────────────────────────
    // Same loop for hit and L4 paths. The registry makes it transparent:
    //   - If dispatcher speculated the same tool → 0ms wait (cached)
    //   - If different tool / no speculation → executes normally (300ms)
    const messages: ChatMessage[] = [
      { role: 'system', content: SYSTEM_PROMPT },
      { role: 'user', content: textQuery },
    ]

    let finalText = ''
    let llm1Ms = 0
    let toolWait = 0
    let llm2Ms = 0
    let llmTurn = 0

    while (llmTurn < 5) {
      const llmStart = ms()
      const { response } = await this.llm.chat(messages, TOOLS_SCHEMA)
      const llmElapsed = ms() - llmStart

      if (llmTurn === 0) llm1Ms = llmElapsed
      else llm2Ms += llmElapsed
      llmTurn++

      messages.push(response)

      if (response.tool_calls?.length > 0) {
        const toolStart = ms()

        for (const tc of response.tool_calls) {
          const tcParams = JSON.parse(tc.function.arguments) as Record<string, string>

          // Intercept: check if dispatcher already ran this tool
          const { cached, resultPromise } = this.registry.resolve(tc.function.name)

          let result: unknown
          if (cached && resultPromise) {
            result = await resultPromise // resolves immediately if tool done
          } else {
            result = await executeTool(tc.function.name, tcParams)
          }

          messages.push({
            role: 'tool',
            tool_call_id: tc.id,
            content: JSON.stringify(result),
          })
        }

        toolWait = ms() - toolStart
      } else {
        this.registry.onNoToolCall()
        finalText = response.content ?? ''
        break
      }
    }

    const ttsStart = ms()
    const audioOutput = await this.voice.simulateTTS(finalText)
    const tts = ms() - ttsStart

    const outcome = this.registry.getLastOutcome()

    // Update EMA scores based on outcome (only when dispatcher speculated something)
    if (outcome && outcome.dispatcher_tool) {
      if (outcome.outcome === 'hit') {
        this.scoreStore.update(outcome.dispatcher_tool, 'hit')
      } else if (outcome.outcome === 'correction') {
        this.scoreStore.update(outcome.dispatcher_tool, 'correction')

        // Fire-and-forget: teacher evaluates whether correction → new training example
        if (this.teacher && this.embDispatcher) {
          const correctIntent = outcome.llm_tool as Intent
          const wrongIntent = outcome.dispatcher_tool as Intent
          const existing = this.embDispatcher.getExampleTexts(correctIntent)
          const emb = this.embDispatcher
          const teacher = this.teacher
          const cb = this.onTeacherAction
          const q = textQuery

          teacher
            .evaluate(q, wrongIntent, correctIntent, existing)
            .then((result) => {
              if (result.action === 'add') {
                emb.addExample(result.target_intent, result.normalized_text).catch(() => {
                  /* ignore embed errors */
                })
              }
              cb?.(result, q)
            })
            .catch(() => {
              /* teacher failures are non-fatal */
            })
        }
      }
    }

    return {
      text: audioOutput,
      latencyMs: ms(),
      phases: {
        stt: afterParallel,
        dispatcher: dispatcherMs,
        llm1: llm1Ms,
        toolWait,
        llm2: llm2Ms,
        tts,
        dispatcherHit: didSpeculate,
        fallbackLevel,
        outcome: outcome?.outcome ?? null,
      },
    }
  }
}
