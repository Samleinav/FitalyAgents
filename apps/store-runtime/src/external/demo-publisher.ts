import dotenv from 'dotenv'
import { createBus, type IEventBus } from 'fitalyagents'
import { isEntrypoint } from '../cli/is-entrypoint.js'
import { resolveConfigPath } from '../cli/resolve-config-path.js'
import { loadStoreConfig } from '../config/load-store-config.js'

export async function publishUiDemoFlow(deps: {
  bus: IEventBus
  storeId: string
  speakerId?: string
  sessionId?: string
  stepDelayMs?: number
}): Promise<{
  speakerId: string
  sessionId: string
  turnId: string
}> {
  const speakerId = deps.speakerId ?? 'speaker-demo-01'
  const sessionId = deps.sessionId ?? `session:${speakerId}`
  const turnId = `turn:${sessionId}:1`
  const waitMs = deps.stepDelayMs ?? 250
  const now = Date.now()

  await deps.bus.publish('bus:TARGET_GROUP_CHANGED', {
    event: 'TARGET_GROUP_CHANGED',
    store_id: deps.storeId,
    primary: speakerId,
    queued: ['speaker-demo-02'],
    ambient: ['speaker-demo-ambient'],
    speakers: [
      { speakerId, state: 'targeted' },
      { speakerId: 'speaker-demo-02', state: 'queued' },
      { speakerId: 'speaker-demo-ambient', state: 'ambient' },
    ],
    timestamp: now,
  })
  await delay(waitMs)

  await deps.bus.publish('bus:SPEECH_FINAL', {
    event: 'SPEECH_FINAL',
    session_id: sessionId,
    speaker_id: speakerId,
    role: 'customer',
    text: 'Busco unas zapatillas running para entrenamiento diario.',
    store_id: deps.storeId,
    timestamp: now + 1,
  })
  await delay(waitMs)

  await deps.bus.publish('bus:RESPONSE_START', {
    event: 'RESPONSE_START',
    session_id: sessionId,
    speaker_id: speakerId,
    turn_id: turnId,
    timestamp: now + 2,
  })
  await delay(waitMs)

  await deps.bus.publish('bus:AVATAR_SPEAK', {
    event: 'AVATAR_SPEAK',
    session_id: sessionId,
    speaker_id: speakerId,
    turn_id: turnId,
    text: 'Tengo dos modelos que suelen funcionar muy bien para ese uso.',
    is_final: true,
    timestamp: now + 3,
  })
  await delay(waitMs)

  await deps.bus.publish('bus:AVATAR_SPEAK', {
    event: 'AVATAR_SPEAK',
    session_id: sessionId,
    speaker_id: speakerId,
    turn_id: turnId,
    text: 'Te muestro opciones y luego, si quieres, te preparo un borrador de compra.',
    is_final: true,
    timestamp: now + 4,
  })
  await delay(waitMs)

  await deps.bus.publish('bus:RESPONSE_END', {
    event: 'RESPONSE_END',
    session_id: sessionId,
    speaker_id: speakerId,
    turn_id: turnId,
    reason: 'end_turn',
    timestamp: now + 5,
  })
  await delay(waitMs)

  await deps.bus.publish('bus:UI_UPDATE', {
    event: 'UI_UPDATE',
    component: 'product_grid',
    action: 'show',
    data: {
      query: 'zapatillas running',
      results: [
        { id: 'sku-run-001', name: 'Fitaly Run Flow', price: 79900 },
        { id: 'sku-run-002', name: 'Fitaly Cloud Pace', price: 89900 },
      ],
    },
    timestamp: now + 6,
  })
  await delay(waitMs)

  await deps.bus.publish('bus:DRAFT_CREATED', {
    event: 'DRAFT_CREATED',
    draft_id: 'draft-demo-01',
    session_id: sessionId,
    intent_id: 'order_create',
    summary: {
      items: [{ product_id: 'sku-run-002', name: 'Fitaly Cloud Pace', quantity: 1, price: 89900 }],
    },
    ttl: 180,
    timestamp: now + 7,
  })
  await delay(waitMs)

  await deps.bus.publish('bus:UI_UPDATE', {
    event: 'UI_UPDATE',
    component: 'order_panel',
    action: 'show',
    data: {
      draft_id: 'draft-demo-01',
      intent_id: 'order_create',
      summary: {
        product: 'Fitaly Cloud Pace',
        qty: 1,
        total: 89900,
      },
    },
    timestamp: now + 7,
  })
  await delay(waitMs)

  await deps.bus.publish('bus:DRAFT_CONFIRMED', {
    event: 'DRAFT_CONFIRMED',
    draft_id: 'draft-demo-01',
    session_id: sessionId,
    intent_id: 'order_create',
    items: {
      items: [{ product_id: 'sku-run-002', name: 'Fitaly Cloud Pace', quantity: 1, price: 89900 }],
    },
    total: 89900,
    timestamp: now + 8,
  })
  await delay(waitMs)

  await deps.bus.publish('bus:TOOL_RESULT', {
    event: 'TOOL_RESULT',
    session_id: sessionId,
    store_id: deps.storeId,
    speaker_id: speakerId,
    tool_id: 'order_create',
    tool_name: 'order_create',
    input: {
      items: [{ product_id: 'sku-run-002', quantity: 1, price: 89900 }],
    },
    result: {
      order_id: 'ord-demo-01',
      total: 89900,
      item_count: 1,
      order_state: 'open',
      items: [
        {
          product_id: 'sku-run-002',
          name: 'Fitaly Cloud Pace',
          quantity: 1,
          price: 89900,
          line_total: 89900,
        },
      ],
      text: 'La orden ord-demo-01 quedó preparada.',
    },
    timestamp: now + 9,
  })
  await delay(waitMs)

  await deps.bus.publish('bus:TOOL_RESULT', {
    event: 'TOOL_RESULT',
    session_id: sessionId,
    store_id: deps.storeId,
    speaker_id: speakerId,
    tool_id: 'payment_intent_create',
    tool_name: 'payment_intent_create',
    input: {
      order_id: 'ord-demo-01',
      payment_method: 'card',
    },
    result: {
      payment_intent_id: 'pay-demo-01',
      order_id: 'ord-demo-01',
      amount: 89900,
      payment_method: 'card',
      status: 'ready',
      text: 'Preparé el cobro con tarjeta.',
    },
    timestamp: now + 10,
  })
  await delay(waitMs)

  await deps.bus.publish('bus:ORDER_QUEUED_NO_APPROVER', {
    event: 'ORDER_QUEUED_NO_APPROVER',
    request_id: 'approval-demo-01',
    draft_id: 'draft-refund-demo-01',
    session_id: sessionId,
    required_role: 'manager',
    queued_at: now + 11,
    timestamp: now + 11,
  })
  await delay(waitMs)

  await deps.bus.publish('bus:UI_UPDATE', {
    event: 'UI_UPDATE',
    component: 'approval_bar',
    action: 'update',
    data: {
      session_id: sessionId,
      approved: true,
      channel_used: 'voice',
      strategy: 'parallel',
      approvers: ['mgr-001'],
    },
    timestamp: now + 12,
  })

  await delay(waitMs)

  await deps.bus.publish('bus:APPROVAL_RESOLVED', {
    event: 'APPROVAL_RESOLVED',
    request_id: 'approval-demo-01',
    draft_id: 'draft-refund-demo-01',
    session_id: sessionId,
    approved: true,
    approver_id: 'mgr-001',
    approvers: ['mgr-001'],
    channel_used: 'voice',
    strategy: 'parallel',
    timestamp: now + 13,
  })

  await delay(waitMs)

  await deps.bus.publish('bus:TOOL_RESULT', {
    event: 'TOOL_RESULT',
    session_id: sessionId,
    store_id: deps.storeId,
    speaker_id: speakerId,
    tool_id: 'receipt_print',
    tool_name: 'receipt_print',
    input: {
      order_id: 'ord-demo-01',
    },
    result: {
      receipt_id: 'receipt-demo-01',
      print_job_id: 'job-demo-01',
      order_id: 'ord-demo-01',
      status: 'printed',
      text: 'Imprimí el comprobante receipt-demo-01.',
    },
    timestamp: now + 14,
  })

  return { speakerId, sessionId, turnId }
}

async function main(): Promise<void> {
  dotenv.config()

  const configPath = resolveConfigPath(process.argv.slice(2))
  const config = await loadStoreConfig(configPath)

  if (config.providers.bus.driver !== 'redis') {
    throw new Error('Demo publisher requiere providers.bus.driver="redis"')
  }

  const bus = await createBus({
    redisUrl: config.providers.bus.url,
  })

  try {
    const summary = await publishUiDemoFlow({
      bus,
      storeId: config.store.store_id,
      stepDelayMs: readDelay(process.env.STORE_UI_DEMO_DELAY_MS),
    })

    process.stdout.write(`[store-runtime/demo] Escenario publicado ${JSON.stringify(summary)}\n`)
  } finally {
    if ('disconnect' in bus && typeof bus.disconnect === 'function') {
      await bus.disconnect().catch(() => {})
    }
  }
}

function readDelay(value: string | undefined): number {
  const parsed = value ? Number(value) : NaN
  return Number.isFinite(parsed) && parsed >= 0 ? parsed : 250
}

function delay(ms: number): Promise<void> {
  if (ms <= 0) {
    return Promise.resolve()
  }

  return new Promise((resolve) => {
    setTimeout(resolve, ms)
  })
}

if (isEntrypoint(import.meta.url)) {
  main().catch((error) => {
    console.error(
      '[store-runtime/demo] Publish failed:',
      error instanceof Error ? error.message : error,
    )
    process.exitCode = 1
  })
}
