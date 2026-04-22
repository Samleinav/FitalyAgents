export interface CustomerDisplayLineItem {
  productId: string
  name: string
  quantity: number
  unitPrice: number
  lineTotal: number
}

export interface CustomerDisplayOrderChange {
  type: 'added' | 'removed' | 'updated'
  label: string
  quantity: number
  timestamp: number
}

export interface CustomerDisplayMessage {
  title: string
  body: string
  tone: 'info' | 'success' | 'warning'
  updatedAt: number
}

export interface CustomerDisplaySuggestion {
  id: string
  name: string
  price: number
  description: string
}

export interface CustomerDisplayState {
  storeId: string
  mode: 'order' | 'full'
  updatedAt: number | null
  sessionId: string | null
  speakerId: string | null
  order: {
    draftId: string | null
    orderId: string | null
    status: 'idle' | 'draft' | 'open' | 'confirmed'
    items: CustomerDisplayLineItem[]
    recentChanges: CustomerDisplayOrderChange[]
    subtotal: number
    tax: number
    discount: number
    total: number
    paymentStatus: 'idle' | 'waiting' | 'processing' | 'approved' | 'declined'
    paymentMethod: string | null
    receiptStatus: 'idle' | 'printed'
    receiptId: string | null
    refundStatus: 'idle' | 'pending_approval' | 'approved' | 'rejected' | 'timeout'
    refundId: string | null
    approvalStatus: 'idle' | 'waiting' | 'approved' | 'rejected' | 'timeout'
  }
  suggestions: CustomerDisplaySuggestion[]
  message: CustomerDisplayMessage | null
}

const MAX_RECENT_CHANGES = 6
const MAX_SUGGESTIONS = 6

export class CustomerDisplayStateStore {
  private state: CustomerDisplayState

  constructor(storeId: string, mode: 'order' | 'full') {
    this.state = createCustomerDisplayState(storeId, mode)
  }

  apply(channel: string, payload: unknown): CustomerDisplayState {
    this.state = applyCustomerDisplayBusEvent(this.state, channel, payload)
    return this.state
  }

  getState(): CustomerDisplayState {
    return this.state
  }
}

export function createCustomerDisplayState(
  storeId: string,
  mode: 'order' | 'full',
): CustomerDisplayState {
  return {
    storeId,
    mode,
    updatedAt: null,
    sessionId: null,
    speakerId: null,
    order: {
      draftId: null,
      orderId: null,
      status: 'idle',
      items: [],
      recentChanges: [],
      subtotal: 0,
      tax: 0,
      discount: 0,
      total: 0,
      paymentStatus: 'idle',
      paymentMethod: null,
      receiptStatus: 'idle',
      receiptId: null,
      refundStatus: 'idle',
      refundId: null,
      approvalStatus: 'idle',
    },
    suggestions: [],
    message: null,
  }
}

export function applyCustomerDisplayBusEvent(
  current: CustomerDisplayState,
  channel: string,
  payload: unknown,
): CustomerDisplayState {
  const event = toRecord(payload)
  const timestamp = readTimestamp(event)
  const next = cloneState(current)

  switch (channel) {
    case 'bus:DRAFT_CREATED':
      applyDraftCreated(next, event, timestamp)
      break

    case 'bus:DRAFT_CONFIRMED':
      applyDraftConfirmed(next, event, timestamp)
      break

    case 'bus:DRAFT_CANCELLED':
      applyDraftCancelled(next, event, timestamp)
      break

    case 'bus:TOOL_RESULT':
      applyToolResult(next, event, timestamp)
      break

    case 'bus:UI_UPDATE':
      applyUiUpdate(next, event, timestamp)
      break

    case 'bus:ORDER_QUEUED_NO_APPROVER':
      applyApprovalQueued(next, event, timestamp)
      break

    case 'bus:APPROVAL_RESOLVED':
      applyApprovalResolved(next, event, timestamp)
      break

    case 'bus:ORDER_APPROVAL_TIMEOUT':
      applyApprovalTimeout(next, timestamp)
      break

    case 'bus:AVATAR_SPEAK':
      applyAvatarSpeak(next, event, timestamp)
      break

    default:
      return current
  }

  if (typeof event.store_id === 'string' && event.store_id) {
    next.storeId = event.store_id
  }
  next.updatedAt = timestamp
  return next
}

function applyDraftCreated(
  state: CustomerDisplayState,
  event: Record<string, unknown>,
  timestamp: number,
): void {
  const intentId = readString(event.intent_id)
  if (!intentId || (intentId !== 'order_create' && intentId !== 'order_update')) {
    return
  }

  const summary = toRecord(event.summary)
  const draftItems = projectDraftItems(intentId, summary, state.order.items)

  state.sessionId = readString(event.session_id) ?? state.sessionId
  state.order.draftId = readString(event.draft_id)
  state.order.status = 'draft'
  applyOrderItems(state, draftItems, timestamp)
  state.order.total = inferTotal(summary, draftItems)
  state.order.subtotal = state.order.total
  state.order.approvalStatus = 'idle'
  state.order.paymentStatus = 'idle'
  state.message = {
    title: 'Orden en preparación',
    body: 'Estamos preparando tu pedido para confirmarlo contigo.',
    tone: 'info',
    updatedAt: timestamp,
  }
}

function applyDraftConfirmed(
  state: CustomerDisplayState,
  event: Record<string, unknown>,
  timestamp: number,
): void {
  const intentId = readString(event.intent_id)
  if (!intentId || (intentId !== 'order_create' && intentId !== 'order_update')) {
    return
  }

  const items = projectDraftItems(intentId, toRecord(event.items), state.order.items)
  state.sessionId = readString(event.session_id) ?? state.sessionId
  state.order.draftId = null
  state.order.status = items.length > 0 ? 'open' : state.order.status
  applyOrderItems(state, items, timestamp)
  state.order.total = readNumber(event.total) ?? sumLineTotals(items)
  state.order.subtotal = state.order.total
  state.message = {
    title: 'Orden confirmada',
    body: 'Tu pedido quedó confirmado y listo para seguir con el cobro.',
    tone: 'success',
    updatedAt: timestamp,
  }
}

function applyDraftCancelled(
  state: CustomerDisplayState,
  event: Record<string, unknown>,
  timestamp: number,
): void {
  const draftId = readString(event.draft_id)
  if (draftId && state.order.draftId && draftId !== state.order.draftId) {
    return
  }

  state.order.draftId = null
  if (!state.order.orderId) {
    state.order.status = 'idle'
    state.order.items = []
    state.order.recentChanges = []
    state.order.total = 0
    state.order.subtotal = 0
  } else if (state.order.status === 'draft') {
    state.order.status = 'open'
  }
  state.message = {
    title: 'Orden cancelada',
    body: 'El borrador de la orden fue cancelado.',
    tone: 'warning',
    updatedAt: timestamp,
  }
}

function applyToolResult(
  state: CustomerDisplayState,
  event: Record<string, unknown>,
  timestamp: number,
): void {
  const toolName = readString(event.tool_name) ?? readString(event.tool_id)
  if (!toolName) {
    return
  }

  state.sessionId = readString(event.session_id) ?? state.sessionId
  state.speakerId = readString(event.speaker_id) ?? state.speakerId

  if (toolName === 'product_search' || toolName === 'inventory_check') {
    const products = readProductSuggestions(toRecord(event.result).products ?? event.result)
    if (products.length > 0) {
      state.suggestions = products.slice(0, MAX_SUGGESTIONS)
    }
    applyResultMessage(state, toRecord(event.result), timestamp)
    return
  }

  if (toolName === 'order_create' || toolName === 'order_update') {
    const result = toRecord(event.result)
    const input = toRecord(event.input)
    const nextItems =
      readOrderLines(result.items) ??
      (toolName === 'order_update'
        ? applyOrderInputToCurrent(state.order.items, input)
        : (readOrderLines(input.items) ?? []))

    state.order.orderId = readString(result.order_id) ?? state.order.orderId
    state.order.draftId = null
    state.order.status = readString(result.order_state) === 'confirmed' ? 'confirmed' : 'open'
    applyOrderItems(state, nextItems, timestamp)
    state.order.total = readNumber(result.total) ?? sumLineTotals(nextItems)
    state.order.subtotal = state.order.total
    applyResultMessage(state, result, timestamp)
    return
  }

  if (toolName === 'order_confirm') {
    const result = toRecord(event.result)
    const nextItems = readOrderLines(result.items) ?? state.order.items
    state.order.orderId = readString(result.order_id) ?? state.order.orderId
    state.order.status = 'confirmed'
    applyOrderItems(state, nextItems, timestamp)
    state.order.total = readNumber(result.total) ?? state.order.total
    state.order.subtotal = state.order.total
    state.order.paymentStatus = 'waiting'
    applyResultMessage(state, result, timestamp)
    return
  }

  if (toolName === 'payment_intent_create') {
    const result = toRecord(event.result)
    state.order.orderId = readString(result.order_id) ?? state.order.orderId
    state.order.paymentStatus = mapPaymentStatus(readString(result.status))
    state.order.paymentMethod = readString(result.payment_method)
    state.order.total = readNumber(result.amount) ?? state.order.total
    state.order.subtotal = state.order.total
    applyResultMessage(state, result, timestamp)
    return
  }

  if (toolName === 'receipt_print') {
    const result = toRecord(event.result)
    state.order.receiptStatus = 'printed'
    state.order.receiptId = readString(result.receipt_id)
    applyResultMessage(state, result, timestamp)
    return
  }

  if (toolName === 'refund_create') {
    const result = toRecord(event.result)
    state.order.refundId = readString(result.refund_id)
    state.order.refundStatus = mapRefundStatus(readString(result.status))
    applyResultMessage(state, result, timestamp)
  }
}

function applyUiUpdate(
  state: CustomerDisplayState,
  event: Record<string, unknown>,
  timestamp: number,
): void {
  const component = readString(event.component)
  const action = readString(event.action)
  const data = toRecord(event.data)

  if (!component || !action) {
    return
  }

  if (component === 'product_grid') {
    const products = readProductSuggestions(data.results)
    if (products.length > 0) {
      state.suggestions = products.slice(0, MAX_SUGGESTIONS)
    }
    return
  }

  if (component === 'order_panel') {
    if (action === 'hide') {
      state.order.draftId = null
      if (!state.order.orderId) {
        state.order.status = 'idle'
        state.order.items = []
        state.order.recentChanges = []
        state.order.total = 0
        state.order.subtotal = 0
      }
      return
    }

    state.order.draftId = readString(data.draft_id)
    state.order.status = action === 'confirmed' ? 'open' : 'draft'
    const items = projectDraftItems(
      'order_create',
      data.summary ? data : { items: data.items },
      state.order.items,
    )
    if (items.length > 0) {
      applyOrderItems(state, items, timestamp)
    }
    state.order.total = inferTotal(data, items.length > 0 ? items : state.order.items)
    state.order.subtotal = state.order.total
    return
  }

  if (component === 'approval_queue') {
    state.order.approvalStatus = 'waiting'
    state.message = {
      title: 'Esperando aprobación',
      body: 'Estamos esperando autorización del personal para continuar.',
      tone: 'warning',
      updatedAt: timestamp,
    }
    return
  }

  if (component === 'approval_bar' && typeof data.approved === 'boolean') {
    state.order.approvalStatus = data.approved ? 'approved' : 'rejected'
    state.message = {
      title: data.approved ? 'Aprobación recibida' : 'Solicitud rechazada',
      body: data.approved
        ? 'La acción fue aprobada por el personal autorizado.'
        : 'La acción solicitada no fue autorizada.',
      tone: data.approved ? 'success' : 'warning',
      updatedAt: timestamp,
    }
    return
  }

  if (component === 'suggestion') {
    const context = toRecord(data.context)
    const products = readProductSuggestions(context.products)
    if (products.length > 0) {
      state.suggestions = products.slice(0, MAX_SUGGESTIONS)
    }
  }
}

function applyApprovalQueued(
  state: CustomerDisplayState,
  event: Record<string, unknown>,
  timestamp: number,
): void {
  state.sessionId = readString(event.session_id) ?? state.sessionId
  state.order.approvalStatus = 'waiting'
  state.message = {
    title: 'Esperando aprobación',
    body: 'Un miembro del equipo debe aprobar esta acción antes de continuar.',
    tone: 'warning',
    updatedAt: timestamp,
  }
}

function applyApprovalResolved(
  state: CustomerDisplayState,
  event: Record<string, unknown>,
  timestamp: number,
): void {
  state.sessionId = readString(event.session_id) ?? state.sessionId
  state.order.approvalStatus = event.approved === true ? 'approved' : 'rejected'
  state.message = {
    title: event.approved === true ? 'Aprobación recibida' : 'No fue posible aprobar',
    body:
      event.approved === true
        ? 'La tienda ya recibió la aprobación necesaria para continuar.'
        : 'La tienda no pudo aprobar la acción solicitada.',
    tone: event.approved === true ? 'success' : 'warning',
    updatedAt: timestamp,
  }
}

function applyApprovalTimeout(state: CustomerDisplayState, timestamp: number): void {
  state.order.approvalStatus = 'timeout'
  state.message = {
    title: 'Solicitud expirada',
    body: 'La autorización no llegó a tiempo. Puedes intentar nuevamente con el personal.',
    tone: 'warning',
    updatedAt: timestamp,
  }
}

function applyAvatarSpeak(
  state: CustomerDisplayState,
  event: Record<string, unknown>,
  timestamp: number,
): void {
  const text = readString(event.text)
  if (!text) {
    return
  }

  state.sessionId = readString(event.session_id) ?? state.sessionId
  state.speakerId = readString(event.speaker_id) ?? state.speakerId
  state.message = {
    title: 'Asistente',
    body: text,
    tone: 'info',
    updatedAt: timestamp,
  }
}

function applyOrderItems(
  state: CustomerDisplayState,
  nextItems: CustomerDisplayLineItem[],
  timestamp: number,
): void {
  const previous = state.order.items
  state.order.items = nextItems
  state.order.recentChanges = diffOrderItems(previous, nextItems, timestamp).slice(
    0,
    MAX_RECENT_CHANGES,
  )
}

function diffOrderItems(
  previous: CustomerDisplayLineItem[],
  next: CustomerDisplayLineItem[],
  timestamp: number,
): CustomerDisplayOrderChange[] {
  const previousMap = new Map(previous.map((item) => [item.productId, item]))
  const nextMap = new Map(next.map((item) => [item.productId, item]))
  const changes: CustomerDisplayOrderChange[] = []

  for (const item of next) {
    const current = previousMap.get(item.productId)
    if (!current) {
      changes.push({
        type: 'added',
        label: item.name,
        quantity: item.quantity,
        timestamp,
      })
      continue
    }

    if (current.quantity !== item.quantity || current.unitPrice !== item.unitPrice) {
      changes.push({
        type: 'updated',
        label: item.name,
        quantity: item.quantity,
        timestamp,
      })
    }
  }

  for (const item of previous) {
    if (!nextMap.has(item.productId)) {
      changes.push({
        type: 'removed',
        label: item.name,
        quantity: item.quantity,
        timestamp,
      })
    }
  }

  return changes
}

function projectDraftItems(
  intentId: string,
  summary: Record<string, unknown>,
  currentItems: CustomerDisplayLineItem[],
): CustomerDisplayLineItem[] {
  if (intentId === 'order_update') {
    return applyOrderInputToCurrent(currentItems, summary)
  }

  return readOrderLines(summary.items) ?? readOrderLines(summary) ?? currentItems
}

function applyOrderInputToCurrent(
  currentItems: CustomerDisplayLineItem[],
  input: Record<string, unknown>,
): CustomerDisplayLineItem[] {
  const explicitItems = readOrderLines(input.items)
  if (explicitItems) {
    return explicitItems
  }

  const merged = new Map(currentItems.map((item) => [item.productId, { ...item }]))
  const additions = readOrderLines(input.add_items) ?? []
  for (const item of additions) {
    const current = merged.get(item.productId)
    if (current) {
      current.quantity += item.quantity
      current.lineTotal = current.quantity * current.unitPrice
    } else {
      merged.set(item.productId, { ...item })
    }
  }

  const removeIds = readStringArray(input.remove_product_ids)
  for (const productId of removeIds) {
    merged.delete(productId)
  }

  return [...merged.values()]
}

function readOrderLines(value: unknown): CustomerDisplayLineItem[] | null {
  if (!Array.isArray(value)) {
    return null
  }

  const items = value.flatMap((entry) => {
    if (!entry || typeof entry !== 'object') {
      return []
    }

    const record = entry as Record<string, unknown>
    const productId = readString(record.product_id) ?? readString(record.id)
    const quantity = readNumber(record.quantity)
    const unitPrice = readNumber(record.price)

    if (!productId || quantity == null || unitPrice == null || quantity <= 0) {
      return []
    }

    return [
      {
        productId,
        name: readString(record.name) ?? productId,
        quantity,
        unitPrice,
        lineTotal: readNumber(record.line_total) ?? quantity * unitPrice,
      },
    ]
  })

  return items
}

function readProductSuggestions(value: unknown): CustomerDisplaySuggestion[] {
  if (!Array.isArray(value)) {
    return []
  }

  return value.flatMap((entry) => {
    if (!entry || typeof entry !== 'object') {
      return []
    }

    const record = entry as Record<string, unknown>
    const id = readString(record.id)
    const name = readString(record.name)
    const price = readNumber(record.price)
    if (!id || !name || price == null) {
      return []
    }

    return [
      {
        id,
        name,
        price,
        description: readString(record.description) ?? '',
      },
    ]
  })
}

function applyResultMessage(
  state: CustomerDisplayState,
  result: Record<string, unknown>,
  timestamp: number,
): void {
  const text = readString(result.text)
  if (!text) {
    return
  }

  state.message = {
    title: 'Actualización de tienda',
    body: text,
    tone: 'info',
    updatedAt: timestamp,
  }
}

function inferTotal(source: Record<string, unknown>, items: CustomerDisplayLineItem[]): number {
  return readNumber(source.total) ?? sumLineTotals(items)
}

function sumLineTotals(items: CustomerDisplayLineItem[]): number {
  return items.reduce((sum, item) => sum + item.lineTotal, 0)
}

function mapPaymentStatus(value: string | null): CustomerDisplayState['order']['paymentStatus'] {
  switch (value) {
    case 'approved':
      return 'approved'
    case 'declined':
      return 'declined'
    case 'processing':
      return 'processing'
    case 'ready':
    case 'awaiting_payment':
      return 'waiting'
    default:
      return 'idle'
  }
}

function mapRefundStatus(value: string | null): CustomerDisplayState['order']['refundStatus'] {
  switch (value) {
    case 'approved':
      return 'approved'
    case 'rejected':
      return 'rejected'
    case 'timeout':
      return 'timeout'
    case 'queued':
      return 'pending_approval'
    default:
      return 'idle'
  }
}

function cloneState(state: CustomerDisplayState): CustomerDisplayState {
  return {
    ...state,
    order: {
      ...state.order,
      items: state.order.items.map((item) => ({ ...item })),
      recentChanges: state.order.recentChanges.map((change) => ({ ...change })),
    },
    suggestions: state.suggestions.map((entry) => ({ ...entry })),
    message: state.message ? { ...state.message } : null,
  }
}

function toRecord(value: unknown): Record<string, unknown> {
  return value && typeof value === 'object' ? (value as Record<string, unknown>) : {}
}

function readTimestamp(event: Record<string, unknown>): number {
  return typeof event.timestamp === 'number' && Number.isFinite(event.timestamp)
    ? event.timestamp
    : Date.now()
}

function readString(value: unknown): string | null {
  return typeof value === 'string' && value.length > 0 ? value : null
}

function readStringArray(value: unknown): string[] {
  return Array.isArray(value)
    ? value.filter((entry): entry is string => typeof entry === 'string' && entry.length > 0)
    : []
}

function readNumber(value: unknown): number | null {
  return typeof value === 'number' && Number.isFinite(value) ? value : null
}
