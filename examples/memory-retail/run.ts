import { InMemoryBus, type IEventBus, type Unsubscribe } from 'fitalyagents'
import {
  AaakDialect,
  InMemoryEmbeddingClassifier,
  InMemoryIntentLibrary,
  InMemoryMemoryStore,
  NodeDispatcher,
  type FallbackRequest,
  type ILLMFallbackAgent,
  type MemoryHit,
  type MemoryScopeResolver,
  type SpeechFinalEvent,
} from '@fitalyagents/dispatcher'

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms))
}

function summarizeHits(hits?: MemoryHit[]): string {
  if (!hits || hits.length === 0) return 'no relevant memory'

  return hits
    .map((hit) => `${hit.wing}/${hit.room}: "${hit.text}" (${hit.similarity.toFixed(2)})`)
    .join(' | ')
}

class DemoRetailFallbackAgent implements ILLMFallbackAgent {
  private unsub: Unsubscribe | null = null

  constructor(private readonly bus: IEventBus) {}

  start(): void {
    this.unsub = this.bus.subscribe('bus:DISPATCH_FALLBACK', (data) => {
      void this.handleFallback(data as FallbackRequest)
    })
  }

  dispose(): void {
    if (this.unsub) this.unsub()
    this.unsub = null
  }

  private async handleFallback(event: FallbackRequest): Promise<void> {
    const task = this.resolveTask(event)

    await this.bus.publish('bus:TASK_AVAILABLE', {
      event: 'TASK_AVAILABLE',
      task_id: `fallback_${Date.now()}`,
      session_id: event.session_id,
      intent_id: task.intent_id,
      domain_required: task.domain_required,
      scope_hint: task.scope_hint,
      capabilities_required: task.capabilities_required,
      slots: {
        raw_text: event.text,
        memory_context: event.memory_context ?? [],
        resolution_reason: task.reason,
      },
      priority: 5,
      source: 'llm_fallback',
      timeout_ms: 8000,
      created_at: Date.now(),
    })
  }

  private resolveTask(event: FallbackRequest): {
    intent_id: string
    domain_required: string
    scope_hint: string
    capabilities_required: string[]
    reason: string
  } {
    const memoryText = (event.memory_context ?? [])
      .map((hit) => hit.text.toLowerCase())
      .join(' || ')

    if (memoryText.includes('decaf') || memoryText.includes('coffee')) {
      return {
        intent_id: 'order_regular_item',
        domain_required: 'customer_facing',
        scope_hint: 'commerce',
        capabilities_required: ['ORDER_DRINK'],
        reason: 'Customer memory indicates their usual decaf coffee order.',
      }
    }

    if (memoryText.includes('inventory') || memoryText.includes('stock')) {
      return {
        intent_id: 'inventory_followup',
        domain_required: 'internal_ops',
        scope_hint: 'inventory',
        capabilities_required: ['INVENTORY_READ'],
        reason: 'Employee memory points to an inventory follow-up.',
      }
    }

    if (memoryText.includes('register') || memoryText.includes('slow')) {
      return {
        intent_id: 'store_issue_followup',
        domain_required: 'internal_ops',
        scope_hint: 'store_ops',
        capabilities_required: ['STORE_MONITORING'],
        reason: 'Store memory detects a previous operational issue.',
      }
    }

    return {
      intent_id: 'generic_query',
      domain_required: 'customer_facing',
      scope_hint: 'general',
      capabilities_required: ['GENERAL_QUERY'],
      reason: 'No specific memory was available; using generic fallback.',
    }
  }
}

const memoryScopeResolver: MemoryScopeResolver = ({
  session_id,
  speaker_id,
  role,
  actor_type,
  store_id,
  group_id,
}) => {
  const resolvedRole = actor_type ?? role ?? null

  if ((resolvedRole === 'customer' || resolvedRole === 'user') && speaker_id) {
    return { wing: 'customer', room: speaker_id }
  }

  if (
    ['staff', 'agent', 'cashier', 'operator', 'manager', 'supervisor', 'owner'].includes(
      resolvedRole ?? '',
    )
  ) {
    return { wing: 'employee', room: speaker_id ?? `${session_id}:employee` }
  }

  if (group_id) {
    return { wing: 'group', room: group_id }
  }

  if (store_id) {
    return { wing: 'store', room: store_id }
  }

  return { wing: 'session', room: session_id }
}

async function seedIntents(intentLibrary: InMemoryIntentLibrary): Promise<void> {
  await intentLibrary.createIntent({
    intent_id: 'order_decaf',
    domain_required: 'customer_facing',
    scope_hint: 'commerce',
    capabilities_required: ['ORDER_DRINK'],
    initial_examples: ['i want a decaf coffee'],
  })

  await intentLibrary.createIntent({
    intent_id: 'inventory_check',
    domain_required: 'internal_ops',
    scope_hint: 'inventory',
    capabilities_required: ['INVENTORY_READ'],
    initial_examples: ['check the sneaker inventory'],
  })

  await intentLibrary.createIntent({
    intent_id: 'store_issue_report',
    domain_required: 'internal_ops',
    scope_hint: 'store_ops',
    capabilities_required: ['STORE_MONITORING'],
    initial_examples: ['register two is slow'],
  })
}

async function publishSpeech(bus: InMemoryBus, event: SpeechFinalEvent): Promise<void> {
  console.log(
    `\n> [${event.session_id}] ${event.role ?? event.actor_type ?? 'ambient'}:${event.speaker_id ?? 'anon'} -> ${event.text}`,
  )
  await bus.publish('bus:SPEECH_FINAL', event)
  await sleep(75)
}

async function printMemorySnapshot(memoryStore: InMemoryMemoryStore): Promise<void> {
  const customer = await memoryStore.query('decaf coffee', {
    wing: 'customer',
    room: 'cust_ana',
  })
  const employee = await memoryStore.query('sneaker inventory', {
    wing: 'employee',
    room: 'staff_luis',
  })
  const store = await memoryStore.query('slow register', {
    wing: 'store',
    room: 'store_001',
  })

  console.log('\nMemory snapshot')
  console.log('---------------')
  console.log('Customer:', summarizeHits(customer))
  console.log('Employee:', summarizeHits(employee))
  console.log('Store:', summarizeHits(store))
}

async function main(): Promise<void> {
  const bus = new InMemoryBus()
  const intentLibrary = new InMemoryIntentLibrary()
  await seedIntents(intentLibrary)

  const classifier = new InMemoryEmbeddingClassifier(intentLibrary)
  const memoryStore = new InMemoryMemoryStore({
    dialect: new AaakDialect({
      entities: {
        Anna: 'ANA',
        Luis: 'LUI',
        Register: 'REG',
      },
    }),
  })
  const fallbackAgent = new DemoRetailFallbackAgent(bus)

  bus.subscribe('bus:DISPATCH_FALLBACK', (data) => {
    const event = data as FallbackRequest
    console.log('  fallback:', event.text)
    console.log('  memory_context:', summarizeHits(event.memory_context))
  })

  bus.subscribe('bus:TASK_AVAILABLE', (data) => {
    const event = data as {
      intent_id: string
      session_id: string
      source?: string
      slots?: Record<string, unknown>
    }
    const reason =
      typeof event.slots?.resolution_reason === 'string' ? event.slots.resolution_reason : null
    console.log(
      `  task_available: ${event.intent_id} [${event.source ?? 'unknown'}] for ${event.session_id}`,
    )
    if (reason) {
      console.log(`  reason: ${reason}`)
    }
  })

  const dispatcher = new NodeDispatcher({
    bus,
    classifier,
    fallbackAgent,
    memoryStore,
    memoryScopeResolver,
  })

  await dispatcher.start()

  console.log('Memory retail example')
  console.log('=====================')

  await publishSpeech(bus, {
    event: 'SPEECH_FINAL',
    session_id: 'floor_session_1',
    speaker_id: 'cust_ana',
    role: 'customer',
    text: 'i want a decaf coffee',
    timestamp: Date.now(),
  })

  await publishSpeech(bus, {
    event: 'SPEECH_FINAL',
    session_id: 'floor_session_1',
    speaker_id: 'staff_luis',
    role: 'staff',
    text: 'check the sneaker inventory',
    timestamp: Date.now(),
  })

  await publishSpeech(bus, {
    event: 'SPEECH_FINAL',
    session_id: 'floor_session_1',
    store_id: 'store_001',
    text: 'register two is slow',
    timestamp: Date.now(),
  })

  await publishSpeech(bus, {
    event: 'SPEECH_FINAL',
    session_id: 'floor_session_1',
    speaker_id: 'cust_ana',
    role: 'customer',
    text: 'the same coffee as before',
    timestamp: Date.now(),
  })

  await publishSpeech(bus, {
    event: 'SPEECH_FINAL',
    session_id: 'floor_session_1',
    speaker_id: 'staff_luis',
    role: 'staff',
    text: 'how is the inventory going',
    timestamp: Date.now(),
  })

  await publishSpeech(bus, {
    event: 'SPEECH_FINAL',
    session_id: 'floor_session_2',
    store_id: 'store_001',
    text: 'the register is still slow',
    timestamp: Date.now(),
  })

  await printMemorySnapshot(memoryStore)

  dispatcher.dispose()
  intentLibrary.dispose()
}

main().catch((error) => {
  console.error(error)
  process.exitCode = 1
})
