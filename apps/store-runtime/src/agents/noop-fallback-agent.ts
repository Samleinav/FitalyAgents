import type { ILLMFallbackAgent } from '@fitalyagents/dispatcher'

/**
 * Fallback agent stub for NodeDispatcher.
 * Low-confidence utterances (not matched by RetailKeywordClassifier) are
 * handled directly by InteractionRuntimeAgent via its SPEECH_FINAL handler,
 * so no second LLM call is needed here.
 */
export class NoopFallbackAgent implements ILLMFallbackAgent {
  start(): void {}
  dispose(): void {}
}
