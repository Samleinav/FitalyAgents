import { describe, it, expect } from 'vitest'
import { NoopTracer, NoopTrace, NoopSpan } from './noop-tracer.js'
import { LangfuseTracer } from './langfuse-tracer.js'
import type { LangfuseClientLike } from './langfuse-tracer.js'
import type { ITracer, ITrace } from './types.js'

// ── Helpers ───────────────────────────────────────────────────────────────────

function mockLangfuseClient(): { client: LangfuseClientLike; calls: Record<string, unknown[]> } {
  const calls: Record<string, unknown[]> = {
    trace: [],
    span: [],
    generation: [],
    score: [],
    spanEnd: [],
    traceUpdate: [],
    flush: [],
  }

  const spanHandle = {
    end: (params?: unknown) => calls.spanEnd.push(params),
  }

  const traceHandle = {
    id: 'trace_abc123',
    span: (params: unknown) => {
      calls.span.push(params)
      return spanHandle
    },
    generation: (params: unknown) => calls.generation.push(params),
    score: (params: unknown) => calls.score.push(params),
    update: (params: unknown) => calls.traceUpdate.push(params),
  }

  const client: LangfuseClientLike = {
    trace: (params) => {
      calls.trace.push(params)
      return traceHandle
    },
    flushAsync: async () => {
      calls.flush.push(true)
    },
  }

  return { client, calls }
}

// ── NoopTracer ────────────────────────────────────────────────────────────────

describe('NoopTracer', () => {
  it('implements ITracer', () => {
    const tracer: ITracer = new NoopTracer()
    expect(tracer).toBeDefined()
  })

  it('startTrace returns a NoopTrace', () => {
    const tracer = new NoopTracer()
    const trace = tracer.startTrace('test', { sessionId: 'ses-1', input: { text: 'hello' } })
    expect(trace).toBeInstanceOf(NoopTrace)
    expect(trace.traceId).toBe('noop')
  })

  it('span returns a NoopSpan', () => {
    const tracer = new NoopTracer()
    const trace = tracer.startTrace('test', { sessionId: 'ses-1', input: {} })
    const span = trace.span('my_span', { key: 'val' })
    expect(span).toBeInstanceOf(NoopSpan)
  })

  it('all methods are callable without error', () => {
    const tracer = new NoopTracer()
    const trace = tracer.startTrace('test', { sessionId: 'ses-1', input: { text: 'hi' } })
    const span = trace.span('op', { foo: 'bar' })
    span.end({ result: 'ok' })
    trace.generation({ name: 'llm', input: 'hello', output: 'world', latencyMs: 100 })
    trace.score('confidence', 0.95, 'high quality')
    trace.end({ latencyMs: 200 })
  })

  it('flush resolves without error', async () => {
    const tracer = new NoopTracer()
    await expect(tracer.flush()).resolves.toBeUndefined()
  })
})

// ── LangfuseTracer ────────────────────────────────────────────────────────────

describe('LangfuseTracer', () => {
  it('implements ITracer', () => {
    const { client } = mockLangfuseClient()
    const tracer: ITracer = new LangfuseTracer(client)
    expect(tracer).toBeDefined()
  })

  it('startTrace calls client.trace with name and sessionId', () => {
    const { client, calls } = mockLangfuseClient()
    const tracer = new LangfuseTracer(client)

    tracer.startTrace('speech_turn', {
      sessionId: 'ses-1',
      input: { text: 'hola' },
      userId: 'user_abc',
    })

    expect(calls.trace).toHaveLength(1)
    expect(calls.trace[0]).toMatchObject({
      name: 'speech_turn',
      sessionId: 'ses-1',
      userId: 'user_abc',
      input: { text: 'hola' },
    })
  })

  it('traceId comes from handle.id', () => {
    const { client } = mockLangfuseClient()
    const tracer = new LangfuseTracer(client)
    const trace: ITrace = tracer.startTrace('test', { sessionId: 's', input: {} })
    expect(trace.traceId).toBe('trace_abc123')
  })

  it('span() calls handle.span and returns ISpan', () => {
    const { client, calls } = mockLangfuseClient()
    const tracer = new LangfuseTracer(client)
    const trace = tracer.startTrace('test', { sessionId: 's', input: {} })

    const span = trace.span('llm_call', { model: 'claude' })
    expect(calls.span).toHaveLength(1)
    expect(calls.span[0]).toMatchObject({ name: 'llm_call', input: { model: 'claude' } })

    span.end({ tokens: 42 })
    expect(calls.spanEnd).toHaveLength(1)
    expect(calls.spanEnd[0]).toMatchObject({ output: { tokens: 42 } })
  })

  it('generation() calls handle.generation', () => {
    const { client, calls } = mockLangfuseClient()
    const tracer = new LangfuseTracer(client)
    const trace = tracer.startTrace('test', { sessionId: 's', input: {} })

    trace.generation({
      name: 'interaction_llm',
      model: 'claude-sonnet-4-6',
      input: [{ role: 'user', content: 'hi' }],
      output: 'hello!',
      latencyMs: 350,
    })

    expect(calls.generation).toHaveLength(1)
    const gen = calls.generation[0] as Record<string, unknown>
    expect(gen.name).toBe('interaction_llm')
    expect(gen.model).toBe('claude-sonnet-4-6')
    expect(gen.input).toEqual([{ role: 'user', content: 'hi' }])
    expect(gen.output).toBe('hello!')
  })

  it('score() calls handle.score', () => {
    const { client, calls } = mockLangfuseClient()
    const tracer = new LangfuseTracer(client)
    const trace = tracer.startTrace('test', { sessionId: 's', input: {} })

    trace.score('classifier_hit', 1, 'confident')

    expect(calls.score).toHaveLength(1)
    expect(calls.score[0]).toMatchObject({ name: 'classifier_hit', value: 1, comment: 'confident' })
  })

  it('end() with output calls handle.update', () => {
    const { client, calls } = mockLangfuseClient()
    const tracer = new LangfuseTracer(client)
    const trace = tracer.startTrace('test', { sessionId: 's', input: {} })

    trace.end({ latencyMs: 500 })

    expect(calls.traceUpdate).toHaveLength(1)
    expect(calls.traceUpdate[0]).toMatchObject({ output: { latencyMs: 500 } })
  })

  it('end() without output does not call update', () => {
    const { client, calls } = mockLangfuseClient()
    const tracer = new LangfuseTracer(client)
    const trace = tracer.startTrace('test', { sessionId: 's', input: {} })

    trace.end()

    expect(calls.traceUpdate).toHaveLength(0)
  })

  it('flush() calls client.flushAsync', async () => {
    const { client, calls } = mockLangfuseClient()
    const tracer = new LangfuseTracer(client)

    await tracer.flush()

    expect(calls.flush).toHaveLength(1)
  })
})

// ── Integration: InteractionAgent-like trace flow ─────────────────────────────

describe('trace flow (InteractionAgent pattern)', () => {
  it('full turn trace: start → span → generation → score → end', () => {
    const { client, calls } = mockLangfuseClient()
    const tracer = new LangfuseTracer(client)

    const trace = tracer.startTrace('speech_turn', {
      sessionId: 'ses-1',
      input: { text: 'busco tenis Nike' },
    })

    const llmSpan = trace.span('llm_stream', { toolCount: 3 })
    const toolSpan = trace.span('tool_product_search', { query: 'tenis Nike' })
    toolSpan.end({ type: 'executed' })
    llmSpan.end({ textChunks: 2, toolResults: 1 })

    trace.generation({
      name: 'interaction_llm',
      input: [{ role: 'user', content: 'busco tenis Nike' }],
      output: 'Encontré 5 modelos de Nike',
      latencyMs: 420,
    })

    trace.end({ latencyMs: 550 })

    expect(calls.span).toHaveLength(2)
    expect(calls.spanEnd).toHaveLength(2)
    expect(calls.generation).toHaveLength(1)
    expect(calls.traceUpdate).toHaveLength(1)
  })

  it('dispatcher trace: hit path scores classifier_hit=1', () => {
    const { client, calls } = mockLangfuseClient()
    const tracer = new LangfuseTracer(client)

    const trace = tracer.startTrace('dispatcher_classify', {
      sessionId: 'ses-1',
      input: { text: 'busco tenis' },
    })
    trace.score('classifier_confidence', 0.92)
    trace.score('classifier_hit', 1)
    trace.end({ intent_id: 'product_search', outcome: 'hit' })

    const scores = calls.score as Array<{ name: string; value: number }>
    expect(scores.find((s) => s.name === 'classifier_hit')?.value).toBe(1)
    expect(scores.find((s) => s.name === 'classifier_confidence')?.value).toBe(0.92)
  })

  it('dispatcher trace: fallback path scores classifier_hit=0', () => {
    const { client, calls } = mockLangfuseClient()
    const tracer = new LangfuseTracer(client)

    const trace = tracer.startTrace('dispatcher_classify', {
      sessionId: 'ses-1',
      input: { text: 'hmm no sé' },
    })
    trace.score('classifier_confidence', 0.45)
    trace.score('classifier_hit', 0, 'fell back to LLM')
    trace.end({ outcome: 'fallback' })

    const scores = calls.score as Array<{ name: string; value: number }>
    expect(scores.find((s) => s.name === 'classifier_hit')?.value).toBe(0)
  })
})
