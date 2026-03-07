import type { ISpan, ITrace, ITracer, GenerationParams, TracerStartParams } from './types.js'

// ── Minimal Langfuse duck-type interfaces ─────────────────────────────────────
// These mirror the Langfuse SDK API without importing `langfuse`.
// Users pass their own `new Langfuse({ publicKey, secretKey })` instance.

interface LangfuseSpanHandle {
  end(params?: { output?: unknown }): void
}

interface LangfuseTraceHandle {
  id: string
  span(params: { name: string; input?: unknown }): LangfuseSpanHandle
  generation(params: {
    name: string
    model?: string
    input: unknown
    output?: unknown
    completionStartTime?: Date
  }): void
  score(params: { name: string; value: number; comment?: string }): void
  update(params: { output?: unknown }): void
}

export interface LangfuseClientLike {
  trace(params: {
    name: string
    userId?: string
    sessionId?: string
    input?: unknown
  }): LangfuseTraceHandle
  flushAsync(): Promise<void>
}

// ── LangfuseSpan ─────────────────────────────────────────────────────────────

class LangfuseSpan implements ISpan {
  constructor(private readonly handle: LangfuseSpanHandle) {}

  end(output?: Record<string, unknown>): void {
    this.handle.end({ output })
  }
}

// ── LangfuseTrace ────────────────────────────────────────────────────────────

class LangfuseTrace implements ITrace {
  readonly traceId: string

  constructor(private readonly handle: LangfuseTraceHandle) {
    this.traceId = handle.id
  }

  span(name: string, input?: Record<string, unknown>): ISpan {
    return new LangfuseSpan(this.handle.span({ name, input }))
  }

  generation(params: GenerationParams): void {
    this.handle.generation({
      name: params.name,
      model: params.model,
      input: params.input,
      output: params.output,
      ...(params.latencyMs !== undefined
        ? { completionStartTime: new Date(Date.now() - params.latencyMs) }
        : {}),
    })
  }

  score(name: string, value: number, comment?: string): void {
    this.handle.score({ name, value, comment })
  }

  end(output?: Record<string, unknown>): void {
    if (output) {
      this.handle.update({ output })
    }
  }
}

// ── LangfuseTracer ────────────────────────────────────────────────────────────

/**
 * LangfuseTracer — wraps a Langfuse client instance to implement `ITracer`.
 *
 * Does NOT import `langfuse` directly — pass your own instance so the
 * framework has zero Langfuse dependencies.
 *
 * @example
 * ```typescript
 * import Langfuse from 'langfuse'
 * import { LangfuseTracer, InteractionAgent } from 'fitalyagents'
 *
 * const tracer = new LangfuseTracer(
 *   new Langfuse({ publicKey: process.env.LANGFUSE_PUBLIC_KEY!, secretKey: process.env.LANGFUSE_SECRET_KEY! })
 * )
 * const agent = new InteractionAgent({ ..., tracer })
 *
 * // On shutdown:
 * await tracer.flush()
 * ```
 */
export class LangfuseTracer implements ITracer {
  constructor(private readonly client: LangfuseClientLike) {}

  startTrace(name: string, params: TracerStartParams): ITrace {
    const handle = this.client.trace({
      name,
      userId: params.userId,
      sessionId: params.sessionId,
      input: params.input,
    })
    return new LangfuseTrace(handle)
  }

  async flush(): Promise<void> {
    await this.client.flushAsync()
  }
}
