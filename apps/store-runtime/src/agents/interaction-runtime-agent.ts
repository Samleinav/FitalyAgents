import {
  StreamAgent,
  type IEventBus,
  type HumanRole,
  type IContextStore,
  type InteractionAgent,
  type InMemorySessionManager,
  type ToolCallResult,
} from 'fitalyagents'
import type { IMemoryStore, MemoryScopeResolver } from '@fitalyagents/dispatcher'
import type { SessionBoundLLM } from '../providers/llm/types.js'
import type {
  DraftRepository,
  OrderRepository,
  SessionRepository,
} from '../storage/repositories/index.js'
import type { PersistentDraftStore } from '../bootstrap/persistent-draft-store.js'
import { resolveIngressSessionId } from '../bootstrap/speaker-session.js'
import type { TtsStreamService } from '../bootstrap/tts-stream.js'
import type { ToolRegistry } from '../tools/registry.js'
import type { CustomerDisplaySuggestion } from '../retail/ui/customer-display-state.js'

const STAFF_ROLES = new Set<HumanRole>([
  'staff',
  'agent',
  'cashier',
  'operator',
  'manager',
  'supervisor',
  'owner',
])

export class InteractionRuntimeAgent extends StreamAgent {
  private currentPrimarySpeakerId: string | null = null
  private lastProductList = new Map<string, CustomerDisplaySuggestion[]>()
  private speculativeSessions = new Map<string, { text: string }>()

  constructor(
    private readonly deps: {
      bus: IEventBus
      interaction: InteractionAgent
      llm: SessionBoundLLM
      toolRegistry: ToolRegistry
      contextStore: IContextStore
      sessionManager: InMemorySessionManager
      sessionRepository: SessionRepository
      draftStore: PersistentDraftStore
      draftRepository: DraftRepository
      orderRepository: OrderRepository
      ttsStream: TtsStreamService
      storeId: string
      paymentMethods: string[]
      captureDriver: 'local-stt' | 'voice-events' | 'external-bus'
      memoryStore?: IMemoryStore
      memoryScopeResolver?: MemoryScopeResolver
    },
  ) {
    super(deps.bus)
  }

  protected get channels(): string[] {
    return [
      'bus:SPEECH_FINAL',
      'bus:SPEECH_PARTIAL',
      'bus:SPEECH_PROBABLE',
      'bus:BARGE_IN',
      'bus:TARGET_GROUP_CHANGED',
      'bus:TOOL_RESULT',
    ]
  }

  async onEvent(channel: string, payload: unknown): Promise<void> {
    if (channel === 'bus:TOOL_RESULT') {
      this.rememberProductList(payload)
      return
    }

    if (channel === 'bus:SPEECH_PARTIAL') {
      const ev = payload as { session_id?: string; speaker_id?: string }
      if (ev.session_id) {
        const sid = resolveIngressSessionId({
          storeId: this.deps.storeId,
          captureDriver: this.deps.captureDriver,
          incomingSessionId: ev.session_id,
          speakerId: ev.speaker_id,
        })
        if (sid) void this.ensureSession(sid, ev.speaker_id)
      }
      return
    }

    if (channel === 'bus:SPEECH_PROBABLE') {
      const ev = payload as {
        session_id?: string
        text?: string
        speaker_id?: string
        role?: HumanRole | null
        store_id?: string
      }
      if (ev.session_id && ev.text && !(ev.role && STAFF_ROLES.has(ev.role))) {
        void this.startSpeculativeLLM({
          session_id: ev.session_id,
          text: ev.text,
          speaker_id: ev.speaker_id,
          role: ev.role,
          store_id: ev.store_id,
        })
      }
      return
    }

    if (channel === 'bus:BARGE_IN') {
      const event = payload as { session_id?: string }
      if (event.session_id) {
        this.deps.llm.abortSession(event.session_id)
        this.speculativeSessions.delete(event.session_id)
      }
      return
    }

    if (channel === 'bus:TARGET_GROUP_CHANGED') {
      const event = payload as { primary?: string | null }
      this.currentPrimarySpeakerId = event.primary ?? null
      return
    }

    if (channel !== 'bus:SPEECH_FINAL') {
      return
    }

    const event = payload as {
      session_id?: string
      text?: string
      speaker_id?: string
      role?: HumanRole | null
      store_id?: string
      timestamp?: number
    }

    if (!event.text) {
      return
    }

    if (event.role && STAFF_ROLES.has(event.role)) {
      return
    }

    if (
      event.speaker_id &&
      this.currentPrimarySpeakerId &&
      event.speaker_id !== this.currentPrimarySpeakerId
    ) {
      return
    }

    const runtimeSessionId = resolveIngressSessionId({
      storeId: this.deps.storeId,
      captureDriver: this.deps.captureDriver,
      incomingSessionId: event.session_id,
      speakerId: event.speaker_id,
    })

    if (!runtimeSessionId) {
      return
    }

    const speechEvent = {
      session_id: runtimeSessionId,
      text: event.text,
      speaker_id: event.speaker_id,
      role: event.role ?? 'customer',
      store_id: event.store_id ?? this.deps.storeId,
      timestamp: event.timestamp ?? Date.now(),
    }

    await this.ensureSession(speechEvent.session_id, speechEvent.speaker_id)
    await this.deps.contextStore.patch(speechEvent.session_id, {
      store_id: speechEvent.store_id,
      speaker_id: speechEvent.speaker_id ?? 'unknown',
      speaker_role: speechEvent.role,
      last_user_timestamp: speechEvent.timestamp,
    })
    this.deps.sessionRepository.touch(speechEvent.session_id, {
      speaker_id: speechEvent.speaker_id ?? 'unknown',
      last_user_text: speechEvent.text,
    })

    await this.writeMemory(speechEvent)

    const executionContext = {
      session_id: speechEvent.session_id,
      store_id: speechEvent.store_id,
      speaker_id: speechEvent.speaker_id,
      role: speechEvent.role,
    }

    if (this.deps.interaction.hasPendingConfirmation(speechEvent.session_id)) {
      await this.deps.toolRegistry.runWithContext(executionContext, async () => {
        await this.deps.interaction.handleProtectedConfirm(speechEvent.session_id, speechEvent.text)
      })
      return
    }

    if (await this.handleCorrectionIntent(speechEvent)) {
      return
    }

    if (await this.handleCancelIntent(speechEvent)) {
      return
    }

    const pendingDraft = await this.deps.draftStore.getBySession(speechEvent.session_id)
    if (pendingDraft) {
      if (isFreshBrowseIntent(speechEvent.text)) {
        await this.deps.draftStore.cancel(pendingDraft.id)
      } else if (isCheckoutIntent(speechEvent.text)) {
        await this.deps.ttsStream.speakText(
          speechEvent.session_id,
          'Primero confirmemos la orden. Di si para confirmarla o no para cancelarla.',
          7,
        )
        return
      } else {
        await this.deps.toolRegistry.runWithContext(executionContext, async () => {
          await this.deps.interaction.handleDraftFlow(speechEvent.session_id, speechEvent.text)
        })
        return
      }
    }

    if (await this.handleVisualSelectionIntent(speechEvent, executionContext)) {
      return
    }

    if (await this.handleStoreShortcutIntent(speechEvent, executionContext)) {
      return
    }

    // If speculative LLM was started with same text it's already running — skip duplicate
    const speculative = this.speculativeSessions.get(speechEvent.session_id)
    if (speculative && speculative.text === speechEvent.text) {
      return
    }
    if (speculative) {
      this.deps.llm.abortSession(speechEvent.session_id)
      this.speculativeSessions.delete(speechEvent.session_id)
    }

    try {
      const result = await this.deps.llm.runWithSession(speechEvent.session_id, () =>
        this.deps.toolRegistry.runWithContext(executionContext, () =>
          this.deps.interaction.handleSpeechFinal({
            session_id: speechEvent.session_id,
            text: speechEvent.text,
            speaker_id: speechEvent.speaker_id,
            role: speechEvent.role,
          }),
        ),
      )

      await this.handleToolResults(speechEvent.session_id, result.toolResults)
    } catch (error) {
      if (isAbortLikeError(error)) {
        return
      }

      throw error
    }
  }

  private async startSpeculativeLLM(event: {
    session_id: string
    text: string
    speaker_id?: string
    role?: HumanRole | null
    store_id?: string
  }): Promise<void> {
    const sid = resolveIngressSessionId({
      storeId: this.deps.storeId,
      captureDriver: this.deps.captureDriver,
      incomingSessionId: event.session_id,
      speakerId: event.speaker_id,
    })
    if (!sid) return

    // Cancel any previous speculative inference for this session
    this.deps.llm.abortSession(sid)
    this.speculativeSessions.delete(sid)

    await this.ensureSession(sid, event.speaker_id)
    await this.deps.contextStore.patch(sid, {
      store_id: event.store_id ?? this.deps.storeId,
      speaker_id: event.speaker_id ?? 'unknown',
      speaker_role: event.role ?? 'customer',
      last_user_timestamp: Date.now(),
    })

    this.speculativeSessions.set(sid, { text: event.text })

    const executionContext = {
      session_id: sid,
      store_id: event.store_id ?? this.deps.storeId,
      speaker_id: event.speaker_id,
      role: event.role ?? 'customer',
    }

    try {
      const result = await this.deps.llm.runWithSession(sid, () =>
        this.deps.toolRegistry.runWithContext(executionContext, () =>
          this.deps.interaction.handleSpeechFinal({
            session_id: sid,
            text: event.text,
            speaker_id: event.speaker_id,
            role: event.role ?? 'customer',
          }),
        ),
      )
      await this.handleToolResults(sid, result.toolResults)
    } catch {
      // Aborted by SPEECH_FINAL text mismatch or BARGE_IN — expected
    } finally {
      this.speculativeSessions.delete(sid)
    }
  }

  private async ensureSession(sessionId: string, speakerId?: string): Promise<void> {
    const existing = await this.deps.sessionManager.getSession(sessionId)
    if (existing) {
      return
    }

    await this.deps.sessionManager.createSession(sessionId, {
      speaker_id: speakerId ?? 'unknown',
      store_id: this.deps.storeId,
    })

    this.deps.sessionRepository.upsertStarted(sessionId, this.deps.storeId, {
      speaker_id: speakerId ?? 'unknown',
    })
  }

  private async writeMemory(event: {
    session_id: string
    text: string
    speaker_id?: string
    role?: HumanRole | null
    store_id?: string
    timestamp?: number
  }): Promise<void> {
    if (!this.deps.memoryStore || !this.deps.memoryScopeResolver) {
      return
    }

    const scope = await this.deps.memoryScopeResolver({
      session_id: event.session_id,
      text: event.text,
      speaker_id: event.speaker_id,
      role: event.role ?? 'customer',
      actor_type: event.role ?? 'customer',
      store_id: event.store_id ?? this.deps.storeId,
      timestamp: event.timestamp ?? Date.now(),
    })

    if (!scope) {
      return
    }

    await this.deps.memoryStore.write({
      text: event.text,
      wing: scope.wing,
      room: scope.room,
    })
  }

  private async handleToolResults(sessionId: string, results: ToolCallResult[]): Promise<void> {
    for (const result of results) {
      switch (result.type) {
        case 'executed':
        case 'cached': {
          const text = extractResultText(result.result)
          if (text) {
            await this.deps.ttsStream.speakText(sessionId, text, 6)
          }
          break
        }
        case 'draft_ready': {
          const draft = this.deps.draftRepository.findById(result.draftId)
          const prompt = draft
            ? promptForDraftTool(draft.tool_id)
            : 'Tengo la solicitud lista. Confirmas?'
          await this.deps.ttsStream.speakText(sessionId, prompt, 7)
          break
        }
        case 'needs_confirmation':
          break
        case 'pending_approval': {
          if (result.approved === true) {
            await this.deps.ttsStream.speakText(
              sessionId,
              'La solicitud fue aprobada correctamente.',
              7,
            )
          } else if (result.approved === false) {
            await this.deps.ttsStream.speakText(sessionId, 'La solicitud fue rechazada.', 7)
          }
          break
        }
        case 'error':
          await this.deps.ttsStream.speakText(
            sessionId,
            'Hubo un error al procesar la solicitud.',
            8,
          )
          break
      }
    }
  }

  private async handleCorrectionIntent(event: {
    session_id: string
    text: string
  }): Promise<boolean> {
    if (!isCorrectionIntent(event.text)) {
      return false
    }

    const draft = await this.deps.draftStore.getBySession(event.session_id)
    if (!draft) {
      return false
    }

    await this.deps.draftStore.cancel(draft.id)
    await this.deps.ttsStream.speakText(
      event.session_id,
      this.buildCorrectionPrompt(event.session_id, draft.items),
      6,
    )
    return true
  }

  private buildCorrectionPrompt(sessionId: string, draftItems: Record<string, unknown>): string {
    const products = this.lastProductList.get(sessionId) ?? []
    if (products.length === 0) {
      return 'Cual prefieres? Dime el codigo o describelo.'
    }

    const draftProductIds = extractDraftProductIds(draftItems)
    const alternatives = products.filter((product) => !draftProductIds.has(product.id))
    const visibleOptions = alternatives.length > 0 ? alternatives : products
    const optionText = visibleOptions
      .map((product) => `${product.visualId} ${product.name}`)
      .join(', ')

    return `Cual prefieres? ${optionText}.`
  }

  private async handleCancelIntent(event: { session_id: string; text: string }): Promise<boolean> {
    if (!isCancelIntent(event.text)) {
      return false
    }

    const draft = await this.deps.draftStore.getBySession(event.session_id)
    if (draft) {
      await this.deps.draftStore.cancel(draft.id)
      await this.deps.ttsStream.speakText(event.session_id, 'Listo, cancelo el pedido.', 6)
      return true
    }

    if (this.findLatestOpenOrder(event.session_id)) {
      await this.deps.ttsStream.speakText(
        event.session_id,
        'No tengo nada pendiente que cancelar. Quieres buscar otro producto?',
        6,
      )
      return true
    }

    return false
  }

  private rememberProductList(payload: unknown): void {
    const event = toRecord(payload)
    const toolName = readString(event.tool_name) ?? readString(event.tool_id)
    const sessionId = readString(event.session_id)

    if (!sessionId || (toolName !== 'product_search' && toolName !== 'inventory_check')) {
      return
    }

    const products = extractSuggestionsFromResult(event.result)
    if (products.length > 0) {
      this.lastProductList.set(sessionId, products)
    }
  }

  private async handleVisualSelectionIntent(
    event: {
      session_id: string
      text: string
      speaker_id?: string
      role: HumanRole
      store_id: string
    },
    executionContext: {
      session_id: string
      store_id: string
      speaker_id?: string
      role?: HumanRole | null
    },
  ): Promise<boolean> {
    const product = this.resolveVisualIdSelection(event.text, event.session_id)
    if (!product) {
      return false
    }

    const result = await this.deps.toolRegistry.runWithContext(executionContext, () =>
      this.deps.interaction.handleToolCall(
        'order_create',
        {
          items: [
            {
              product_id: product.id,
              name: product.name,
              quantity: 1,
              price: product.price,
            },
          ],
        },
        event.session_id,
        event.speaker_id,
        event.role,
      ),
    )

    await this.handleToolResults(event.session_id, [result])
    return true
  }

  private resolveVisualIdSelection(
    text: string,
    sessionId: string,
  ): CustomerDisplaySuggestion | null {
    const products = this.lastProductList.get(sessionId)
    if (!products || products.length === 0) {
      return null
    }

    const normalized = normalizeIntentText(text)
    const visualMatch = /\ba\s*([1-6])\b/.exec(normalized)
    if (visualMatch) {
      return products[Number(visualMatch[1]) - 1] ?? null
    }

    const ordinalIndex = readOrdinalIndex(normalized)
    if (ordinalIndex != null) {
      return products[ordinalIndex] ?? null
    }

    const priceSelection = resolvePriceSelection(normalized, products)
    if (priceSelection) {
      return priceSelection
    }

    const terms = extractAttributeTerms(normalized)
    if (terms.length === 0) {
      return null
    }

    const matches = products.filter((product) => {
      const haystack = normalizeIntentText(
        [product.visualId, product.id, product.name, product.description].join(' '),
      )
      return terms.some((term) => haystack.includes(term))
    })

    return matches.length === 1 ? matches[0] : null
  }

  private async handleStoreShortcutIntent(
    event: {
      session_id: string
      text: string
      speaker_id?: string
      role: HumanRole
      store_id: string
    },
    executionContext: {
      session_id: string
      store_id: string
      speaker_id?: string
      role?: HumanRole | null
    },
  ): Promise<boolean> {
    if (isFarewellIntent(event.text)) {
      const order = this.findLatestActiveOrder(event.session_id)
      const result = toRecord(order?.result)
      const hasPaymentStarted = typeof result.payment_status === 'string'
      await this.deps.ttsStream.speakText(
        event.session_id,
        hasPaymentStarted ? 'Gracias por tu compra. Hasta luego.' : 'Con gusto. Hasta luego.',
        6,
      )
      this.deps.sessionRepository.end(event.session_id, {
        closed_by: 'farewell',
        last_user_text: event.text,
      })
      await this.deps.bus.publish('bus:SESSION_ENDED', {
        event: 'SESSION_ENDED',
        session_id: event.session_id,
        store_id: event.store_id,
        timestamp: Date.now(),
      })
      return true
    }

    if (!isCheckoutIntent(event.text)) {
      return false
    }

    const order = this.findLatestActiveOrder(event.session_id)
    if (!order) {
      await this.deps.ttsStream.speakText(
        event.session_id,
        'Todavia no tengo una orden lista. Primero elige un producto de la pantalla o dime que quieres comprar.',
        7,
      )
      return true
    }

    const total = resolveOrderTotal(order)
    const allowedMethods = this.getAllowedPaymentMethods()
    const requestedMethod = detectRequestedPaymentMethod(event.text)

    if (requestedMethod && !allowedMethods.includes(requestedMethod)) {
      await this.deps.ttsStream.speakText(
        event.session_id,
        `Por ahora puedo preparar pago con ${formatPaymentOptions(allowedMethods)}.`,
        7,
      )
      return true
    }

    if (!requestedMethod) {
      await this.deps.ttsStream.speakText(
        event.session_id,
        `Tu orden va en ${formatCurrency(total)}. Puedes pagar con ${formatPaymentOptions(
          allowedMethods,
        )}. Cual prefieres?`,
        7,
      )
      return true
    }

    const result = await this.deps.toolRegistry.runWithContext(executionContext, () =>
      this.deps.interaction.handleToolCall(
        'payment_intent_create',
        {
          order_id: order.id,
          amount: total,
          payment_method: requestedMethod,
        },
        event.session_id,
        event.speaker_id,
        event.role,
      ),
    )

    if (result.type === 'draft_ready' || result.type === 'needs_confirmation') {
      await this.deps.toolRegistry.runWithContext(executionContext, async () => {
        await this.deps.interaction.handleProtectedConfirm(event.session_id, 'si')
      })
      return true
    }

    await this.handleToolResults(event.session_id, [result])
    return true
  }

  private findLatestActiveOrder(sessionId: string): {
    id: string
    params: Record<string, unknown>
    result?: Record<string, unknown> | null
    status: string
  } | null {
    return (
      this.deps.orderRepository.listBySession(sessionId).find((order) => {
        if (order.status !== 'completed') {
          return false
        }

        const result = toRecord(order.result)
        const orderState = typeof result.order_state === 'string' ? result.order_state : 'open'
        return orderState !== 'cancelled' && resolveOrderTotal(order) > 0
      }) ?? null
    )
  }

  private getAllowedPaymentMethods(): string[] {
    const configured = this.deps.paymentMethods
      .map((method) => method.trim())
      .filter((method) => method.length > 0)
    return configured.length > 0 ? configured : ['card', 'cash']
  }

  private findLatestOpenOrder(sessionId: string): {
    id: string
    params: Record<string, unknown>
    result?: Record<string, unknown> | null
    status: string
  } | null {
    return (
      this.deps.orderRepository.listBySession(sessionId).find((order) => {
        if (order.status !== 'completed') {
          return false
        }

        const result = toRecord(order.result)
        const orderState = typeof result.order_state === 'string' ? result.order_state : 'open'
        return orderState === 'open'
      }) ?? null
    )
  }
}

function extractResultText(result: unknown): string | null {
  if (result && typeof result === 'object' && 'text' in result && typeof result.text === 'string') {
    return result.text
  }

  return null
}

function extractSuggestionsFromResult(result: unknown): CustomerDisplaySuggestion[] {
  const value = toRecord(result).products ?? result
  if (!Array.isArray(value)) {
    return []
  }

  const suggestions: Omit<CustomerDisplaySuggestion, 'visualId'>[] = []
  for (const entry of value) {
    const record = toRecord(entry)
    const id = readString(record.id)
    const name = readString(record.name)
    const price = readNumber(record.price)
    const stock = readNumber(record.stock)
    if (!id || !name || price == null) {
      continue
    }

    suggestions.push({
      id,
      name,
      price,
      description: readString(record.description) ?? '',
      stock: stock ?? undefined,
      stockStatus: readStockStatus(stock),
    })
  }

  return suggestions.slice(0, 6).map((suggestion, index) => ({
    ...suggestion,
    visualId: `A${index + 1}`,
  }))
}

function readOrdinalIndex(normalized: string): number | null {
  const ordinalByWord = new Map<string, number>([
    ['primer', 0],
    ['primero', 0],
    ['primera', 0],
    ['segundo', 1],
    ['segunda', 1],
    ['tercero', 2],
    ['tercera', 2],
    ['cuarto', 3],
    ['cuarta', 3],
  ])

  for (const token of normalized.split(' ')) {
    const index = ordinalByWord.get(token)
    if (index != null) {
      return index
    }
  }

  return null
}

function resolvePriceSelection(
  normalized: string,
  products: CustomerDisplaySuggestion[],
): CustomerDisplaySuggestion | null {
  if (/\b(barato|barata|economico|economica|menor precio)\b/.test(normalized)) {
    return uniqueByPrice(products, Math.min(...products.map((product) => product.price)))
  }

  if (/\b(caro|cara|costoso|costosa|mayor precio)\b/.test(normalized)) {
    return uniqueByPrice(products, Math.max(...products.map((product) => product.price)))
  }

  return null
}

function uniqueByPrice(
  products: CustomerDisplaySuggestion[],
  price: number,
): CustomerDisplaySuggestion | null {
  const matches = products.filter((product) => product.price === price)
  return matches.length === 1 ? matches[0] : null
}

function extractDraftProductIds(items: Record<string, unknown>): Set<string> {
  const ids = new Set<string>()
  collectDraftProductIds(items, ids)
  return ids
}

function collectDraftProductIds(value: unknown, ids: Set<string>): void {
  if (Array.isArray(value)) {
    for (const entry of value) {
      collectDraftProductIds(entry, ids)
    }
    return
  }

  const record = toRecord(value)
  if (Object.keys(record).length === 0) {
    return
  }

  const productId = readString(record.product_id) ?? readString(record.id)
  if (productId) {
    ids.add(productId)
  }

  for (const entry of Object.values(record)) {
    if (entry && typeof entry === 'object') {
      collectDraftProductIds(entry, ids)
    }
  }
}

function readStockStatus(stock: number | null): CustomerDisplaySuggestion['stockStatus'] {
  if (stock === 0) {
    return 'out'
  }

  if (stock != null && stock > 0 && stock <= 5) {
    return 'low'
  }

  return 'available'
}

function extractAttributeTerms(normalized: string): string[] {
  const stopwords = new Set([
    'a',
    'al',
    'con',
    'dame',
    'de',
    'del',
    'el',
    'esa',
    'ese',
    'eso',
    'la',
    'las',
    'lo',
    'los',
    'me',
    'para',
    'por',
    'quiero',
    'un',
    'una',
    'uno',
    'favor',
    'producto',
    'opcion',
  ])

  return normalized
    .split(' ')
    .map((token) => token.trim())
    .filter((token) => token.length > 1 && !stopwords.has(token) && !/^a[1-6]$/.test(token))
}

function isAbortLikeError(error: unknown): boolean {
  if (!error || typeof error !== 'object') {
    return false
  }

  const candidate = error as { name?: unknown; message?: unknown }
  return (
    candidate.name === 'AbortError' ||
    (typeof candidate.message === 'string' && candidate.message.toLowerCase().includes('abort'))
  )
}

function isFreshBrowseIntent(text: string): boolean {
  const normalized = normalizeIntentText(text)

  if (
    /(agrega|agregar|anade|anadir|comprar|compra|pedido|orden|carrito|confirm)/.test(normalized)
  ) {
    return false
  }

  return (
    /^(quiero ver|me puedes mostrar|puedes mostrar|muestrame|mostrar|busco|buscar|ver)\b/.test(
      normalized,
    ) &&
    /(producto|productos|catalogo|tenis|zapato|zapatos|zapatilla|zapatillas|nike|adidas|puma|talla)/.test(
      normalized,
    )
  )
}

function isCheckoutIntent(text: string): boolean {
  const normalized = normalizeIntentText(text)
  return /\b(pagar|pago|pagamos|cobrar|cobro|checkout|finalizar|cerrar|datafono|tarjeta|efectivo|cash)\b/.test(
    normalized,
  )
}

function isCorrectionIntent(text: string): boolean {
  const normalized = normalizeIntentText(text)
  return /\b(mejor el otro|cambia al|prefiero el otro|no ese|no esa|quiero el otro|ese no)\b/.test(
    normalized,
  )
}

function isCancelIntent(text: string): boolean {
  const normalized = normalizeIntentText(text)
  return /^(cancela|cancelar|cancelo|anula|anular|olvida|olvida eso|dejalo|no importa|no gracias olvida)\b/.test(
    normalized,
  )
}

function isFarewellIntent(text: string): boolean {
  const normalized = normalizeIntentText(text)
  return (
    /^(gracias|muchas gracias|listo gracias|eso es todo|hasta luego|adios|chao|bye)\b/.test(
      normalized,
    ) || /\b(nada mas|eso es todo)\b/.test(normalized)
  )
}

function detectRequestedPaymentMethod(text: string): string | null {
  const normalized = normalizeIntentText(text)
  if (/\b(tarjeta|datafono|card|credito|debito|tpv)\b/.test(normalized)) {
    return 'card'
  }
  if (/\b(efectivo|cash|contado)\b/.test(normalized)) {
    return 'cash'
  }
  if (/\b(sinpe|transferencia|transfer)\b/.test(normalized)) {
    return 'transfer'
  }
  return null
}

function resolveOrderTotal(order: {
  params: Record<string, unknown>
  result?: Record<string, unknown> | null
}): number {
  const resultTotal = readNumber(toRecord(order.result).total)
  if (resultTotal != null) {
    return resultTotal
  }

  const items = Array.isArray(order.params.items) ? order.params.items : []
  return items.reduce((sum, item) => {
    const line = toRecord(item)
    const quantity = readNumber(line.quantity) ?? 0
    const price = readNumber(line.price) ?? 0
    return sum + quantity * price
  }, 0)
}

function formatPaymentOptions(methods: string[]): string {
  return methods.map(labelPaymentMethod).join(' o ')
}

function labelPaymentMethod(method: string): string {
  switch (method) {
    case 'card':
      return 'tarjeta'
    case 'cash':
      return 'efectivo'
    default:
      return method
  }
}

function formatCurrency(amount: number): string {
  return new Intl.NumberFormat('es', {
    style: 'currency',
    currency: 'USD',
  }).format(amount)
}

function promptForDraftTool(toolId: string): string {
  switch (toolId) {
    case 'order_create':
      return 'Tengo la orden lista. Confirmas?'
    case 'order_update':
      return 'Tengo los cambios de la orden listos. Confirmas?'
    case 'customer_register':
      return 'Tengo los datos del cliente listos. Confirmas?'
    default:
      return 'Tengo la solicitud lista. Confirmas?'
  }
}

function toRecord(value: unknown): Record<string, unknown> {
  return value && typeof value === 'object' ? (value as Record<string, unknown>) : {}
}

function readString(value: unknown): string | null {
  return typeof value === 'string' && value.length > 0 ? value : null
}

function readNumber(value: unknown): number | null {
  return typeof value === 'number' && Number.isFinite(value) ? value : null
}

function normalizeIntentText(text: string): string {
  return text
    .normalize('NFD')
    .replace(/[\u0300-\u036f]/g, '')
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, ' ')
    .trim()
}
