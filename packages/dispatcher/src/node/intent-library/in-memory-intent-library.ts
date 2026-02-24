import type { IIntentLibrary, IntentDefinition, IntentMeta } from '../../types/index.js'

/**
 * In-memory implementation of IIntentLibrary.
 *
 * Stores intent definitions and their training examples in Maps.
 * In production, this would be backed by Redis lists and JSON.
 *
 * @example
 * ```typescript
 * const lib = new InMemoryIntentLibrary()
 * await lib.createIntent({
 *   intent_id: 'product_search',
 *   domain_required: 'customer_facing',
 *   scope_hint: 'commerce',
 *   capabilities_required: ['PRODUCT_SEARCH'],
 *   initial_examples: ['find a product', 'search for shoes'],
 * })
 * ```
 */
export class InMemoryIntentLibrary implements IIntentLibrary {
  private metas: Map<string, IntentMeta> = new Map()
  private examples: Map<string, string[]> = new Map()

  async createIntent(def: IntentDefinition): Promise<void> {
    const meta: IntentMeta = {
      intent_id: def.intent_id,
      domain_required: def.domain_required,
      scope_hint: def.scope_hint,
      capabilities_required: def.capabilities_required,
    }
    this.metas.set(def.intent_id, meta)
    this.examples.set(def.intent_id, [...def.initial_examples])
  }

  async addExample(intentId: string, example: string): Promise<void> {
    const examples = this.examples.get(intentId)
    if (!examples) {
      throw new Error(`Intent not found: "${intentId}"`)
    }
    examples.push(example)
  }

  async getExamples(intentId: string): Promise<string[]> {
    return [...(this.examples.get(intentId) ?? [])]
  }

  async getMeta(intentId: string): Promise<IntentMeta | null> {
    return this.metas.get(intentId) ?? null
  }

  async hasIntentForCapability(capability: string): Promise<boolean> {
    for (const meta of this.metas.values()) {
      if (meta.capabilities_required.includes(capability)) {
        return true
      }
    }
    return false
  }

  async listIntentIds(): Promise<string[]> {
    return Array.from(this.metas.keys())
  }

  dispose(): void {
    this.metas.clear()
    this.examples.clear()
  }
}
