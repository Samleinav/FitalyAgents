import {
  InMemoryEmbeddingClassifier,
  InMemoryIntentLibrary,
  MemPalaceCliTransport,
  MemPalaceMcpTransport,
  MemPalaceMemoryStore,
  NodeDispatcher,
  type FallbackRequest,
  type ILLMFallbackAgent,
  type MemPalaceMcpClient,
  type MemoryScopeResolver,
} from '@fitalyagents/dispatcher'
import { InMemoryBus, type IEventBus, type Unsubscribe } from 'fitalyagents'

class DemoFallbackAgent implements ILLMFallbackAgent {
  private unsub: Unsubscribe | null = null

  constructor(private readonly bus: IEventBus) {}

  start(): void {
    this.unsub = this.bus.subscribe('bus:DISPATCH_FALLBACK', (data) => {
      const event = data as FallbackRequest
      void this.bus.publish('bus:TASK_AVAILABLE', {
        event: 'TASK_AVAILABLE',
        task_id: `fallback_${Date.now()}`,
        session_id: event.session_id,
        intent_id: 'memory_resolved_followup',
        domain_required: 'retail',
        scope_hint: 'memory',
        capabilities_required: ['MEMORY_CONTEXT'],
        slots: {
          raw_text: event.text,
          memory_context: event.memory_context ?? [],
        },
        priority: 5,
        source: 'llm_fallback',
        timeout_ms: 8000,
        created_at: Date.now(),
      })
    })
  }

  dispose(): void {
    this.unsub?.()
    this.unsub = null
  }
}

const memoryScopeResolver: MemoryScopeResolver = ({ session_id, speaker_id, role, store_id }) => {
  if (role === 'customer' && speaker_id) return { wing: 'customer', room: speaker_id }
  if (role === 'staff' && speaker_id) return { wing: 'employee', room: speaker_id }
  if (store_id) return { wing: 'store', room: store_id }
  return { wing: 'session', room: session_id }
}

function createMemoryStore(): MemPalaceMemoryStore {
  const transport = process.env.MEMPALACE_TRANSPORT ?? 'cli'

  if (transport === 'mcp') {
    return new MemPalaceMemoryStore({
      transport: new MemPalaceMcpTransport({
        client: createMcpClient(),
      }),
    })
  }

  return new MemPalaceMemoryStore({
    transport: new MemPalaceCliTransport({
      palacePath: process.env.MEMPALACE_PALACE,
      timeoutMs: 15000,
    }),
  })
}

function createMcpClient(): MemPalaceMcpClient {
  throw new Error(
    [
      'MEMPALACE_TRANSPORT=mcp expects your app MCP client here.',
      'Wrap your MCP session with { callTool(name, args) } and pass it to MemPalaceMcpTransport.',
      'Use MEMPALACE_TRANSPORT=cli to run this example directly from the terminal.',
    ].join(' '),
  )
}

async function main(): Promise<void> {
  const bus = new InMemoryBus()
  const intentLibrary = new InMemoryIntentLibrary()
  await intentLibrary.createIntent({
    intent_id: 'store_issue_report',
    domain_required: 'retail',
    scope_hint: 'store_ops',
    capabilities_required: ['STORE_MONITORING'],
    initial_examples: ['register two is slow'],
  })

  const memoryStore = createMemoryStore()
  const fallbackAgent = new DemoFallbackAgent(bus)
  const dispatcher = new NodeDispatcher({
    bus,
    classifier: new InMemoryEmbeddingClassifier(intentLibrary),
    fallbackAgent,
    memoryStore,
    memoryScopeResolver,
  })

  bus.subscribe('bus:DISPATCH_FALLBACK', (data) => {
    const event = data as FallbackRequest
    console.log('fallback:', event.text)
    console.log('memory_context:', event.memory_context ?? [])
  })

  await dispatcher.start()

  await memoryStore.write({
    text: 'register two is slow during afternoon checkout',
    wing: 'store',
    room: 'store_001',
  })

  await bus.publish('bus:SPEECH_FINAL', {
    event: 'SPEECH_FINAL',
    session_id: 'floor_session_2',
    store_id: 'store_001',
    text: 'the register is still slow',
    timestamp: Date.now(),
  })

  await new Promise((resolve) => setTimeout(resolve, 250))

  dispatcher.dispose()
  intentLibrary.dispose()
}

main().catch((error) => {
  console.error(error instanceof Error ? error.message : error)
  process.exitCode = 1
})
