export interface DashboardSpeakerState {
  speakerId: string
  state: string
}

export interface DashboardQueueState {
  primary: string | null
  queued: string[]
  ambient: string[]
  speakers: DashboardSpeakerState[]
}

export interface DashboardTranscriptTurn {
  id: string
  sessionId: string
  speakerId: string | null
  role: string | null
  assistantTurnId: string | null
  userText: string
  assistantText: string
  status: 'heard' | 'responding' | 'completed' | 'error'
  createdAt: number
  updatedAt: number
}

export interface DashboardComponentState {
  component: string
  action: string
  visible: boolean
  data: unknown
  updatedAt: number
}

export interface DashboardEventLogEntry {
  id: string
  channel: string
  summary: string
  timestamp: number
}

export interface DashboardPendingApproval {
  requestId: string
  draftId: string | null
  sessionId: string | null
  requiredRole: string | null
  quorumRequired: number | null
  eligibleRoles: string[]
  queuedAt: number
}

export interface DashboardResolvedApproval {
  requestId: string
  draftId: string | null
  sessionId: string | null
  approved: boolean
  approverId: string | null
  approvers: string[]
  channelUsed: string | null
  strategy: string | null
  resolvedAt: number
}

export interface StoreDashboardState {
  storeId: string
  updatedAt: number | null
  queue: DashboardQueueState
  approvals: {
    pending: DashboardPendingApproval[]
    lastResolved: DashboardResolvedApproval | null
    timeoutCount: number
  }
  transcript: {
    activeSessionId: string | null
    activeTurnId: string | null
    turns: DashboardTranscriptTurn[]
  }
  components: Record<string, DashboardComponentState>
  recentEvents: DashboardEventLogEntry[]
}

const MAX_TRANSCRIPT_TURNS = 20
const MAX_RECENT_EVENTS = 30

export class StoreDashboardStateStore {
  private state: StoreDashboardState

  constructor(storeId: string) {
    this.state = createStoreDashboardState(storeId)
  }

  apply(channel: string, payload: unknown): StoreDashboardState {
    this.state = applyDashboardBusEvent(this.state, channel, payload)
    return this.state
  }

  getState(): StoreDashboardState {
    return this.state
  }
}

export function createStoreDashboardState(storeId: string): StoreDashboardState {
  return {
    storeId,
    updatedAt: null,
    queue: {
      primary: null,
      queued: [],
      ambient: [],
      speakers: [],
    },
    approvals: {
      pending: [],
      lastResolved: null,
      timeoutCount: 0,
    },
    transcript: {
      activeSessionId: null,
      activeTurnId: null,
      turns: [],
    },
    components: {},
    recentEvents: [],
  }
}

export function applyDashboardBusEvent(
  current: StoreDashboardState,
  channel: string,
  payload: unknown,
): StoreDashboardState {
  const event = toRecord(payload)
  const timestamp = readTimestamp(event)
  const next = cloneState(current)

  switch (channel) {
    case 'bus:TARGET_GROUP_CHANGED':
      next.queue = {
        primary: readString(event.primary),
        queued: readStringArray(event.queued),
        ambient: readStringArray(event.ambient),
        speakers: readSpeakerStates(event.speakers),
      }
      if (typeof event.store_id === 'string' && event.store_id) {
        next.storeId = event.store_id
      }
      break

    case 'bus:SPEECH_FINAL':
      applySpeechFinal(next, event, timestamp)
      break

    case 'bus:RESPONSE_START':
      applyResponseStart(next, event, timestamp)
      break

    case 'bus:AVATAR_SPEAK':
      applyAvatarSpeak(next, event, timestamp)
      break

    case 'bus:RESPONSE_END':
      applyResponseEnd(next, event, timestamp)
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
      applyApprovalTimeout(next, event)
      break

    default:
      return current
  }

  next.updatedAt = timestamp
  appendRecentEvent(next, channel, event, timestamp)
  return next
}

function applySpeechFinal(
  state: StoreDashboardState,
  event: Record<string, unknown>,
  timestamp: number,
): void {
  const text = readString(event.text)
  const sessionId = readString(event.session_id) ?? 'unknown-session'
  const speakerId = readString(event.speaker_id)
  const role = readString(event.role)

  if (!text) {
    return
  }

  state.transcript.turns.push({
    id: `heard:${sessionId}:${timestamp}:${state.transcript.turns.length + 1}`,
    sessionId,
    speakerId,
    role,
    assistantTurnId: null,
    userText: text,
    assistantText: '',
    status: 'heard',
    createdAt: timestamp,
    updatedAt: timestamp,
  })
  trimTranscript(state)
  state.transcript.activeSessionId = sessionId
}

function applyResponseStart(
  state: StoreDashboardState,
  event: Record<string, unknown>,
  timestamp: number,
): void {
  const sessionId = readString(event.session_id) ?? 'unknown-session'
  const speakerId = readString(event.speaker_id)
  const turnId = readString(event.turn_id) ?? `turn:${sessionId}:${timestamp}`
  const turn = ensureAssistantTurn(state, sessionId, speakerId, turnId, timestamp)
  turn.status = 'responding'
  turn.updatedAt = timestamp
  state.transcript.activeSessionId = sessionId
  state.transcript.activeTurnId = turnId
}

function applyAvatarSpeak(
  state: StoreDashboardState,
  event: Record<string, unknown>,
  timestamp: number,
): void {
  const sessionId = readString(event.session_id) ?? 'unknown-session'
  const speakerId = readString(event.speaker_id)
  const turnId = readString(event.turn_id) ?? `turn:${sessionId}:${timestamp}`
  const text = readString(event.text)

  if (!text) {
    return
  }

  const turn = ensureAssistantTurn(state, sessionId, speakerId, turnId, timestamp)
  turn.assistantText = appendAssistantText(turn.assistantText, text)
  turn.status = 'responding'
  turn.updatedAt = timestamp
  state.transcript.activeSessionId = sessionId
  state.transcript.activeTurnId = turnId
}

function applyResponseEnd(
  state: StoreDashboardState,
  event: Record<string, unknown>,
  timestamp: number,
): void {
  const sessionId = readString(event.session_id) ?? 'unknown-session'
  const speakerId = readString(event.speaker_id)
  const turnId = readString(event.turn_id) ?? `turn:${sessionId}:${timestamp}`
  const reason = readString(event.reason)
  const turn = ensureAssistantTurn(state, sessionId, speakerId, turnId, timestamp)

  turn.status = reason === 'error' ? 'error' : 'completed'
  turn.updatedAt = timestamp
  state.transcript.activeSessionId = sessionId
  state.transcript.activeTurnId = turnId
}

function applyUiUpdate(
  state: StoreDashboardState,
  event: Record<string, unknown>,
  timestamp: number,
): void {
  const component = readString(event.component)
  const action = readString(event.action)

  if (!component || !action) {
    return
  }

  state.components[component] = {
    component,
    action,
    visible: action !== 'hide',
    data: event.data ?? null,
    updatedAt: timestamp,
  }

  if (component !== 'queue_status') {
    if (component === 'approval_queue') {
      const data = toRecord(event.data)
      if (action === 'hide') {
        removePendingApproval(state, readString(data.request_id), readString(data.draft_id))
        return
      }

      upsertPendingApproval(state, {
        requestId: readString(data.request_id) ?? 'unknown-request',
        draftId: readString(data.draft_id),
        sessionId: readString(data.session_id),
        requiredRole: readString(data.required_role),
        quorumRequired: readNumber(data.quorum_required),
        eligibleRoles: readStringArray(data.eligible_roles),
        queuedAt: readNumber(data.queued_at) ?? timestamp,
      })
      return
    }

    if (component === 'approval_bar') {
      const data = toRecord(event.data)
      const requestId = readString(data.request_id)
      if (!requestId || typeof data.approved !== 'boolean') {
        return
      }

      state.approvals.lastResolved = {
        requestId,
        draftId: readString(data.draft_id),
        sessionId: readString(data.session_id),
        approved: data.approved,
        approverId: readString(data.approver_id),
        approvers: readStringArray(data.approvers),
        channelUsed: readString(data.channel_used),
        strategy: readString(data.strategy),
        resolvedAt: timestamp,
      }
      removePendingApproval(state, requestId, readString(data.draft_id))
    }

    return
  }

  const data = toRecord(event.data)
  state.queue = {
    primary: readString(data.primary),
    queued: readStringArray(data.queued),
    ambient: readStringArray(data.ambient),
    speakers: readSpeakerStates(data.speakers),
  }
}

function applyApprovalQueued(
  state: StoreDashboardState,
  event: Record<string, unknown>,
  timestamp: number,
): void {
  const requestId = readString(event.request_id)
  if (!requestId) {
    return
  }

  upsertPendingApproval(state, {
    requestId,
    draftId: readString(event.draft_id),
    sessionId: readString(event.session_id),
    requiredRole: readString(event.required_role),
    quorumRequired: readNumber(event.quorum_required),
    eligibleRoles: readStringArray(event.eligible_roles),
    queuedAt: readNumber(event.queued_at) ?? timestamp,
  })
}

function applyApprovalResolved(
  state: StoreDashboardState,
  event: Record<string, unknown>,
  timestamp: number,
): void {
  const requestId = readString(event.request_id)
  if (!requestId || typeof event.approved !== 'boolean') {
    return
  }

  state.approvals.lastResolved = {
    requestId,
    draftId: readString(event.draft_id),
    sessionId: readString(event.session_id),
    approved: event.approved,
    approverId: readString(event.approver_id),
    approvers: readStringArray(event.approvers),
    channelUsed: readString(event.channel_used),
    strategy: readString(event.strategy),
    resolvedAt: timestamp,
  }
  removePendingApproval(state, requestId, readString(event.draft_id))
}

function applyApprovalTimeout(state: StoreDashboardState, event: Record<string, unknown>): void {
  state.approvals.timeoutCount += 1
  removePendingApproval(state, readString(event.request_id), readString(event.draft_id))
}

function upsertPendingApproval(
  state: StoreDashboardState,
  approval: DashboardPendingApproval,
): void {
  const existingIndex = state.approvals.pending.findIndex(
    (entry) => entry.requestId === approval.requestId,
  )

  if (existingIndex === -1) {
    state.approvals.pending.push(approval)
  } else {
    state.approvals.pending[existingIndex] = approval
  }

  state.approvals.pending.sort((left, right) => left.queuedAt - right.queuedAt)
}

function removePendingApproval(
  state: StoreDashboardState,
  requestId: string | null,
  draftId: string | null,
): void {
  state.approvals.pending = state.approvals.pending.filter((entry) => {
    if (requestId && entry.requestId === requestId) {
      return false
    }

    if (draftId && entry.draftId === draftId) {
      return false
    }

    return true
  })
}

function ensureAssistantTurn(
  state: StoreDashboardState,
  sessionId: string,
  speakerId: string | null,
  turnId: string,
  timestamp: number,
): DashboardTranscriptTurn {
  let turn =
    state.transcript.turns.find((candidate) => candidate.assistantTurnId === turnId) ??
    findLatestTurn(state.transcript.turns, sessionId, speakerId)

  if (!turn) {
    turn = {
      id: `assistant:${turnId}`,
      sessionId,
      speakerId,
      role: 'agent',
      assistantTurnId: turnId,
      userText: '',
      assistantText: '',
      status: 'heard',
      createdAt: timestamp,
      updatedAt: timestamp,
    }
    state.transcript.turns.push(turn)
    trimTranscript(state)
  }

  turn.assistantTurnId = turnId
  return turn
}

function findLatestTurn(
  turns: DashboardTranscriptTurn[],
  sessionId: string,
  speakerId: string | null,
): DashboardTranscriptTurn | null {
  for (let index = turns.length - 1; index >= 0; index -= 1) {
    const turn = turns[index]
    if (turn.sessionId !== sessionId) {
      continue
    }
    if (speakerId && turn.speakerId && turn.speakerId !== speakerId) {
      continue
    }
    return turn
  }

  return null
}

function trimTranscript(state: StoreDashboardState): void {
  if (state.transcript.turns.length <= MAX_TRANSCRIPT_TURNS) {
    return
  }

  state.transcript.turns = state.transcript.turns.slice(-MAX_TRANSCRIPT_TURNS)
}

function appendRecentEvent(
  state: StoreDashboardState,
  channel: string,
  event: Record<string, unknown>,
  timestamp: number,
): void {
  const summary = summarizeEvent(channel, event)
  if (!summary) {
    return
  }

  state.recentEvents.push({
    id: `${channel}:${timestamp}:${state.recentEvents.length + 1}`,
    channel,
    summary,
    timestamp,
  })

  if (state.recentEvents.length > MAX_RECENT_EVENTS) {
    state.recentEvents = state.recentEvents.slice(-MAX_RECENT_EVENTS)
  }
}

function summarizeEvent(channel: string, event: Record<string, unknown>): string | null {
  switch (channel) {
    case 'bus:TARGET_GROUP_CHANGED':
      return `Target ${readString(event.primary) ?? 'sin cliente'} · cola ${readStringArray(event.queued).length} · ambiente ${readStringArray(event.ambient).length}`
    case 'bus:SPEECH_FINAL':
      return `Cliente ${readString(event.speaker_id) ?? 'desconocido'}: ${truncate(readString(event.text) ?? '', 72)}`
    case 'bus:RESPONSE_START':
      return `Asistente respondiendo en ${readString(event.session_id) ?? 'sin sesión'}`
    case 'bus:AVATAR_SPEAK':
      return `Respuesta: ${truncate(readString(event.text) ?? '', 72)}`
    case 'bus:RESPONSE_END':
      return `Respuesta finalizada (${readString(event.reason) ?? 'end_turn'})`
    case 'bus:ORDER_QUEUED_NO_APPROVER':
      return `Aprobación en cola · ${readString(event.required_role) ?? 'sin rol'}`
    case 'bus:APPROVAL_RESOLVED':
      return `Aprobación ${event.approved === true ? 'aprobada' : 'rechazada'} · ${readString(event.approver_id) ?? 'sin aprobador'}`
    case 'bus:ORDER_APPROVAL_TIMEOUT':
      return `Aprobación expirada · ${readString(event.request_id) ?? 'sin request'}`
    case 'bus:UI_UPDATE':
      return `UI ${readString(event.component) ?? 'component'} · ${readString(event.action) ?? 'update'}`
    default:
      return null
  }
}

function cloneState(state: StoreDashboardState): StoreDashboardState {
  return {
    ...state,
    queue: {
      primary: state.queue.primary,
      queued: [...state.queue.queued],
      ambient: [...state.queue.ambient],
      speakers: state.queue.speakers.map((speaker) => ({ ...speaker })),
    },
    approvals: {
      pending: state.approvals.pending.map((entry) => ({
        ...entry,
        eligibleRoles: [...entry.eligibleRoles],
      })),
      lastResolved: state.approvals.lastResolved
        ? {
            ...state.approvals.lastResolved,
            approvers: [...state.approvals.lastResolved.approvers],
          }
        : null,
      timeoutCount: state.approvals.timeoutCount,
    },
    transcript: {
      activeSessionId: state.transcript.activeSessionId,
      activeTurnId: state.transcript.activeTurnId,
      turns: state.transcript.turns.map((turn) => ({ ...turn })),
    },
    components: Object.fromEntries(
      Object.entries(state.components).map(([key, value]) => [key, { ...value }]),
    ),
    recentEvents: state.recentEvents.map((entry) => ({ ...entry })),
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

function readSpeakerStates(value: unknown): DashboardSpeakerState[] {
  if (!Array.isArray(value)) {
    return []
  }

  return value.flatMap((entry) => {
    if (!entry || typeof entry !== 'object') {
      return []
    }

    const record = entry as Record<string, unknown>
    const speakerId = readString(record.speakerId)
    const state = readString(record.state)
    if (!speakerId || !state) {
      return []
    }

    return [{ speakerId, state }]
  })
}

function appendAssistantText(current: string, next: string): string {
  const normalized = next.replace(/\s+/g, ' ').trim()
  if (!normalized) {
    return current
  }

  if (!current) {
    return normalized
  }

  if (/^[,.;:!?)]/.test(normalized)) {
    return `${current}${normalized}`
  }

  return `${current} ${normalized}`
}

function truncate(value: string, maxLength: number): string {
  if (value.length <= maxLength) {
    return value
  }

  return `${value.slice(0, maxLength - 1)}…`
}
