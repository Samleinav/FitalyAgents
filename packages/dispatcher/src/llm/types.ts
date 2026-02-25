/**
 * Minimal interface for an LLM provider.
 * Implement this to use any LLM with the FitalyAgents dispatcher.
 *
 * @example
 * ```typescript
 * // Use the built-in Claude provider:
 * import { ClaudeLLMProvider } from 'fitalyagents/dispatcher'
 * const llm = new ClaudeLLMProvider({ apiKey: process.env.ANTHROPIC_API_KEY })
 *
 * // Or bring your own:
 * const llm: LLMProvider = {
 *   async complete(system, user) {
 *     return openai.chat.completions.create({ ... }).choices[0].message.content
 *   }
 * }
 * ```
 */
export interface LLMProvider {
  /**
   * Send a prompt to the LLM and return the text response.
   *
   * @param system - System prompt (instructions for the model)
   * @param user   - User message (the actual query)
   * @returns The model's response as a plain string
   */
  complete(system: string, user: string): Promise<string>
}
