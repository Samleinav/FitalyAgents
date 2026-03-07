// ── Span ──────────────────────────────────────────────────────────────────────

/**
 * Represents an in-progress operation within a trace.
 */
export interface ISpan {
  /** Close the span, optionally recording output. */
  end(output?: Record<string, unknown>): void
}

// ── Trace ─────────────────────────────────────────────────────────────────────

export interface GenerationParams {
  /** Descriptive name for this generation step. */
  name: string
  /** Model identifier (e.g. 'claude-sonnet-4-6'). */
  model?: string
  /** The input sent to the model. */
  input: unknown
  /** The model's response. */
  output?: unknown
  /** Wall-clock latency in milliseconds. */
  latencyMs?: number
}

/**
 * A single end-to-end trace (one per conversation turn).
 */
export interface ITrace {
  /** Unique trace ID assigned by the tracing backend. */
  readonly traceId: string

  /**
   * Start a named child span within this trace.
   * Call `span.end()` when the operation completes.
   */
  span(name: string, input?: Record<string, unknown>): ISpan

  /**
   * Record an LLM generation event (input → output pair with latency).
   */
  generation(params: GenerationParams): void

  /**
   * Attach a numeric score to the trace (0–1 or any float).
   * Used for teacher HIT/CORRECTION signals and classifier confidence.
   */
  score(name: string, value: number, comment?: string): void

  /**
   * End the trace, optionally recording final output metadata.
   */
  end(output?: Record<string, unknown>): void
}

// ── Tracer ────────────────────────────────────────────────────────────────────

export interface TracerStartParams {
  /** Session ID — used as the Langfuse userId so traces group by session. */
  sessionId: string
  /** Initial input data (e.g. { text: user utterance }). */
  input: Record<string, unknown>
  /** Optional user ID for multi-user deployments. */
  userId?: string
}

/**
 * ITracer — injectable observability interface.
 *
 * The framework ships with a `NoopTracer` (zero overhead, no deps) and a
 * `LangfuseTracer` adapter. Bring your own Langfuse instance:
 *
 * @example
 * ```typescript
 * import Langfuse from 'langfuse'
 * import { LangfuseTracer } from 'fitalyagents'
 *
 * const tracer = new LangfuseTracer(new Langfuse({ publicKey, secretKey }))
 * const agent = new InteractionAgent({ ..., tracer })
 * ```
 */
export interface ITracer {
  /**
   * Start a new trace.
   * Returns an `ITrace` handle — call `trace.end()` when the turn is done.
   */
  startTrace(name: string, params: TracerStartParams): ITrace

  /**
   * Flush all pending traces to the backend.
   * Call on graceful shutdown.
   */
  flush(): Promise<void>
}
