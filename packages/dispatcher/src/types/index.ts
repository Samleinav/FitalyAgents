import { z } from 'zod'

// ── Classify result ─────────────────────────────────────────────────────────

export const CONFIDENCE_THRESHOLD = 0.85

export interface ClassifyResultConfident {
  type: 'confident'
  intent_id: string
  confidence: number
  domain_required: string
  scope_hint: string
  capabilities_required: string[]
  candidates: Array<{ intent_id: string; score: number }>
}

export interface ClassifyResultFallback {
  type: 'fallback'
  confidence: number
  top_candidates: Array<{ intent_id: string; score: number }>
}

export type ClassifyResult = ClassifyResultConfident | ClassifyResultFallback

// ── Intent library types ────────────────────────────────────────────────────

export interface IntentDefinition {
  intent_id: string
  domain_required: string
  scope_hint: string
  capabilities_required: string[]
  initial_examples: string[]
}

export interface IntentMeta {
  intent_id: string
  domain_required: string
  scope_hint: string
  capabilities_required: string[]
}

export interface IntentEntry {
  embedding: Float32Array
  meta: IntentMeta
}

// ── Fallback types ──────────────────────────────────────────────────────────

export const FallbackRequestSchema = z.object({
  event: z.literal('DISPATCH_FALLBACK'),
  session_id: z.string(),
  text: z.string(),
  classifier_confidence: z.number(),
  top_candidates: z.array(
    z.object({
      intent_id: z.string(),
      score: z.number(),
    }),
  ),
  timestamp: z.number(),
})
export type FallbackRequest = z.infer<typeof FallbackRequestSchema>

export const SpeechFinalEventSchema = z.object({
  event: z.literal('SPEECH_FINAL'),
  session_id: z.string(),
  text: z.string(),
  locale: z.string().optional(),
  timestamp: z.number(),
})
export type SpeechFinalEvent = z.infer<typeof SpeechFinalEventSchema>

// ── Classifier interface ────────────────────────────────────────────────────

export interface IEmbeddingClassifier {
  init(): Promise<void>
  classify(text: string): Promise<ClassifyResult>
  reloadIntent(intentId: string): Promise<void>
  dispose(): void
}

// ── Intent library interface ────────────────────────────────────────────────

export interface IIntentLibrary {
  createIntent(def: IntentDefinition): Promise<void>
  addExample(intentId: string, example: string): Promise<void>
  getExamples(intentId: string): Promise<string[]>
  getMeta(intentId: string): Promise<IntentMeta | null>
  hasIntentForCapability(capability: string): Promise<boolean>
  listIntentIds(): Promise<string[]>
}

// ── Fallback agent interface ────────────────────────────────────────────────

export interface ILLMFallbackAgent {
  start(): void
  dispose(): void
}
