/**
 * @module fitalyagents/dispatcher
 *
 * Intelligent task dispatcher with embedding classifier and LLM fallback.
 *
 * @example
 * ```typescript
 * import { NodeDispatcher } from 'fitalyagents/dispatcher'
 *
 * const dispatcher = new NodeDispatcher({ bus, classifier, fallbackAgent })
 * await dispatcher.start()
 * ```
 */

// Node dispatcher
export { NodeDispatcher } from './node/node-dispatcher.js'
export type { NodeDispatcherDeps } from './node/node-dispatcher.js'

// Classifier
export { InMemoryEmbeddingClassifier } from './node/classifier/in-memory-embedding-classifier.js'

// Fallback
export { InMemoryLLMFallbackAgent } from './node/fallback/in-memory-llm-fallback-agent.js'
export type { FallbackResolver } from './node/fallback/in-memory-llm-fallback-agent.js'

// Intent Library
export { InMemoryIntentLibrary } from './node/intent-library/in-memory-intent-library.js'

// Types
export type {
  IEmbeddingClassifier,
  IIntentLibrary,
  ILLMFallbackAgent,
  ClassifyResult,
  ClassifyResultConfident,
  ClassifyResultFallback,
  IntentDefinition,
  IntentMeta,
  IntentEntry,
  FallbackRequest,
  SpeechFinalEvent,
} from './types/index.js'
export {
  CONFIDENCE_THRESHOLD,
  FallbackRequestSchema,
  SpeechFinalEventSchema,
} from './types/index.js'
