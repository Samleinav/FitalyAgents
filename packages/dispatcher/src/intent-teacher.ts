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
 *  - A small fast model is enough — the task is classification, not generation.
 *  - Returns structured JSON to keep output deterministic.
 *  - LLM provider is injectable — works with any provider (Claude, OpenAI, etc.)
 *
 * @example
 * ```typescript
 * const teacher = new IntentTeacher({
 *   instructionPrompt: 'You are the QC for a retail voice assistant...',
 *   llmProvider: myLLMProvider,
 *   validIntents: ['product_search', 'product_detail', 'none'],
 * })
 *
 * const result = await teacher.evaluate('quiero tenis nike', 'none', 'product_search', [])
 * // → { action: 'add', normalized_text: 'quiero tenis nike', target_intent: 'product_search', reason: '...' }
 * ```
 */

// ── Types ──────────────────────────────────────────────────────────────────────

export type TeacherAction = 'add' | 'skip' | 'flag'

export interface TeacherResult {
  action: TeacherAction
  /** Cleaned/normalized version of the query to add as example. */
  normalized_text: string
  /** Which intent to add it to — must match a known intent. */
  target_intent: string
  /** Short explanation for logging/debugging. */
  reason: string
}

export interface TeacherEvent {
  query: string
  dispatcher_intent: string
  llm_tool: string
  result: TeacherResult
}

/**
 * Minimal LLM interface for teacher evaluations.
 * Any provider implementing this can be used.
 */
export interface ITeacherLLM {
  chat(messages: Array<{ role: 'system' | 'user' | 'assistant'; content: string }>): Promise<string>
}

/** Configuration for IntentTeacher. */
export interface TeacherConfig {
  /**
   * Business-level instruction prompt. Describe:
   *   - What the business does
   *   - What each intent means in natural terms (no tool names)
   *   - Quality criteria for good examples
   *   - Domain-specific patterns (languages, STT quirks, etc.)
   */
  instructionPrompt: string

  /**
   * LLM provider for evaluations.
   */
  llmProvider: ITeacherLLM

  /**
   * List of valid intent names. The teacher will only accept
   * target_intent values that match one of these.
   */
  validIntents: string[]
}

// ── Fixed technical instructions ──────────────────────────────────────────────

function buildFixedInstructions(validIntents: string[]): string {
  const intentList = validIntents.map((i) => `"${i}"`).join(', ')

  return `
---
TECHNICAL INSTRUCTIONS (do not override):

You are evaluating whether a user query should be added as a training example
for an embedding-based intent dispatcher.

Valid intents: ${intentList}

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
    Do NOT translate — keep original language as-is.
  - If action is "skip" or "flag", normalized_text can be the original query unchanged.
  - Prefer quality over quantity: "skip" is better than adding a redundant example.
`
}

// ── IntentTeacher ──────────────────────────────────────────────────────────────

export class IntentTeacher {
  private readonly llm: ITeacherLLM
  private readonly systemPrompt: string
  private readonly validIntents: Set<string>

  constructor(config: TeacherConfig) {
    this.llm = config.llmProvider
    this.validIntents = new Set(config.validIntents)
    this.systemPrompt =
      config.instructionPrompt.trim() + buildFixedInstructions(config.validIntents)
  }

  /**
   * Evaluate a CORRECTION event. The dispatcher predicted wrong_intent but the
   * LLM called correct_intent. Decide if the query should become a training example.
   *
   * @param query           Original user query
   * @param wrong_intent    What the dispatcher predicted (was wrong)
   * @param correct_intent  What the LLM actually determined (ground truth)
   * @param existingExamples Sample of current examples for correct_intent (for dedup)
   */
  async evaluate(
    query: string,
    wrong_intent: string,
    correct_intent: string,
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

    try {
      const raw = await this.llm.chat([
        { role: 'system', content: this.systemPrompt },
        { role: 'user', content: userMessage },
      ])

      const jsonMatch = raw.trim().match(/\{[\s\S]*\}/)
      if (!jsonMatch) return this.fallback(query, correct_intent, 'parse_error')

      const parsed = JSON.parse(jsonMatch[0]) as Partial<TeacherResult>
      if (!parsed.action || !parsed.target_intent) {
        return this.fallback(query, correct_intent, 'missing_fields')
      }

      // Validate target_intent against valid intents
      if (!this.validIntents.has(parsed.target_intent)) {
        return this.fallback(query, correct_intent, 'invalid_intent')
      }

      return {
        action: parsed.action as TeacherAction,
        normalized_text: parsed.normalized_text ?? query,
        target_intent: parsed.target_intent,
        reason: parsed.reason ?? '',
      }
    } catch {
      return this.fallback(query, correct_intent, 'llm_error')
    }
  }

  /**
   * Add an example to the classifier for a specific intent.
   * This is a convenience wrapper — the actual update is done
   * by the caller (dispatcher) who has access to the classifier.
   */
  async addExample(
    intentId: string,
    example: string,
    updater: (intentId: string, example: string) => Promise<void>,
  ): Promise<void> {
    if (!this.validIntents.has(intentId)) return
    await updater(intentId, example)
  }

  private fallback(query: string, intent: string, reason: string): TeacherResult {
    return { action: 'skip', normalized_text: query, target_intent: intent, reason }
  }
}
