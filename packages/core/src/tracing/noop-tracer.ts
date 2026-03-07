import type { ISpan, ITrace, ITracer, GenerationParams, TracerStartParams } from './types.js'

// ── NoopSpan ──────────────────────────────────────────────────────────────────

export class NoopSpan implements ISpan {
  end(_output?: Record<string, unknown>): void {}
}

// ── NoopTrace ─────────────────────────────────────────────────────────────────

export class NoopTrace implements ITrace {
  readonly traceId = 'noop'

  span(_name: string, _input?: Record<string, unknown>): ISpan {
    return new NoopSpan()
  }

  generation(_params: GenerationParams): void {}

  score(_name: string, _value: number, _comment?: string): void {}

  end(_output?: Record<string, unknown>): void {}
}

// ── NoopTracer ────────────────────────────────────────────────────────────────

/**
 * NoopTracer — default tracer. Zero overhead, no external dependencies.
 *
 * Used when no observability backend is configured.
 */
export class NoopTracer implements ITracer {
  startTrace(_name: string, _params: TracerStartParams): ITrace {
    return new NoopTrace()
  }

  async flush(): Promise<void> {}
}
