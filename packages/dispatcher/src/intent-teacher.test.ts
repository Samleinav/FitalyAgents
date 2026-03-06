import { describe, it, expect, vi } from 'vitest'
import { IntentTeacher } from './intent-teacher.js'
import type { ITeacherLLM } from './intent-teacher.js'

// ── Mock LLM ─────────────────────────────────────────────────────────────────

function createMockLLM(response: string): ITeacherLLM {
  return {
    chat: vi.fn().mockResolvedValue(response),
  }
}

function createMockLLMFailing(): ITeacherLLM {
  return {
    chat: vi.fn().mockRejectedValue(new Error('LLM unavailable')),
  }
}

const VALID_INTENTS = ['product_search', 'product_detail', 'none']

function makeTeacher(llm: ITeacherLLM): IntentTeacher {
  return new IntentTeacher({
    instructionPrompt: 'You are the QC for a retail voice assistant.',
    llmProvider: llm,
    validIntents: VALID_INTENTS,
  })
}

describe('IntentTeacher', () => {
  // ── evaluate() — happy path ────────────────────────────────────────

  describe('evaluate()', () => {
    it('returns "add" when LLM says query belongs to correct intent', async () => {
      const llm = createMockLLM(
        JSON.stringify({
          action: 'add',
          normalized_text: 'quiero ver tenis nike',
          target_intent: 'product_search',
          reason: 'Clear product browsing intent',
        }),
      )

      const teacher = makeTeacher(llm)
      const result = await teacher.evaluate('quiero ver tenis nike', 'none', 'product_search', [])

      expect(result.action).toBe('add')
      expect(result.target_intent).toBe('product_search')
      expect(result.normalized_text).toBe('quiero ver tenis nike')
    })

    it('returns "skip" when query is ambiguous', async () => {
      const llm = createMockLLM(
        JSON.stringify({
          action: 'skip',
          normalized_text: 'dame eso',
          target_intent: 'product_search',
          reason: 'Too ambiguous, could be a reference to previous context',
        }),
      )

      const teacher = makeTeacher(llm)
      const result = await teacher.evaluate('dame eso', 'none', 'product_search', [
        'quiero tenis',
        'busco zapatos',
      ])

      expect(result.action).toBe('skip')
    })

    it('returns "flag" for edge cases needing human review', async () => {
      const llm = createMockLLM(
        JSON.stringify({
          action: 'flag',
          normalized_text: 'quiero devolver estos zapatos',
          target_intent: 'none',
          reason: 'Possible new intent: returns/refunds',
        }),
      )

      const teacher = makeTeacher(llm)
      const result = await teacher.evaluate(
        'quiero devolver estos zapatos',
        'product_search',
        'none',
        [],
      )

      expect(result.action).toBe('flag')
    })

    it('passes existing examples in the prompt for dedup', async () => {
      const llm = createMockLLM(
        JSON.stringify({
          action: 'skip',
          normalized_text: 'quiero tenis',
          target_intent: 'product_search',
          reason: 'Too similar to existing example',
        }),
      )

      const teacher = makeTeacher(llm)
      await teacher.evaluate('quiero tenis', 'none', 'product_search', [
        'busco tenis',
        'quiero zapatos',
      ])

      // Verify the LLM received the existing examples in the prompt
      const chatCall = (llm.chat as ReturnType<typeof vi.fn>).mock.calls[0]
      const userMessage = chatCall[0][1].content as string
      expect(userMessage).toContain('busco tenis')
      expect(userMessage).toContain('quiero zapatos')
    })
  })

  // ── evaluate() — error handling ────────────────────────────────────

  describe('error handling', () => {
    it('falls back to skip on LLM error', async () => {
      const llm = createMockLLMFailing()
      const teacher = makeTeacher(llm)

      const result = await teacher.evaluate('quiero tenis', 'none', 'product_search', [])

      expect(result.action).toBe('skip')
      expect(result.reason).toBe('llm_error')
    })

    it('falls back to skip on non-JSON response', async () => {
      const llm = createMockLLM('I think this is a product search query')
      const teacher = makeTeacher(llm)

      const result = await teacher.evaluate('quiero tenis', 'none', 'product_search', [])

      expect(result.action).toBe('skip')
      expect(result.reason).toBe('parse_error')
    })

    it('falls back to skip on missing fields', async () => {
      const llm = createMockLLM(
        JSON.stringify({
          action: 'add',
          // missing target_intent
        }),
      )

      const teacher = makeTeacher(llm)
      const result = await teacher.evaluate('quiero tenis', 'none', 'product_search', [])

      expect(result.action).toBe('skip')
      expect(result.reason).toBe('missing_fields')
    })

    it('falls back to skip on invalid intent name', async () => {
      const llm = createMockLLM(
        JSON.stringify({
          action: 'add',
          normalized_text: 'test',
          target_intent: 'invented_intent',
          reason: 'test',
        }),
      )

      const teacher = makeTeacher(llm)
      const result = await teacher.evaluate('test query', 'none', 'product_search', [])

      expect(result.action).toBe('skip')
      expect(result.reason).toBe('invalid_intent')
    })

    it('extracts JSON from markdown-wrapped response', async () => {
      const llm = createMockLLM(
        `Here's my analysis:\n\`\`\`json\n${JSON.stringify({
          action: 'add',
          normalized_text: 'busco zapatillas',
          target_intent: 'product_search',
          reason: 'Clear search intent',
        })}\n\`\`\``,
      )

      const teacher = makeTeacher(llm)
      const result = await teacher.evaluate('busco zapatillas', 'none', 'product_search', [])

      expect(result.action).toBe('add')
      expect(result.target_intent).toBe('product_search')
    })
  })

  // ── addExample() ───────────────────────────────────────────────────

  describe('addExample()', () => {
    it('calls updater for valid intents', async () => {
      const llm = createMockLLM('')
      const teacher = makeTeacher(llm)
      const updater = vi.fn().mockResolvedValue(undefined)

      await teacher.addExample('product_search', 'busco Nike Air', updater)

      expect(updater).toHaveBeenCalledWith('product_search', 'busco Nike Air')
    })

    it('does not call updater for invalid intents', async () => {
      const llm = createMockLLM('')
      const teacher = makeTeacher(llm)
      const updater = vi.fn().mockResolvedValue(undefined)

      await teacher.addExample('fake_intent', 'test', updater)

      expect(updater).not.toHaveBeenCalled()
    })
  })

  // ── system prompt construction ─────────────────────────────────────

  describe('system prompt', () => {
    it('includes valid intents list in the prompt', async () => {
      const llm = createMockLLM(
        JSON.stringify({
          action: 'skip',
          normalized_text: 'test',
          target_intent: 'none',
          reason: 'test',
        }),
      )

      const teacher = makeTeacher(llm)
      await teacher.evaluate('test', 'none', 'product_search', [])

      const chatCall = (llm.chat as ReturnType<typeof vi.fn>).mock.calls[0]
      const systemMessage = chatCall[0][0].content as string

      expect(systemMessage).toContain('"product_search"')
      expect(systemMessage).toContain('"product_detail"')
      expect(systemMessage).toContain('"none"')
    })

    it('includes business instruction prompt', async () => {
      const llm = createMockLLM(
        JSON.stringify({
          action: 'skip',
          normalized_text: 'test',
          target_intent: 'none',
          reason: 'test',
        }),
      )

      const teacher = makeTeacher(llm)
      await teacher.evaluate('test', 'none', 'product_search', [])

      const chatCall = (llm.chat as ReturnType<typeof vi.fn>).mock.calls[0]
      const systemMessage = chatCall[0][0].content as string

      expect(systemMessage).toContain('retail voice assistant')
    })
  })
})
