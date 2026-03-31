/**
 * FitalyAgents Voice-Retail — Demo Service
 *
 * Long-running Node.js process that:
 * 1. Connects to Redis bus
 * 2. Starts WorkAgent with demo retail + profile tools
 * 3. Listens for bus:SPEECH_PARTIAL (from fitaly-voice STT)
 * 4. Classifies intent via Claude API, routes to WorkAgent
 * 5. Prints ACTION_COMPLETED results to stdout
 *
 * Required env vars:
 *   REDIS_URL          — Redis connection (default: redis://localhost:6379)
 *   ANTHROPIC_API_KEY  — Claude API key for intent classification
 *   STORE_ID           — Store identifier (default: store-001)
 */
import Anthropic from '@anthropic-ai/sdk'
import { createBus } from 'fitalyagents'
import { WorkAgent, DEFAULT_INTENT_TOOL_MAP } from './index.js'
import { MockToolExecutor } from './agents/work/mock-tool-executor.js'

// ── Types ────────────────────────────────────────────────────────────────────

interface SpeechPartialPayload {
  event: string
  session_id: string
  speaker_id: string
  text: string
  timestamp?: number
}

interface ProfileStore {
  [sessionId: string]: { name: string; created_at: number }
}

interface OrderStore {
  [orderId: string]: { session_id: string; items: string[]; status: string; created_at: number }
}

// ── In-memory stores ─────────────────────────────────────────────────────────

const profiles: ProfileStore = {}
const orders: OrderStore = {}
let orderCounter = 1

// ── Tool definitions ─────────────────────────────────────────────────────────

function buildToolExecutor() {
  return new MockToolExecutor({
    latencyMs: 0,
    tools: [
      {
        tool_id: 'product_search',
        description: 'Search for products in the catalog',
        handler: async (input) => {
          const query = String(input.query ?? input.product ?? 'producto')
          return {
            results: [
              { name: `${query} — Modelo A`, price: 29.99, stock: 5 },
              { name: `${query} — Modelo B`, price: 49.99, stock: 2 },
            ],
            text: `Encontré 2 opciones para "${query}": Modelo A ($29.99) y Modelo B ($49.99).`,
          }
        },
      },
      {
        tool_id: 'price_check',
        description: 'Check price for a product',
        handler: async (input) => {
          const product = String(input.product ?? 'producto')
          return {
            product,
            price: 39.99,
            currency: 'USD',
            text: `El precio de ${product} es $39.99.`,
          }
        },
      },
      {
        tool_id: 'create_profile',
        description: 'Create or update a customer profile with a name',
        handler: async (input) => {
          const sessionId = String(input.session_id ?? 'unknown')
          const name = String(input.name ?? 'Cliente')
          profiles[sessionId] = { name, created_at: Date.now() }
          return {
            success: true,
            profile_id: sessionId,
            name,
            text: `Perfil creado. Bienvenido/a, ${name}.`,
          }
        },
      },
      {
        tool_id: 'get_profile',
        description: 'Get the customer profile for a session',
        handler: async (input) => {
          const sessionId = String(input.session_id ?? '')
          const profile = profiles[sessionId]
          if (!profile) {
            return {
              found: false,
              text: 'No tengo un perfil registrado para usted. ¿Cuál es su nombre?',
            }
          }
          return {
            found: true,
            name: profile.name,
            text: `Le tengo registrado/a como ${profile.name}.`,
          }
        },
      },
      {
        tool_id: 'create_order',
        description: 'Create a new order for the customer',
        handler: async (input) => {
          const sessionId = String(input.session_id ?? 'unknown')
          const items = Array.isArray(input.items)
            ? (input.items as string[])
            : [String(input.product ?? 'producto')]
          const orderId = `ORD-${String(orderCounter++).padStart(4, '0')}`
          orders[orderId] = {
            session_id: sessionId,
            items,
            status: 'pending',
            created_at: Date.now(),
          }
          const profile = profiles[sessionId]
          const customerName = profile?.name ?? 'Cliente'
          return {
            order_id: orderId,
            items,
            status: 'confirmed',
            text: `Orden ${orderId} creada para ${customerName}: ${items.join(', ')}. ¡Listo!`,
          }
        },
      },
      {
        tool_id: 'order_query',
        description: 'Query order status',
        handler: async (input) => {
          const orderId = String(input.order_id ?? '')
          const order = orders[orderId]
          if (!order) {
            const all = Object.entries(orders)
              .filter(([, o]) => o.session_id === String(input.session_id ?? ''))
              .map(([id, o]) => `${id}: ${o.items.join(', ')} (${o.status})`)
            return all.length
              ? { text: `Sus órdenes: ${all.join(' | ')}` }
              : { text: 'No tiene órdenes registradas.' }
          }
          return {
            order_id: orderId,
            status: order.status,
            items: order.items,
            text: `Orden ${orderId}: ${order.items.join(', ')} — estado: ${order.status}`,
          }
        },
      },
    ],
  })
}

// ── Intent classification via Claude ─────────────────────────────────────────

const SYSTEM_PROMPT = `Eres un clasificador de intenciones para un asistente de venta al detalle.
Dado el texto del cliente, responde SOLO con un JSON con estos campos:
- intent_id: uno de [product_search, price_query, create_profile, get_profile, create_order, order_query, greeting, farewell, unknown]
- slots: objeto con parámetros extraídos (name, query, product, items, order_id, etc.)
- response_if_direct: si la intención es greeting/farewell/unknown, responde directamente aquí (string). Para las demás, null.

Ejemplos:
Input: "Hola buenas tardes"
Output: {"intent_id":"greeting","slots":{},"response_if_direct":"¡Buenas tardes! ¿En qué le puedo ayudar hoy?"}

Input: "Busca unas zapatillas Nike talla 42"
Output: {"intent_id":"product_search","slots":{"query":"zapatillas Nike talla 42"},"response_if_direct":null}

Input: "Me llamo Samuel"
Output: {"intent_id":"create_profile","slots":{"name":"Samuel"},"response_if_direct":null}

Input: "Quiero hacer un pedido de las zapatillas Modelo A"
Output: {"intent_id":"create_order","slots":{"items":["zapatillas Modelo A"]},"response_if_direct":null}

Solo responde con el JSON, sin texto adicional.`

async function classifyIntent(
  text: string,
  anthropic: Anthropic,
): Promise<{
  intent_id: string
  slots: Record<string, unknown>
  response_if_direct: string | null
}> {
  try {
    const msg = await anthropic.messages.create({
      model: 'claude-haiku-4-5',
      max_tokens: 256,
      system: SYSTEM_PROMPT,
      messages: [{ role: 'user', content: text }],
    })
    const raw = msg.content[0]?.type === 'text' ? msg.content[0].text.trim() : '{}'
    return JSON.parse(raw)
  } catch {
    return {
      intent_id: 'unknown',
      slots: {},
      response_if_direct: 'Disculpe, no entendí. ¿Puede repetir?',
    }
  }
}

// ── Simple router ─────────────────────────────────────────────────────────────

const WORK_INTENTS = new Set([
  'product_search',
  'price_query',
  'create_profile',
  'get_profile',
  'create_order',
  'order_query',
])

const EXTENDED_INTENT_MAP = {
  ...DEFAULT_INTENT_TOOL_MAP,
  price_query: [{ tool_id: 'price_check', input: {} }],
  create_profile: [{ tool_id: 'create_profile', input: {} }],
  get_profile: [{ tool_id: 'get_profile', input: {} }],
  create_order: [{ tool_id: 'create_order', input: {} }],
}

// ── Main service ──────────────────────────────────────────────────────────────

async function main() {
  const redisUrl = process.env.REDIS_URL ?? 'redis://localhost:6379'
  const storeId = process.env.STORE_ID ?? 'store-001'
  const apiKey = process.env.ANTHROPIC_API_KEY

  if (!apiKey) {
    console.error('[service] ERROR: ANTHROPIC_API_KEY not set')
    process.exit(1)
  }

  console.log(`[service] Connecting to Redis: ${redisUrl}`)
  const bus = await createBus({ redisUrl })
  const anthropic = new Anthropic({ apiKey })
  const toolExecutor = buildToolExecutor()

  const workAgent = new WorkAgent({ bus, toolExecutor, intentToolMap: EXTENDED_INTENT_MAP })
  await workAgent.start()
  console.log('[service] WorkAgent started')

  // Listen for results from WorkAgent
  bus.subscribe('bus:ACTION_COMPLETED', (data) => {
    const payload = data as {
      session_id: string
      intent_id: string
      result: Record<string, unknown>
    }
    const text = String(payload.result?.text ?? JSON.stringify(payload.result))
    console.log(`\n[${payload.session_id}] AGENTE: ${text}\n`)
  })

  // Listen for SPEECH_PARTIAL from fitaly-voice
  bus.subscribe('bus:SPEECH_PARTIAL', async (data) => {
    const payload = data as SpeechPartialPayload
    const { session_id, speaker_id, text } = payload

    if (!text?.trim()) return

    console.log(`\n[${session_id}] CLIENTE (${speaker_id}): ${text}`)

    // Classify intent
    const { intent_id, slots, response_if_direct } = await classifyIntent(text, anthropic)

    if (response_if_direct) {
      console.log(`[${session_id}] AGENTE: ${response_if_direct}`)
      return
    }

    if (!WORK_INTENTS.has(intent_id)) {
      console.log(`[${session_id}] AGENTE: No sé cómo ayudarle con eso todavía.`)
      return
    }

    // Inject session_id into slots so tools can look up profiles
    const enrichedSlots = { ...slots, session_id }

    const taskId = `task_${Date.now()}_${Math.random().toString(36).slice(2, 7)}`
    console.log(`[${session_id}] → intent: ${intent_id}, slots: ${JSON.stringify(enrichedSlots)}`)

    await bus.publish('queue:work-agent:inbox', {
      event: 'TASK_PAYLOAD',
      task_id: taskId,
      session_id,
      intent_id,
      slots: enrichedSlots,
      context_snapshot: {},
      cancel_token: null,
      timeout_ms: 8000,
      reply_to: `queue:work-agent:outbox`,
    })
  })

  // Print SPEAKER_DETECTED/LOST events
  bus.subscribe('bus:SPEAKER_DETECTED', (data) => {
    const d = data as { session_id: string; speaker_id: string }
    console.log(`[${d.session_id}] 🔊 Speaker detected: ${d.speaker_id}`)
  })
  bus.subscribe('bus:SPEAKER_LOST', (data) => {
    const d = data as { session_id: string; speaker_id: string }
    console.log(`[${d.session_id}] 🔇 Speaker lost: ${d.speaker_id}`)
  })

  console.log(`[service] Listening for voice events on Redis (store: ${storeId})`)
  console.log('[service] Press Ctrl+C to stop\n')

  // Graceful shutdown
  process.on('SIGINT', async () => {
    console.log('\n[service] Shutting down...')
    await workAgent.shutdown()
    await bus.disconnect()
    process.exit(0)
  })
}

main().catch((err) => {
  console.error('[service] Fatal:', err)
  process.exit(1)
})
