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
export {
  NodeDispatcher,
  SPECULATIVE_CONFIDENCE_MIN,
  SPECULATIVE_MARGIN_MIN,
} from './node/node-dispatcher.js'
export type {
  NodeDispatcherDeps,
  SpeculativeSafetyLevel,
  SpeculativeToolMeta,
  SpeculativeExecutor,
  IntentToolResolver,
} from './node/node-dispatcher.js'

// Classifier
export { InMemoryEmbeddingClassifier } from './node/classifier/in-memory-embedding-classifier.js'
export { LLMDirectClassifier } from './node/classifier/llm-direct-classifier.js'

// Intent Library
export { InMemoryIntentLibrary } from './node/intent-library/in-memory-intent-library.js'

// LLM
export type { LLMProvider } from './llm/types.js'
export { ClaudeLLMProvider } from './llm/claude-llm-provider.js'

// Speculative Cache (v2)
export { SpeculativeCache } from './speculative-cache.js'
export type {
  SpeculativeResult,
  SpeculativeToolResult,
  SpeculativeDraftRef,
  SpeculativeHint,
} from './speculative-cache.js'

// Intent Teacher (v2)
export { IntentTeacher } from './intent-teacher.js'
export type {
  TeacherAction,
  TeacherResult,
  TeacherEvent,
  TeacherConfig,
  ITeacherLLM,
} from './intent-teacher.js'

// Intent Score Store (v2)
export { IntentScoreStore, InMemoryScoreBackend, SCORE_THRESHOLDS } from './intent-score-store.js'
export type { ScoreEntry, ConfidenceLevel, IScoreBackend } from './intent-score-store.js'

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
  SpeechPartialEvent,
} from './types/index.js'
export {
  CONFIDENCE_THRESHOLD,
  FallbackRequestSchema,
  SpeechFinalEventSchema,
  SpeechPartialEventSchema,
} from './types/index.js'
