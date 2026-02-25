import type { AgentManifest, IEventBus } from 'fitalyagents'
import type { AgentRegistry } from 'fitalyagents'
import type { IIntentLibrary, IntentDefinition } from '../../types/index.js'
import type { LLMProvider } from '../../llm/types.js'

export interface BootstrapOptions {
  intentLibrary: IIntentLibrary
  llm: LLMProvider
  bus?: IEventBus
  /**
   * Number of example utterances to generate per capability.
   * More examples improve classifier accuracy. Default: 8.
   */
  examplesPerCapability?: number
}

interface GeneratedIntent {
  intent_id: string
  examples: string[]
}

/**
 * DispatcherBootstrapper — automatically generates intent training data
 * from agent manifests by calling an LLM.
 *
 * Instead of hand-writing intent definitions and example utterances,
 * point the bootstrapper at your registered agents and it will:
 * 1. Read each agent's manifest (capabilities, scope, domain, description)
 * 2. Ask the LLM to generate realistic user utterances for each capability
 * 3. Create `IntentDefinition` entries in the intent library
 * 4. Optionally publish `bus:INTENT_UPDATED` for hot-reload
 *
 * @example
 * ```typescript
 * import { ClaudeLLMProvider, DispatcherBootstrapper } from 'fitalyagents/dispatcher'
 *
 * const llm = new ClaudeLLMProvider()
 * const bootstrapper = new DispatcherBootstrapper({ intentLibrary, llm, bus })
 *
 * // Option A: from explicit manifests
 * await bootstrapper.bootstrapFromManifests([workManifest, orderManifest])
 *
 * // Option B: from registered agents
 * await bootstrapper.bootstrapFromRegistry(registry)
 * ```
 */
export class DispatcherBootstrapper {
  private readonly intentLibrary: IIntentLibrary
  private readonly llm: LLMProvider
  private readonly bus: IEventBus | undefined
  private readonly examplesPerCapability: number

  constructor(options: BootstrapOptions) {
    this.intentLibrary = options.intentLibrary
    this.llm = options.llm
    this.bus = options.bus
    this.examplesPerCapability = options.examplesPerCapability ?? 8
  }

  /**
   * Generate intent definitions from explicit agent manifests.
   *
   * @param manifests - Array of AgentManifest objects to process
   */
  async bootstrapFromManifests(manifests: AgentManifest[]): Promise<void> {
    for (const manifest of manifests) {
      await this.processManifest(manifest)
    }
  }

  /**
   * Generate intent definitions from all agents registered in an AgentRegistry.
   *
   * @param registry - The AgentRegistry to read manifests from
   */
  async bootstrapFromRegistry(registry: AgentRegistry): Promise<void> {
    const manifests = await registry.list()
    await this.bootstrapFromManifests(manifests)
  }

  // ── Private ──────────────────────────────────────────────────────────────

  private async processManifest(manifest: AgentManifest): Promise<void> {
    for (const capability of manifest.capabilities) {
      const intentId = this.toIntentId(capability)

      // Check if intent already exists; if so, just add more examples
      const existing = await this.intentLibrary.getMeta(intentId)

      if (!existing) {
        // Generate examples and create new intent
        const generated = await this.generateIntent(capability, manifest)
        const definition: IntentDefinition = {
          intent_id: intentId,
          domain_required: manifest.domain,
          scope_hint: manifest.scope,
          capabilities_required: [capability],
          initial_examples: generated.examples,
        }
        await this.intentLibrary.createIntent(definition)
      } else {
        // Intent exists — enrich it with more examples
        const generated = await this.generateIntent(capability, manifest)
        for (const example of generated.examples) {
          await this.intentLibrary.addExample(intentId, example)
        }
      }

      // Hot-reload the classifier if a bus is provided
      if (this.bus) {
        await this.bus.publish('bus:INTENT_UPDATED', {
          event: 'INTENT_UPDATED',
          intent_id: intentId,
          source: 'bootstrapper',
          timestamp: Date.now(),
        })
      }
    }
  }

  private async generateIntent(
    capability: string,
    manifest: AgentManifest,
  ): Promise<GeneratedIntent> {
    const intentId = this.toIntentId(capability)

    const system = [
      'You are an expert at generating realistic user utterances for intent classification.',
      'Your utterances should be natural, diverse, and representative of how real users speak.',
      'Include short phrases, full sentences, questions, and commands.',
      'Cover different phrasings of the same intent.',
      'Output ONLY valid JSON — no prose, no markdown, no explanation.',
    ].join('\n')

    const user = [
      `Generate exactly ${this.examplesPerCapability} example user utterances for this intent:`,
      '',
      `Intent ID: ${intentId}`,
      `Capability: ${capability}`,
      `Agent: ${manifest.agent_id}`,
      manifest.description ? `Agent description: ${manifest.description}` : '',
      `Domain: ${manifest.domain}`,
      `Scope: ${manifest.scope}`,
      manifest.requires_human_approval
        ? 'Note: this action requires human approval before execution.'
        : '',
      '',
      'Return JSON in this exact format:',
      JSON.stringify({
        intent_id: intentId,
        examples: [`example 1`, `example 2`, `...${this.examplesPerCapability} total`],
      }),
    ]
      .filter(Boolean)
      .join('\n')

    const raw = await this.llm.complete(system, user)
    return this.parseGeneratedIntent(raw, intentId)
  }

  private parseGeneratedIntent(raw: string, fallbackIntentId: string): GeneratedIntent {
    // Strip possible markdown code fences
    const cleaned = raw
      .replace(/^```(?:json)?\n?/m, '')
      .replace(/\n?```$/m, '')
      .trim()

    try {
      const parsed = JSON.parse(cleaned) as { intent_id?: string; examples?: unknown[] }

      if (!Array.isArray(parsed.examples) || parsed.examples.length === 0) {
        throw new Error('examples array is empty or missing')
      }

      return {
        intent_id: parsed.intent_id ?? fallbackIntentId,
        examples: parsed.examples.filter((e): e is string => typeof e === 'string'),
      }
    } catch (err) {
      throw new Error(
        `DispatcherBootstrapper: failed to parse LLM response for intent "${fallbackIntentId}": ${String(err)}\nRaw response: ${raw.slice(0, 200)}`,
      )
    }
  }

  /**
   * Convert a capability string to a snake_case intent ID.
   * e.g. 'PRODUCT_SEARCH' → 'product_search'
   *      'ORDER_CREATE'    → 'order_create'
   */
  private toIntentId(capability: string): string {
    return capability.toLowerCase().replace(/[^a-z0-9]+/g, '_')
  }
}
