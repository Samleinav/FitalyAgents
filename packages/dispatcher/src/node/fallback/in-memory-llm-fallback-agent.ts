import type { IEventBus, Unsubscribe } from 'fitalyagents'
import type {
  ILLMFallbackAgent,
  IIntentLibrary,
  FallbackRequest,
  IntentMeta,
} from '../../types/index.js'

/**
 * Resolver function: given a fallback request and available intents,
 * return the resolved intent classification.
 *
 * In production, this calls an LLM (e.g. Claude Haiku).
 * In testing, this can be a simple lookup.
 */
export type FallbackResolver = (
  text: string,
  availableIntents: IntentMeta[],
) => Promise<{
  intent_id: string
  domain_required: string
  scope_hint: string
  capabilities_required: string[]
  slots: Record<string, unknown>
}>

/**
 * In-memory LLMFallbackAgent for testing.
 *
 * Subscribes to `bus:DISPATCH_FALLBACK`, resolves via a pluggable
 * resolver function, then publishes `bus:TASK_AVAILABLE` and
 * trains the intent library with the new example.
 *
 * @example
 * ```typescript
 * const fallback = new InMemoryLLMFallbackAgent({
 *   bus,
 *   intentLibrary,
 *   resolver: async (text) => ({
 *     intent_id: 'product_search',
 *     ...
 *   }),
 * })
 * fallback.start()
 * ```
 */
export class InMemoryLLMFallbackAgent implements ILLMFallbackAgent {
  private readonly bus: IEventBus
  private readonly intentLibrary: IIntentLibrary
  private readonly resolver: FallbackResolver
  private unsub: Unsubscribe | null = null

  constructor(deps: { bus: IEventBus; intentLibrary: IIntentLibrary; resolver: FallbackResolver }) {
    this.bus = deps.bus
    this.intentLibrary = deps.intentLibrary
    this.resolver = deps.resolver
  }

  start(): void {
    this.unsub = this.bus.subscribe('bus:DISPATCH_FALLBACK', (data) => {
      const req = data as FallbackRequest
      void this.resolve(req)
    })
  }

  dispose(): void {
    if (this.unsub) {
      this.unsub()
      this.unsub = null
    }
  }

  private async resolve(req: FallbackRequest): Promise<void> {
    // Get all available intent metas for the resolver
    const intentIds = await this.intentLibrary.listIntentIds()
    const metas: IntentMeta[] = []
    for (const id of intentIds) {
      const meta = await this.intentLibrary.getMeta(id)
      if (meta) metas.push(meta)
    }

    // Resolve via the pluggable function (LLM in production)
    const classified = await this.resolver(req.text, metas)

    // 1. Publish the task to the bus
    await this.bus.publish('bus:TASK_AVAILABLE', {
      event: 'TASK_AVAILABLE',
      task_id: `fallback_${Date.now()}`,
      session_id: req.session_id,
      intent_id: classified.intent_id,
      domain_required: classified.domain_required,
      scope_hint: classified.scope_hint,
      capabilities_required: classified.capabilities_required,
      slots: classified.slots,
      priority: 5,
      source: 'llm_fallback',
      classifier_confidence: req.classifier_confidence,
      timeout_ms: 8000,
      created_at: Date.now(),
    })

    // 2. Train the intent library with the new example
    try {
      await this.intentLibrary.addExample(classified.intent_id, req.text)
    } catch {
      // Intent may not exist yet — create it
      await this.intentLibrary.createIntent({
        intent_id: classified.intent_id,
        domain_required: classified.domain_required,
        scope_hint: classified.scope_hint,
        capabilities_required: classified.capabilities_required,
        initial_examples: [req.text],
      })
    }

    // 3. Notify the classifier to reload this intent
    await this.bus.publish('bus:INTENT_UPDATED', {
      event: 'INTENT_UPDATED',
      intent_id: classified.intent_id,
      new_example: req.text,
      source: 'llm_fallback',
      timestamp: Date.now(),
    })
  }
}
