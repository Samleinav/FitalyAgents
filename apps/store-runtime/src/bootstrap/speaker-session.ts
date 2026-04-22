export function buildSpeakerSessionId(storeId: string, speakerId: string): string {
  const normalizedStoreId = normalizeSessionSegment(storeId)
  const normalizedSpeakerId = normalizeSessionSegment(speakerId)
  return `session_${normalizedStoreId}_${normalizedSpeakerId}`
}

export function resolveIngressSessionId(args: {
  storeId: string
  captureDriver: 'local-stt' | 'voice-events' | 'external-bus'
  incomingSessionId?: string
  speakerId?: string
}): string | undefined {
  if (args.captureDriver === 'local-stt') {
    return args.incomingSessionId
  }

  if (args.speakerId) {
    return buildSpeakerSessionId(args.storeId, args.speakerId)
  }

  return args.incomingSessionId
}

function normalizeSessionSegment(value: string): string {
  const normalized = value.trim().replace(/[^a-zA-Z0-9_-]+/g, '_')
  return normalized || 'unknown'
}
