import { StreamAgent } from './stream-agent.js'
import type { IContextStore } from '../context/types.js'
import type { IEventBus, SentimentLevel, SessionSentimentAlert } from '../types/index.js'

export interface SentimentGuardConfig {
  /** Consecutive samples at or above minAlertLevel before alerting. Default: 2. */
  alertThreshold?: number
  /** Sliding window size in samples. Default: 5. */
  windowSize?: number
  /** Minimum level that counts toward an alert. Default: 'tense'. */
  minAlertLevel?: SentimentLevel
}

export interface SentimentGuardDeps {
  bus: IEventBus
  contextStore: IContextStore
  config?: SentimentGuardConfig
}

export interface SentimentSample {
  level: SentimentLevel
  text?: string
  speaker_id?: string
  timestamp: number
}

type AmbientPayload = {
  session_id?: string
  speaker_id?: string
  text?: string
  sentiment?: string | null
  timestamp?: number
}

const DEFAULT_ALERT_THRESHOLD = 2
const DEFAULT_WINDOW_SIZE = 5
const DEFAULT_MIN_ALERT_LEVEL: SentimentLevel = 'tense'

const SENTIMENT_SCORE: Record<SentimentLevel, number> = {
  positive: 0,
  neutral: 1,
  tense: 2,
  frustrated: 3,
  angry: 4,
}

const KEYWORDS: Array<{ level: SentimentLevel; patterns: RegExp[] }> = [
  {
    level: 'angry',
    patterns: [
      /\bangry\b/i,
      /\bfurious\b/i,
      /\bridiculous\b/i,
      /\blawsuit\b/i,
      /\bnever coming back\b/i,
      /\bestafa\b/i,
      /\bfuri(?:a|oso|osa)\b/i,
      /\bmaldito\b/i,
      /\basco\b/i,
      /\bdenuncia\b/i,
      /\bno vuelvo\b/i,
      /\brobo\b/i,
    ],
  },
  {
    level: 'frustrated',
    patterns: [
      /\bfrustrated\b/i,
      /\bannoyed\b/i,
      /\bwaiting forever\b/i,
      /\bnot working\b/i,
      /\bcansad[oa]\b/i,
      /\bmolest[oa]\b/i,
      /\bhart[oa]\b/i,
      /\botra vez\b/i,
      /\bno funciona\b/i,
      /\bdemasiado lento\b/i,
    ],
  },
  {
    level: 'tense',
    patterns: [
      /\bconcerned\b/i,
      /\bworried\b/i,
      /\bproblem\b/i,
      /\bissue\b/i,
      /\bconfused\b/i,
      /\bwaiting\b/i,
      /\bpreocupad[oa]\b/i,
      /\bproblema\b/i,
      /\bconfundid[oa]\b/i,
      /\besperando\b/i,
      /\btarde\b/i,
    ],
  },
  {
    level: 'positive',
    patterns: [
      /\bgreat\b/i,
      /\bperfect\b/i,
      /\bexcellent\b/i,
      /\bawesome\b/i,
      /\bthanks?\b/i,
      /\bbueno\b/i,
      /\bexcelente\b/i,
      /\bgracias\b/i,
      /\bperfecto\b/i,
      /\bme encanta\b/i,
    ],
  },
]

export class SentimentGuard extends StreamAgent {
  private readonly contextStore: IContextStore
  private readonly alertThreshold: number
  private readonly windowSize: number
  private readonly minAlertLevel: SentimentLevel
  private readonly windows = new Map<string, SentimentSample[]>()
  private readonly activeAlerts = new Set<string>()

  constructor(deps: SentimentGuardDeps) {
    super(deps.bus)
    this.contextStore = deps.contextStore
    this.alertThreshold = Math.max(1, deps.config?.alertThreshold ?? DEFAULT_ALERT_THRESHOLD)
    this.windowSize = Math.max(1, deps.config?.windowSize ?? DEFAULT_WINDOW_SIZE)
    this.minAlertLevel = deps.config?.minAlertLevel ?? DEFAULT_MIN_ALERT_LEVEL
  }

  protected get channels(): string[] {
    return ['bus:AMBIENT_CONTEXT']
  }

  async onEvent(channel: string, payload: unknown): Promise<void> {
    if (channel !== 'bus:AMBIENT_CONTEXT') return

    const data = payload as AmbientPayload
    if (!data.session_id || (!data.text && !data.sentiment)) return

    const sample = this.recordSample(data)
    await this.persistState(data.session_id, sample)

    const highRun = this.getConsecutiveHighRun(data.session_id)
    if (highRun.count === 0) {
      this.activeAlerts.delete(data.session_id)
      return
    }

    if (highRun.count < this.alertThreshold || this.activeAlerts.has(data.session_id)) return

    this.activeAlerts.add(data.session_id)
    await this.publishAlert(data.session_id, sample, highRun)
  }

  classifySentiment(text: string | undefined, sentiment?: string | null): SentimentLevel {
    const hinted = this.classifyHint(sentiment)
    const inferred = this.classifyText(text)

    if (hinted === 'neutral') return inferred
    if (inferred === 'neutral') return hinted
    if (hinted === 'positive' && inferred !== 'positive') return inferred
    if (inferred === 'positive' && hinted !== 'positive') return hinted

    return SENTIMENT_SCORE[hinted] >= SENTIMENT_SCORE[inferred] ? hinted : inferred
  }

  getWindow(sessionId: string): SentimentSample[] {
    return [...(this.windows.get(sessionId) ?? [])]
  }

  private recordSample(data: AmbientPayload): SentimentSample {
    const sample: SentimentSample = {
      level: this.classifySentiment(data.text, data.sentiment),
      text: data.text,
      speaker_id: data.speaker_id,
      timestamp: data.timestamp ?? Date.now(),
    }

    const window = this.windows.get(data.session_id!) ?? []
    window.push(sample)
    while (window.length > this.windowSize) {
      window.shift()
    }
    this.windows.set(data.session_id!, window)

    return sample
  }

  private async persistState(sessionId: string, sample: SentimentSample): Promise<void> {
    const window = this.windows.get(sessionId) ?? []
    const highRun = this.getConsecutiveHighRun(sessionId)

    await this.contextStore.patch(sessionId, {
      sentiment_level: sample.level,
      sentiment_window: window.map(({ level, timestamp, speaker_id }) => ({
        level,
        timestamp,
        speaker_id,
      })),
      sentiment_alert_level: highRun.count >= this.alertThreshold ? highRun.level : null,
      sentiment_alert_count: highRun.count,
    })
  }

  private getConsecutiveHighRun(sessionId: string): { count: number; level: SentimentLevel } {
    const window = this.windows.get(sessionId) ?? []
    let count = 0
    let maxLevel: SentimentLevel = 'neutral'

    for (let i = window.length - 1; i >= 0; i -= 1) {
      const sample = window[i]!
      if (!this.isAtOrAboveAlertLevel(sample.level)) break

      count += 1
      if (SENTIMENT_SCORE[sample.level] > SENTIMENT_SCORE[maxLevel]) {
        maxLevel = sample.level
      }
    }

    return { count, level: maxLevel }
  }

  private async publishAlert(
    sessionId: string,
    sample: SentimentSample,
    highRun: { count: number; level: SentimentLevel },
  ): Promise<void> {
    const alert: SessionSentimentAlert = {
      event: 'SESSION_SENTIMENT_ALERT',
      session_id: sessionId,
      level: highRun.level,
      consecutive_count: highRun.count,
      trigger_text: sample.text,
      speaker_id: sample.speaker_id,
      timestamp: Date.now(),
    }

    await this.bus.publish('bus:SESSION_SENTIMENT_ALERT', alert)
  }

  private isAtOrAboveAlertLevel(level: SentimentLevel): boolean {
    return SENTIMENT_SCORE[level] >= SENTIMENT_SCORE[this.minAlertLevel]
  }

  private classifyHint(sentiment: string | null | undefined): SentimentLevel {
    if (!sentiment) return 'neutral'

    const normalized = sentiment.trim().toLowerCase()
    if (normalized.includes('angry') || normalized.includes('furious')) return 'angry'
    if (normalized.includes('frustrated') || normalized.includes('negative')) return 'frustrated'
    if (normalized.includes('tense') || normalized.includes('concern')) return 'tense'
    if (normalized.includes('positive') || normalized.includes('happy')) return 'positive'
    return 'neutral'
  }

  private classifyText(text: string | undefined): SentimentLevel {
    if (!text) return 'neutral'

    for (const entry of KEYWORDS) {
      if (entry.patterns.some((pattern) => pattern.test(text))) {
        return entry.level
      }
    }

    return 'neutral'
  }
}
