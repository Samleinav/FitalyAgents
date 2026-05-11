import { describe, expect, it, vi } from 'vitest'
import { InMemoryBus, InMemoryContextStore, InMemorySessionManager } from 'fitalyagents'
import { InteractionRuntimeAgent } from './interaction-runtime-agent.js'
import {
  DraftRepository,
  OrderRepository,
  SessionRepository,
} from '../storage/repositories/index.js'
import { buildSpeakerSessionId } from '../bootstrap/speaker-session.js'
import {
  cleanupTempDir,
  closeTestDb,
  createTempDbPath,
  createTempDir,
  ensureDb,
} from '../../test/helpers.js'

describe('InteractionRuntimeAgent', () => {
  it('aborts active LLM sessions on barge-in', async () => {
    const harness = await createHarness()

    try {
      await harness.agent.start()

      await harness.bus.publish('bus:BARGE_IN', {
        event: 'BARGE_IN',
        session_id: 'session-1',
      })

      expect(harness.llm.abortSession).toHaveBeenCalledWith('session-1')
    } finally {
      await harness.agent.stop()
      await cleanupHarness(harness)
    }
  })

  it('routes customer speech through interaction and memory', async () => {
    const harness = await createHarness()

    try {
      await harness.agent.start()

      await harness.bus.publish('bus:SPEECH_FINAL', {
        event: 'SPEECH_FINAL',
        session_id: 'session-1',
        text: 'Busco tenis Nike',
        speaker_id: 'customer-1',
        role: 'customer',
        store_id: 'store-test',
        timestamp: Date.now(),
      })

      expect(harness.interaction.handleSpeechFinal).toHaveBeenCalled()
      expect(harness.memoryStore.write).toHaveBeenCalled()
      expect(await harness.sessionManager.getSession('session-1')).not.toBeNull()
    } finally {
      await harness.agent.stop()
      await cleanupHarness(harness)
    }
  })

  it('ignores customer speech when another speaker is primary', async () => {
    const harness = await createHarness()

    try {
      await harness.agent.start()

      await harness.bus.publish('bus:TARGET_GROUP_CHANGED', {
        event: 'TARGET_GROUP_CHANGED',
        store_id: 'store-test',
        primary: 'customer-1',
        queued: ['customer-2'],
        ambient: [],
        speakers: [
          { speakerId: 'customer-1', state: 'targeted' },
          { speakerId: 'customer-2', state: 'queued' },
        ],
        timestamp: Date.now(),
      })

      await harness.bus.publish('bus:SPEECH_FINAL', {
        event: 'SPEECH_FINAL',
        session_id: 'session-2',
        text: 'yo también quiero ayuda',
        speaker_id: 'customer-2',
        role: 'customer',
        store_id: 'store-test',
        timestamp: Date.now(),
      })

      expect(harness.interaction.handleSpeechFinal).not.toHaveBeenCalled()
      expect(harness.memoryStore.write).not.toHaveBeenCalled()
      expect(await harness.sessionManager.getSession('session-2')).toBeNull()
    } finally {
      await harness.agent.stop()
      await cleanupHarness(harness)
    }
  })

  it('swallows abort-like errors from the LLM path', async () => {
    const harness = await createHarness({
      runWithSession: vi
        .fn()
        .mockRejectedValue(new DOMException('The operation was aborted.', 'AbortError')),
    })

    await expect(
      harness.agent.onEvent('bus:SPEECH_FINAL', {
        session_id: 'session-1',
        text: 'hola',
      }),
    ).resolves.toBeUndefined()

    await cleanupHarness(harness)
  })

  it('normalizes external-bus speech into speaker-scoped runtime sessions', async () => {
    const harness = await createHarness({
      captureDriver: 'external-bus',
    })

    try {
      await harness.agent.start()

      await harness.bus.publish('bus:SPEECH_FINAL', {
        event: 'SPEECH_FINAL',
        session_id: 'room-a',
        text: 'hola desde redis',
        speaker_id: 'trk:voice:001',
        role: 'customer',
        store_id: 'store-test',
        timestamp: Date.now(),
      })

      const expectedSessionId = buildSpeakerSessionId('store-test', 'trk:voice:001')
      expect(harness.interaction.handleSpeechFinal).toHaveBeenCalledWith(
        expect.objectContaining({
          session_id: expectedSessionId,
          speaker_id: 'trk:voice:001',
        }),
      )
      expect(await harness.sessionManager.getSession(expectedSessionId)).not.toBeNull()
      expect(await harness.sessionManager.getSession('room-a')).toBeNull()
    } finally {
      await harness.agent.stop()
      await cleanupHarness(harness)
    }
  })

  it('cancels a pending draft when the customer starts a fresh product browse', async () => {
    const harness = await createHarness()
    harness.draftStore.getBySession.mockResolvedValue({ id: 'draft-1' })

    try {
      await harness.agent.start()

      await harness.bus.publish('bus:SPEECH_FINAL', {
        event: 'SPEECH_FINAL',
        session_id: 'session-1',
        text: 'Quiero ver tenis talla 42',
        speaker_id: 'customer-1',
        role: 'customer',
        store_id: 'store-test',
        timestamp: Date.now(),
      })

      expect(harness.draftStore.cancel).toHaveBeenCalledWith('draft-1')
      expect(harness.interaction.handleDraftFlow).not.toHaveBeenCalled()
      expect(harness.interaction.handleSpeechFinal).toHaveBeenCalled()
    } finally {
      await harness.agent.stop()
      await cleanupHarness(harness)
    }
  })

  it('cancels an active draft when the customer says cancela', async () => {
    const harness = await createHarness()
    harness.draftStore.getBySession.mockResolvedValue({ id: 'draft-2' })

    try {
      await harness.agent.start()

      await harness.bus.publish('bus:SPEECH_FINAL', {
        event: 'SPEECH_FINAL',
        session_id: 'session-1',
        text: 'cancela',
        speaker_id: 'customer-1',
        role: 'customer',
        store_id: 'store-test',
        timestamp: Date.now(),
      })

      expect(harness.draftStore.cancel).toHaveBeenCalledWith('draft-2')
      expect(harness.ttsStream.speakText).toHaveBeenCalledWith(
        'session-1',
        'Listo, cancelo el pedido.',
        6,
      )
      expect(harness.interaction.handleDraftFlow).not.toHaveBeenCalled()
      expect(harness.interaction.handleSpeechFinal).not.toHaveBeenCalled()
    } finally {
      await harness.agent.stop()
      await cleanupHarness(harness)
    }
  })

  it('answers with an alternative when cancelling without an active draft', async () => {
    const harness = await createHarness()
    harness.orderRepository.insert({
      id: 'ord-cancel-1',
      session_id: 'session-1',
      draft_id: null,
      tool_id: 'order_create',
      params: {
        items: [{ product_id: 'sku-1', quantity: 1, price: 25 }],
      },
      result: {
        order_id: 'ord-cancel-1',
        total: 25,
        order_state: 'open',
      },
      status: 'completed',
      created_at: Date.now(),
      updated_at: Date.now(),
    })

    try {
      await harness.agent.start()

      await harness.bus.publish('bus:SPEECH_FINAL', {
        event: 'SPEECH_FINAL',
        session_id: 'session-1',
        text: 'cancela',
        speaker_id: 'customer-1',
        role: 'customer',
        store_id: 'store-test',
        timestamp: Date.now(),
      })

      expect(harness.draftStore.cancel).not.toHaveBeenCalled()
      expect(harness.ttsStream.speakText).toHaveBeenCalledWith(
        'session-1',
        'No tengo nada pendiente que cancelar. Quieres buscar otro producto?',
        6,
      )
      expect(harness.interaction.handleSpeechFinal).not.toHaveBeenCalled()
    } finally {
      await harness.agent.stop()
      await cleanupHarness(harness)
    }
  })

  it('cancels an active draft and asks for a corrected visible product choice', async () => {
    const harness = await createHarness()
    harness.draftStore.getBySession.mockResolvedValue({
      id: 'draft-correction-1',
      items: {
        items: [{ product_id: 'sku-red', quantity: 1, price: 90 }],
      },
    })

    try {
      await harness.agent.start()
      await publishProductList(harness)

      await harness.bus.publish('bus:SPEECH_FINAL', {
        event: 'SPEECH_FINAL',
        session_id: 'session-1',
        text: 'no, mejor el otro',
        speaker_id: 'customer-1',
        role: 'customer',
        store_id: 'store-test',
        timestamp: Date.now(),
      })

      expect(harness.draftStore.cancel).toHaveBeenCalledWith('draft-correction-1')
      expect(harness.ttsStream.speakText).toHaveBeenCalledWith(
        'session-1',
        'Cual prefieres? A2 Cloud Runner Azul.',
        6,
      )
      expect(harness.interaction.handleSpeechFinal).not.toHaveBeenCalled()
    } finally {
      await harness.agent.stop()
      await cleanupHarness(harness)
    }
  })

  it('continues through the LLM for correction intent without an active draft', async () => {
    const harness = await createHarness()

    try {
      await harness.agent.start()

      await harness.bus.publish('bus:SPEECH_FINAL', {
        event: 'SPEECH_FINAL',
        session_id: 'session-1',
        text: 'no, mejor el otro',
        speaker_id: 'customer-1',
        role: 'customer',
        store_id: 'store-test',
        timestamp: Date.now(),
      })

      expect(harness.draftStore.cancel).not.toHaveBeenCalled()
      expect(harness.interaction.handleSpeechFinal).toHaveBeenCalled()
    } finally {
      await harness.agent.stop()
      await cleanupHarness(harness)
    }
  })

  it('ends the runtime session and publishes SESSION_ENDED on farewell', async () => {
    const harness = await createHarness()
    const sessionEndedEvents: unknown[] = []
    const unsubscribe = harness.bus.subscribe('bus:SESSION_ENDED', (payload) => {
      sessionEndedEvents.push(payload)
    })

    try {
      await harness.agent.start()

      await harness.bus.publish('bus:SPEECH_FINAL', {
        event: 'SPEECH_FINAL',
        session_id: 'session-1',
        text: 'gracias, eso es todo',
        speaker_id: 'customer-1',
        role: 'customer',
        store_id: 'store-test',
        timestamp: Date.now(),
      })

      expect(harness.ttsStream.speakText).toHaveBeenCalledWith(
        'session-1',
        'Con gusto. Hasta luego.',
        6,
      )
      expect(harness.sessionRepository.list()).toEqual([
        expect.objectContaining({
          session_id: 'session-1',
          ended_at: expect.any(Number),
          summary: {
            closed_by: 'farewell',
            last_user_text: 'gracias, eso es todo',
          },
        }),
      ])
      expect(sessionEndedEvents).toEqual([
        expect.objectContaining({
          event: 'SESSION_ENDED',
          session_id: 'session-1',
          store_id: 'store-test',
        }),
      ])
      expect(harness.interaction.handleSpeechFinal).not.toHaveBeenCalled()
    } finally {
      unsubscribe()
      await harness.agent.stop()
      await cleanupHarness(harness)
    }
  })

  it('continues an active order when the customer asks how to pay', async () => {
    const harness = await createHarness()
    harness.orderRepository.insert({
      id: 'ord-1',
      session_id: 'session-1',
      draft_id: null,
      tool_id: 'order_create',
      params: {
        items: [{ product_id: 'sku-1', quantity: 1, price: 25 }],
      },
      result: {
        order_id: 'ord-1',
        total: 25,
        order_state: 'open',
      },
      status: 'completed',
      created_at: Date.now(),
      updated_at: Date.now(),
    })

    try {
      await harness.agent.start()

      await harness.bus.publish('bus:SPEECH_FINAL', {
        event: 'SPEECH_FINAL',
        session_id: 'session-1',
        text: 'como pago?',
        speaker_id: 'customer-1',
        role: 'customer',
        store_id: 'store-test',
        timestamp: Date.now(),
      })

      expect(harness.ttsStream.speakText).toHaveBeenCalledWith(
        'session-1',
        expect.stringContaining('Puedes pagar con tarjeta o efectivo'),
        7,
      )
      expect(harness.interaction.handleToolCall).not.toHaveBeenCalled()
      expect(harness.interaction.handleProtectedConfirm).not.toHaveBeenCalled()
      expect(harness.interaction.handleSpeechFinal).not.toHaveBeenCalled()
    } finally {
      await harness.agent.stop()
      await cleanupHarness(harness)
    }
  })

  it('auto-confirms a protected card payment when the customer chooses card', async () => {
    const harness = await createHarness()
    harness.interaction.handleToolCall.mockResolvedValueOnce({
      type: 'draft_ready',
      toolId: 'payment_intent_create',
      draftId: 'draft-payment-card',
      needs_confirmation: true,
    })
    harness.orderRepository.insert({
      id: 'ord-2',
      session_id: 'session-1',
      draft_id: null,
      tool_id: 'order_create',
      params: {
        items: [{ product_id: 'sku-2', quantity: 2, price: 10 }],
      },
      result: {
        order_id: 'ord-2',
        total: 20,
        order_state: 'open',
      },
      status: 'completed',
      created_at: Date.now(),
      updated_at: Date.now(),
    })

    try {
      await harness.agent.start()

      await harness.bus.publish('bus:SPEECH_FINAL', {
        event: 'SPEECH_FINAL',
        session_id: 'session-1',
        text: 'quiero pagar con tarjeta',
        speaker_id: 'customer-1',
        role: 'customer',
        store_id: 'store-test',
        timestamp: Date.now(),
      })

      expect(harness.interaction.handleToolCall).toHaveBeenCalledWith(
        'payment_intent_create',
        {
          order_id: 'ord-2',
          amount: 20,
          payment_method: 'card',
        },
        'session-1',
        'customer-1',
        'customer',
      )
      expect(harness.interaction.handleProtectedConfirm).toHaveBeenCalledWith('session-1', 'si')
      expect(harness.interaction.handleSpeechFinal).not.toHaveBeenCalled()
    } finally {
      await harness.agent.stop()
      await cleanupHarness(harness)
    }
  })

  it('auto-confirms a protected cash payment when the customer chooses cash', async () => {
    const harness = await createHarness()
    harness.interaction.handleToolCall.mockResolvedValueOnce({
      type: 'needs_confirmation',
      toolId: 'payment_intent_create',
      prompt: 'Tengo listo el cobro. Preparo el pago?',
    })
    harness.orderRepository.insert({
      id: 'ord-cash-1',
      session_id: 'session-1',
      draft_id: null,
      tool_id: 'order_create',
      params: {
        items: [{ product_id: 'sku-cash', quantity: 1, price: 15 }],
      },
      result: {
        order_id: 'ord-cash-1',
        total: 15,
        order_state: 'open',
      },
      status: 'completed',
      created_at: Date.now(),
      updated_at: Date.now(),
    })

    try {
      await harness.agent.start()

      await harness.bus.publish('bus:SPEECH_FINAL', {
        event: 'SPEECH_FINAL',
        session_id: 'session-1',
        text: 'quiero pagar en efectivo',
        speaker_id: 'customer-1',
        role: 'customer',
        store_id: 'store-test',
        timestamp: Date.now(),
      })

      expect(harness.interaction.handleToolCall).toHaveBeenCalledWith(
        'payment_intent_create',
        {
          order_id: 'ord-cash-1',
          amount: 15,
          payment_method: 'cash',
        },
        'session-1',
        'customer-1',
        'customer',
      )
      expect(harness.interaction.handleProtectedConfirm).toHaveBeenCalledWith('session-1', 'si')
      expect(harness.interaction.handleSpeechFinal).not.toHaveBeenCalled()
    } finally {
      await harness.agent.stop()
      await cleanupHarness(harness)
    }
  })

  it('speaks the payment result when the customer chooses card', async () => {
    const harness = await createHarness()
    harness.interaction.handleToolCall.mockResolvedValueOnce({
      type: 'executed',
      toolId: 'payment_intent_create',
      result: {
        text: 'El datafono queda esperando la tarjeta.',
      },
    })
    harness.orderRepository.insert({
      id: 'ord-3',
      session_id: 'session-1',
      draft_id: null,
      tool_id: 'order_create',
      params: {
        items: [{ product_id: 'sku-3', quantity: 1, price: 35 }],
      },
      result: {
        order_id: 'ord-3',
        total: 35,
        order_state: 'open',
      },
      status: 'completed',
      created_at: Date.now(),
      updated_at: Date.now(),
    })

    try {
      await harness.agent.start()

      await harness.bus.publish('bus:SPEECH_FINAL', {
        event: 'SPEECH_FINAL',
        session_id: 'session-1',
        text: 'pago con tarjeta',
        speaker_id: 'customer-1',
        role: 'customer',
        store_id: 'store-test',
        timestamp: Date.now(),
      })

      expect(harness.interaction.handleToolCall).toHaveBeenCalledWith(
        'payment_intent_create',
        {
          order_id: 'ord-3',
          amount: 35,
          payment_method: 'card',
        },
        'session-1',
        'customer-1',
        'customer',
      )
      expect(harness.ttsStream.speakText).toHaveBeenCalledWith(
        'session-1',
        'El datafono queda esperando la tarjeta.',
        6,
      )
      expect(harness.interaction.handleSpeechFinal).not.toHaveBeenCalled()
    } finally {
      await harness.agent.stop()
      await cleanupHarness(harness)
    }
  })

  it('selects the A2 product from the latest visible product list', async () => {
    const harness = await createHarness()

    try {
      await harness.agent.start()
      await publishProductList(harness)

      await harness.bus.publish('bus:SPEECH_FINAL', {
        event: 'SPEECH_FINAL',
        session_id: 'session-1',
        text: 'quiero el A2',
        speaker_id: 'customer-1',
        role: 'customer',
        store_id: 'store-test',
        timestamp: Date.now(),
      })

      expect(harness.interaction.handleToolCall).toHaveBeenCalledWith(
        'order_create',
        {
          items: [
            {
              product_id: 'sku-blue',
              name: 'Cloud Runner Azul',
              quantity: 1,
              price: 95,
            },
          ],
        },
        'session-1',
        'customer-1',
        'customer',
      )
      expect(harness.interaction.handleSpeechFinal).not.toHaveBeenCalled()
    } finally {
      await harness.agent.stop()
      await cleanupHarness(harness)
    }
  })

  it('selects the first product when the customer says el primero', async () => {
    const harness = await createHarness()

    try {
      await harness.agent.start()
      await publishProductList(harness)

      await harness.bus.publish('bus:SPEECH_FINAL', {
        event: 'SPEECH_FINAL',
        session_id: 'session-1',
        text: 'el primero por favor',
        speaker_id: 'customer-1',
        role: 'customer',
        store_id: 'store-test',
        timestamp: Date.now(),
      })

      expect(harness.interaction.handleToolCall).toHaveBeenCalledWith(
        'order_create',
        {
          items: [
            {
              product_id: 'sku-red',
              name: 'Cloud Runner Rojo',
              quantity: 1,
              price: 90,
            },
          ],
        },
        'session-1',
        'customer-1',
        'customer',
      )
      expect(harness.interaction.handleSpeechFinal).not.toHaveBeenCalled()
    } finally {
      await harness.agent.stop()
      await cleanupHarness(harness)
    }
  })

  it('selects a product by a unique visible attribute', async () => {
    const harness = await createHarness()

    try {
      await harness.agent.start()
      await publishProductList(harness)

      await harness.bus.publish('bus:SPEECH_FINAL', {
        event: 'SPEECH_FINAL',
        session_id: 'session-1',
        text: 'me llevo el azul',
        speaker_id: 'customer-1',
        role: 'customer',
        store_id: 'store-test',
        timestamp: Date.now(),
      })

      expect(harness.interaction.handleToolCall).toHaveBeenCalledWith(
        'order_create',
        {
          items: [
            {
              product_id: 'sku-blue',
              name: 'Cloud Runner Azul',
              quantity: 1,
              price: 95,
            },
          ],
        },
        'session-1',
        'customer-1',
        'customer',
      )
      expect(harness.interaction.handleSpeechFinal).not.toHaveBeenCalled()
    } finally {
      await harness.agent.stop()
      await cleanupHarness(harness)
    }
  })

  it('continues through the LLM when visual selection has no active product list', async () => {
    const harness = await createHarness()

    try {
      await harness.agent.start()

      await harness.bus.publish('bus:SPEECH_FINAL', {
        event: 'SPEECH_FINAL',
        session_id: 'session-1',
        text: 'quiero el A2',
        speaker_id: 'customer-1',
        role: 'customer',
        store_id: 'store-test',
        timestamp: Date.now(),
      })

      expect(harness.interaction.handleToolCall).not.toHaveBeenCalled()
      expect(harness.interaction.handleSpeechFinal).toHaveBeenCalled()
    } finally {
      await harness.agent.stop()
      await cleanupHarness(harness)
    }
  })
})

async function publishProductList(harness: Awaited<ReturnType<typeof createHarness>>) {
  await harness.bus.publish('bus:TOOL_RESULT', {
    event: 'TOOL_RESULT',
    tool_name: 'product_search',
    session_id: 'session-1',
    result: {
      products: [
        {
          id: 'sku-red',
          name: 'Cloud Runner Rojo',
          price: 90,
          description: 'Tenis talla 42 color rojo',
          stock: 3,
        },
        {
          id: 'sku-blue',
          name: 'Cloud Runner Azul',
          price: 95,
          description: 'Tenis talla 42 color azul',
          stock: 2,
        },
      ],
    },
    timestamp: Date.now(),
  })
}

async function createHarness(overrides?: {
  runWithSession?: ReturnType<typeof vi.fn>
  captureDriver?: 'local-stt' | 'voice-events' | 'external-bus'
}) {
  const dir = await createTempDir()
  const dbPath = createTempDbPath(dir)
  const db = ensureDb(dbPath)
  const bus = new InMemoryBus()
  const contextStore = new InMemoryContextStore()
  const sessionManager = new InMemorySessionManager()

  const llm = {
    runWithSession:
      overrides?.runWithSession ??
      vi.fn(async (_sessionId: string, fn: () => Promise<unknown>) => fn()),
    abortSession: vi.fn(),
  }

  const interaction = {
    hasPendingConfirmation: vi.fn(() => false),
    handleProtectedConfirm: vi.fn(),
    handleToolCall: vi.fn().mockResolvedValue({
      type: 'needs_confirmation',
      toolId: 'payment_intent_create',
      prompt: 'Tengo listo el cobro. Preparo el pago?',
    }),
    handleDraftFlow: vi.fn(),
    handleSpeechFinal: vi.fn().mockResolvedValue({
      textChunks: [],
      toolResults: [],
      traceId: 'trace-1',
    }),
  }

  const draftStore = {
    getBySession: vi.fn().mockResolvedValue(null),
    cancel: vi.fn().mockResolvedValue(undefined),
  }

  const toolRegistry = {
    runWithContext: vi.fn(async (_ctx, fn: () => Promise<unknown>) => fn()),
  }

  const memoryStore = {
    write: vi.fn().mockResolvedValue(undefined),
  }

  const ttsStream = {
    speakText: vi.fn().mockResolvedValue(undefined),
  }
  const orderRepository = new OrderRepository(db)
  const sessionRepository = new SessionRepository(db)

  const agent = new InteractionRuntimeAgent({
    bus,
    interaction: interaction as never,
    llm: llm as never,
    toolRegistry: toolRegistry as never,
    contextStore,
    sessionManager,
    sessionRepository,
    draftStore: draftStore as never,
    draftRepository: new DraftRepository(db),
    orderRepository,
    ttsStream: ttsStream as never,
    storeId: 'store-test',
    paymentMethods: ['card', 'cash'],
    captureDriver: overrides?.captureDriver ?? 'local-stt',
    memoryStore: memoryStore as never,
    memoryScopeResolver: async () => ({ wing: 'customer', room: 'customer-1' }),
  })

  return {
    agent,
    bus,
    llm,
    interaction,
    draftStore,
    orderRepository,
    sessionRepository,
    ttsStream,
    memoryStore,
    sessionManager,
    dbPath,
    dir,
  }
}

async function cleanupHarness(harness: { dbPath: string; dir: string }) {
  closeTestDb(harness.dbPath)
  await cleanupTempDir(harness.dir)
}
