import type { IEventBus, Unsubscribe } from '../../types/index.js'
import type { IApprovalChannel, ApprovalRequest, ApprovalResponse, HumanProfile } from './types.js'

/**
 * VoiceApprovalChannel — asks the approver via voice (TTS on the store speaker).
 *
 * Notify: publishes `bus:APPROVAL_VOICE_REQUEST` with a generated prompt.
 * Listen: subscribes to `bus:SPEECH_FINAL` and checks if the speaker
 *         matches the expected approver and said an affirmative/negative word.
 */
export class VoiceApprovalChannel implements IApprovalChannel {
  readonly id: string
  readonly type = 'voice' as const

  private readonly bus: IEventBus
  private activeWaits: Map<
    string,
    {
      resolve: (value: ApprovalResponse | null) => void
      unsub: Unsubscribe
      timer: ReturnType<typeof setTimeout>
    }
  > = new Map()

  constructor(deps: { bus: IEventBus; id?: string }) {
    this.bus = deps.bus
    this.id = deps.id ?? 'voice'
  }

  async notify(request: ApprovalRequest, approver: HumanProfile): Promise<void> {
    const promptText = this.buildPrompt(request, approver)

    await this.bus.publish('bus:APPROVAL_VOICE_REQUEST', {
      event: 'APPROVAL_VOICE_REQUEST',
      request_id: request.id,
      draft_id: request.draft_id,
      approver_id: approver.id,
      prompt_text: promptText,
    })
  }

  waitForResponse(request: ApprovalRequest, timeoutMs: number): Promise<ApprovalResponse | null> {
    return new Promise<ApprovalResponse | null>((resolve) => {
      const timer = setTimeout(() => {
        this.cleanup(request.id)
        resolve(null)
      }, timeoutMs)

      if (typeof timer === 'object' && 'unref' in timer) {
        timer.unref()
      }

      const unsub = this.bus.subscribe('bus:SPEECH_FINAL', (data) => {
        const event = data as {
          session_id: string
          text: string
          speaker_id?: string
        }

        // Check if the speaker matches the expected approver
        if (!event.speaker_id) return
        const expectedApproverId = request.context.expected_approver_id
        if (typeof expectedApproverId === 'string' && event.speaker_id !== expectedApproverId) {
          return
        }

        const isAffirmative = this.detectAffirmative(event.text)
        const isNegative = this.detectNegative(event.text)

        if (!isAffirmative && !isNegative) return

        this.cleanup(request.id)
        resolve({
          approved: isAffirmative,
          approver_id: event.speaker_id,
          channel_used: 'voice',
          reason: isNegative ? event.text : undefined,
          timestamp: Date.now(),
        })
      })

      this.activeWaits.set(request.id, { resolve, unsub, timer })
    })
  }

  cancel(requestId: string): void {
    const wait = this.activeWaits.get(requestId)
    if (wait) {
      this.cleanup(requestId)
      wait.resolve(null)
    }
  }

  // ── Private ──────────────────────────────────────────────────────────

  private buildPrompt(request: ApprovalRequest, approver: HumanProfile): string {
    const amountStr = request.amount != null ? ` de ₡${request.amount.toLocaleString()}` : ''
    return `${approver.name}, ¿aprueba ${request.action}${amountStr}?`
  }

  private detectAffirmative(text: string): boolean {
    const normalized = text.toLowerCase().trim()
    const affirmatives = [
      'sí',
      'si',
      'dale',
      'aprobado',
      'ok',
      'confirmo',
      'yes',
      'approve',
      'approved',
    ]
    return affirmatives.some((word) => normalized.includes(word))
  }

  private detectNegative(text: string): boolean {
    const normalized = text.toLowerCase().trim()
    const negatives = ['no', 'rechaza', 'no autorizo', 'denegar', 'deny', 'reject', 'rejected']
    return negatives.some((word) => normalized.includes(word))
  }

  private cleanup(requestId: string): void {
    const wait = this.activeWaits.get(requestId)
    if (wait) {
      clearTimeout(wait.timer)
      wait.unsub()
      this.activeWaits.delete(requestId)
    }
  }
}
