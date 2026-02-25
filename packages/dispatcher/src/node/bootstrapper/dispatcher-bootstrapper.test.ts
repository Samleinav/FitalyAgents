import { describe, it, expect, beforeEach } from 'vitest'
import { DispatcherBootstrapper } from './dispatcher-bootstrapper.js'
import { InMemoryIntentLibrary } from '../intent-library/in-memory-intent-library.js'
import type { LLMProvider } from '../../llm/types.js'
import type { AgentManifest } from 'fitalyagents'

// ── Test doubles ──────────────────────────────────────────────────────────────

function makeManifest(overrides: Partial<AgentManifest> = {}): AgentManifest {
  return {
    agent_id: 'work-agent',
    description: 'Handles product search and price queries',
    version: '1.0.0',
    domain: 'customer_facing',
    scope: 'commerce',
    capabilities: ['PRODUCT_SEARCH', 'PRICE_QUERY'],
    context_mode: 'stateful',
    context_access: { read: ['*'], write: ['last_action'], forbidden: [] },
    async_tools: ['product_search', 'price_check'],
    input_channel: 'queue:work-agent:inbox',
    output_channel: 'queue:work-agent:outbox',
    priority: 5,
    max_concurrent: 10,
    timeout_ms: 8000,
    heartbeat_interval_ms: 3000,
    role: null,
    accepts_from: ['*'],
    requires_human_approval: false,
    ...overrides,
  }
}

/**
 * Mock LLMProvider that returns a valid JSON response.
 */
function makeMockLLM(examples?: string[]): LLMProvider {
  return {
    async complete(_system: string, user: string) {
      // Extract intent_id from the user prompt
      const match = /Intent ID: (\S+)/.exec(user)
      const intentId = match?.[1] ?? 'unknown'
      const exs = examples ?? [
        `find ${intentId}`,
        `search for ${intentId}`,
        `I want ${intentId}`,
        `show me ${intentId}`,
        `looking for ${intentId}`,
        `get ${intentId}`,
        `need ${intentId}`,
        `buy ${intentId}`,
      ]
      return JSON.stringify({ intent_id: intentId, examples: exs })
    },
  }
}

// ── Tests ─────────────────────────────────────────────────────────────────────

describe('DispatcherBootstrapper', () => {
  let intentLibrary: InMemoryIntentLibrary

  beforeEach(() => {
    intentLibrary = new InMemoryIntentLibrary()
  })

  // ── bootstrapFromManifests ───────────────────────────────────────────

  describe('bootstrapFromManifests()', () => {
    it('creates intents for each capability in the manifest', async () => {
      const bootstrapper = new DispatcherBootstrapper({
        intentLibrary,
        llm: makeMockLLM(),
      })

      await bootstrapper.bootstrapFromManifests([makeManifest()])

      const ids = await intentLibrary.listIntentIds()
      expect(ids).toContain('product_search')
      expect(ids).toContain('price_query')
    })

    it('sets domain and scope from manifest', async () => {
      const bootstrapper = new DispatcherBootstrapper({
        intentLibrary,
        llm: makeMockLLM(),
      })

      await bootstrapper.bootstrapFromManifests([makeManifest()])

      const meta = await intentLibrary.getMeta('product_search')
      expect(meta?.domain_required).toBe('customer_facing')
      expect(meta?.scope_hint).toBe('commerce')
      expect(meta?.capabilities_required).toEqual(['PRODUCT_SEARCH'])
    })

    it('saves generated examples to the library', async () => {
      const customExamples = [
        'find shoes',
        'search sneakers',
        'show me products',
        'I need boots',
        'looking for sandals',
        'get me running shoes',
        'buy red sneakers',
        'browse footwear',
      ]

      const bootstrapper = new DispatcherBootstrapper({
        intentLibrary,
        llm: makeMockLLM(customExamples),
      })

      await bootstrapper.bootstrapFromManifests([
        makeManifest({ capabilities: ['PRODUCT_SEARCH'] }),
      ])

      const examples = await intentLibrary.getExamples('product_search')
      expect(examples).toHaveLength(customExamples.length)
      expect(examples[0]).toBe('find shoes')
    })

    it('handles multiple manifests without conflict', async () => {
      const bootstrapper = new DispatcherBootstrapper({
        intentLibrary,
        llm: makeMockLLM(),
      })

      await bootstrapper.bootstrapFromManifests([
        makeManifest({ agent_id: 'work-agent', capabilities: ['PRODUCT_SEARCH'] }),
        makeManifest({ agent_id: 'order-agent', capabilities: ['ORDER_CREATE', 'ORDER_STATUS'] }),
      ])

      const ids = await intentLibrary.listIntentIds()
      expect(ids).toContain('product_search')
      expect(ids).toContain('order_create')
      expect(ids).toContain('order_status')
    })

    it('enriches existing intents with more examples instead of overwriting', async () => {
      // First bootstrap: creates intent
      const bootstrapper = new DispatcherBootstrapper({
        intentLibrary,
        llm: makeMockLLM([
          'initial example 1',
          'initial example 2',
          'initial example 3',
          'initial example 4',
          'initial example 5',
          'initial example 6',
          'initial example 7',
          'initial example 8',
        ]),
      })
      await bootstrapper.bootstrapFromManifests([
        makeManifest({ capabilities: ['PRODUCT_SEARCH'] }),
      ])

      const beforeCount = (await intentLibrary.getExamples('product_search')).length

      // Second bootstrap: adds more examples
      const bootstrapper2 = new DispatcherBootstrapper({
        intentLibrary,
        llm: makeMockLLM([
          'new example 1',
          'new example 2',
          'new example 3',
          'new example 4',
          'new example 5',
          'new example 6',
          'new example 7',
          'new example 8',
        ]),
      })
      await bootstrapper2.bootstrapFromManifests([
        makeManifest({ capabilities: ['PRODUCT_SEARCH'] }),
      ])

      const afterCount = (await intentLibrary.getExamples('product_search')).length
      expect(afterCount).toBeGreaterThan(beforeCount)
    })

    it('converts UPPER_CASE capabilities to snake_case intent IDs', async () => {
      const bootstrapper = new DispatcherBootstrapper({
        intentLibrary,
        llm: makeMockLLM(),
      })

      await bootstrapper.bootstrapFromManifests([
        makeManifest({ capabilities: ['ORDER_CREATE', 'REFUND_PROCESS', 'catalog_search'] }),
      ])

      const ids = await intentLibrary.listIntentIds()
      expect(ids).toContain('order_create')
      expect(ids).toContain('refund_process')
      expect(ids).toContain('catalog_search')
    })
  })

  // ── bootstrapFromRegistry ────────────────────────────────────────────

  describe('bootstrapFromRegistry()', () => {
    it('reads manifests from the registry and creates intents', async () => {
      const bootstrapper = new DispatcherBootstrapper({
        intentLibrary,
        llm: makeMockLLM(),
      })

      // Minimal registry mock
      const registry = {
        async list() {
          return [makeManifest({ capabilities: ['CATALOG_SEARCH'] })]
        },
      }

      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      await bootstrapper.bootstrapFromRegistry(registry as any)

      const ids = await intentLibrary.listIntentIds()
      expect(ids).toContain('catalog_search')
    })
  })

  // ── error handling ───────────────────────────────────────────────────

  describe('error handling', () => {
    it('throws a descriptive error when LLM returns invalid JSON', async () => {
      const badLLM: LLMProvider = {
        async complete() {
          return 'This is not JSON at all!'
        },
      }
      const bootstrapper = new DispatcherBootstrapper({ intentLibrary, llm: badLLM })

      await expect(
        bootstrapper.bootstrapFromManifests([makeManifest({ capabilities: ['PRODUCT_SEARCH'] })]),
      ).rejects.toThrow('DispatcherBootstrapper: failed to parse LLM response')
    })
  })
})
