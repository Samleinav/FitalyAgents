/**
 * IntentTeacher — LLM-driven active learning for the embedding dispatcher.
 *
 * After each CORRECTION event (dispatcher guessed wrong) the teacher evaluates
 * whether the misclassified query should become a new training example.
 * The teacher is guided by a developer-supplied instruction prompt that
 * describes the business and what each intent means in natural language.
 *
 * Design principles:
 *  - Teacher NEVER infers intents from tool names, IDs, or implementation details.
 *    All intent knowledge comes from the instruction prompt alone.
 *  - Runs asynchronously (fire & forget) — never in the critical user request path.
 *  - A small fast model (haiku, gpt-4o-mini) is enough — the task is classification,
 *    not generation.
 *  - Returns structured JSON to keep output deterministic.
 */

import { OpenRouterProvider, type ChatMessage } from './openrouter-provider.js'
import type { Intent } from './dispatcher.js'

// ─── Types ────────────────────────────────────────────────────────────────────

export type TeacherAction = 'add' | 'skip' | 'flag'

export interface TeacherResult {
  action: TeacherAction
  /** Cleaned/normalized version of the query to add as example. */
  normalized_text: string
  /** Which intent to add it to — must match a known intent name. */
  target_intent: Intent
  /** Short explanation for logging/debugging. */
  reason: string
}

export interface TeacherEvent {
  query: string
  dispatcher_intent: Intent // what dispatcher guessed (was wrong)
  llm_tool: string // what LLM actually called (the correct intent)
  result: TeacherResult
}

// ─── Fixed technical instructions ─────────────────────────────────────────────
// Appended to the developer's instruction prompt. Defines the output format
// and rules that MUST NOT be overridden by the business prompt.

const FIXED_INSTRUCTIONS = `
---
TECHNICAL INSTRUCTIONS (do not override):

You are evaluating whether a user query should be added as a training example
for an embedding-based intent dispatcher.

Valid intents: "product_search", "product_detail", "none"

Return ONLY a single JSON object — no markdown, no extra text:
{
  "action": "add" | "skip" | "flag",
  "normalized_text": "<cleaned query to use as example>",
  "target_intent": "<exact intent name>",
  "reason": "<one sentence explanation>"
}

Action meanings:
  add  — query clearly represents the target_intent, is distinct from existing examples
  skip — query is ambiguous, too similar to existing examples, or not useful as a standalone example
  flag — query reveals an edge case that needs human review (new intent? unusual phrasing?)

Rules:
  - NEVER infer intent from tool names, product IDs, or technical implementation details.
    Base every decision exclusively on what the customer is trying to accomplish.
  - normalized_text must be a natural, clean phrasing. Fix obvious STT noise if present.
    Do NOT translate — keep original language (Spanish/English/mixed as-is).
  - If action is "skip" or "flag", normalized_text can be the original query unchanged.
  - Prefer quality over quantity: "skip" is better than adding a redundant example.
`

// ─── IntentTeacher ────────────────────────────────────────────────────────────

export interface TeacherConfig {
  /**
   * Business-level instruction prompt. Describe:
   *   - What the business does
   *   - What each intent means in natural terms (no tool names)
   *   - Quality criteria for good examples
   *   - Domain-specific patterns (languages, STT quirks, etc.)
   *
   * This is the ONLY source of intent knowledge for the teacher.
   * Do not mention tool IDs, function names, or implementation details here.
   */
  instructionPrompt: string

  /**
   * LLM model to use for teacher evaluations.
   * A fast, inexpensive model is recommended — the task is classification.
   * Examples: 'anthropic/claude-haiku-3-5', 'openai/gpt-4o-mini'
   * Default: 'openai/gpt-4o-mini'
   */
  model?: string
}

export class IntentTeacher {
  private llm: OpenRouterProvider
  private systemPrompt: string
  private model: string

  constructor(config: TeacherConfig) {
    this.llm = new OpenRouterProvider()
    this.model = config.model ?? 'openai/gpt-4o-mini'
    // Business instructions + fixed technical format
    this.systemPrompt = config.instructionPrompt.trim() + FIXED_INSTRUCTIONS
  }

  /**
   * Evaluate a CORRECTION event. The dispatcher predicted wrong_intent but the
   * LLM called correct_tool. Decide if the query should become a training example.
   *
   * @param query           Original user query
   * @param wrong_intent    What the dispatcher speculated (was wrong)
   * @param correct_intent  What the LLM actually used (the ground truth)
   * @param existingExamples Sample of current examples for correct_intent (for dedup)
   */
  async evaluate(
    query: string,
    wrong_intent: Intent,
    correct_intent: Intent,
    existingExamples: string[],
  ): Promise<TeacherResult> {
    const examplesBlock =
      existingExamples.length > 0
        ? `\nSample existing examples for "${correct_intent}":\n${existingExamples.map((e) => `  - "${e}"`).join('\n')}`
        : ''

    const userMessage = [
      `User query: "${query}"`,
      `Dispatcher predicted: "${wrong_intent}" (incorrect)`,
      `LLM determined correct intent: "${correct_intent}"`,
      examplesBlock,
      `\nShould this query be added as a training example for "${correct_intent}"?`,
    ].join('\n')

    const messages: ChatMessage[] = [
      { role: 'system', content: this.systemPrompt },
      { role: 'user', content: userMessage },
    ]

    try {
      const { response } = await this.llm.chat(messages, undefined, this.model)
      const raw = response?.content?.trim() ?? ''
      const jsonMatch = raw.match(/\{[\s\S]*\}/)
      if (!jsonMatch) return this._fallback(query, correct_intent, 'parse_error')

      const parsed = JSON.parse(jsonMatch[0]) as Partial<TeacherResult>
      if (!parsed.action || !parsed.target_intent) {
        return this._fallback(query, correct_intent, 'missing_fields')
      }

      return {
        action: parsed.action as TeacherAction,
        normalized_text: parsed.normalized_text ?? query,
        target_intent: parsed.target_intent as Intent,
        reason: parsed.reason ?? '',
      }
    } catch {
      return this._fallback(query, correct_intent, 'llm_error')
    }
  }

  private _fallback(query: string, intent: Intent, reason: string): TeacherResult {
    return { action: 'skip', normalized_text: query, target_intent: intent, reason }
  }
}

// ─── Default instruction prompt for the retail demo ───────────────────────────
// Developers replace this with their own business context.

export const RETAIL_TEACHER_PROMPT = `
You are the Intent Quality Controller for a retail voice assistant.

Business context:
  A store that sells footwear, clothing, and accessories.
  Customers interact via voice — queries may be in Spanish, English, or mixed.
  Speech-to-text errors are common (e.g., "tenis" may arrive as "tennis", digit
  words like "cero cero uno" instead of "001").

Intent definitions (base your decisions ONLY on these — ignore any technical labels):

  product_search:
    The customer wants to BROWSE, FIND, or COMPARE products.
    They may mention a category (zapatos, camisas, tenis), a brand, a color, a size,
    a budget, or express a general desire to see what's available.
    They do NOT have a specific item already in mind.
    Examples of this intent: "¿tienes tenis?", "show me Nike shoes",
    "busco algo para correr", "qué ropa tienen para mujer".

  product_detail:
    The customer wants information about ONE SPECIFIC product they already know.
    Typically referenced by a code or described very precisely.
    Includes questions about price, stock, description, or availability of that item.
    Examples: "¿cuánto cuesta el dos?", "stock del producto P001",
    "dame detalles del P-cero-cero-dos", "¿tienen disponible el primero?".

  none:
    Greetings, questions about the store itself (hours, returns, policies),
    general chitchat, complaints, or anything that does not fit the above two.
    Examples: "hola", "buenos días", "¿a qué hora cierran?",
    "¿tienen delivery?", "me puedes ayudar?".

Quality criteria for examples:
  - Must be a natural customer utterance, not a keyword or metadata
  - Should be distinct from existing examples (different phrasing / vocabulary)
  - Spanish and English phrasings are both valuable
  - STT-realistic phrasings (informal, incomplete sentences) are preferred
  - Avoid examples that could reasonably fit two intents
`.trim()
