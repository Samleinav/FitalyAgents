import {
  ExternalToolChannel,
  VoiceApprovalChannel,
  WebhookApprovalChannel,
  type IApprovalChannel,
  type ApprovalRequest,
  type HumanProfile,
  type ApprovalResponse,
} from 'fitalyagents'
import type { IEventBus } from 'fitalyagents'
import type { StoreConfig } from '../config/schema.js'
import type { WebhookRepository } from '../storage/repositories/webhooks.js'

export function buildApprovalChannels(
  config: StoreConfig,
  bus: IEventBus,
  webhookRepository: WebhookRepository,
): Map<string, IApprovalChannel> {
  const registry = new Map<string, IApprovalChannel>()
  const channelTypes = new Set(config.approvals.default_channels.map((channel) => channel.type))

  if (channelTypes.has('voice')) {
    registry.set(
      'voice',
      new TrackingApprovalChannel({
        inner: new VoiceApprovalChannel({ bus }),
        webhookRepository,
        url: 'voice://store-speaker',
      }),
    )
  }

  if (channelTypes.has('webhook')) {
    registry.set(
      'webhook',
      new TrackingApprovalChannel({
        inner: new WebhookApprovalChannel({ bus }),
        webhookRepository,
        url:
          config.webhooks.approval_push_url ??
          `http://${config.http.host}:${config.http.port}${config.webhooks.approval_response_path}`,
      }),
    )
  }

  if (channelTypes.has('external_tool')) {
    const url = config.webhooks.approval_push_url ?? process.env.EXTERNAL_APPROVAL_URL ?? undefined

    if (url) {
      registry.set(
        'external_tool',
        new TrackingApprovalChannel({
          inner: new ExternalToolChannel({
            bus,
            config: {
              url,
              method: 'POST',
              auth: process.env.EXTERNAL_APPROVAL_BEARER_TOKEN
                ? `Bearer ${process.env.EXTERNAL_APPROVAL_BEARER_TOKEN}`
                : undefined,
            },
          }),
          webhookRepository,
          url,
        }),
      )
    }
  }

  return registry
}

class TrackingApprovalChannel implements IApprovalChannel {
  readonly id: string
  readonly type: IApprovalChannel['type']

  constructor(
    private readonly deps: {
      inner: IApprovalChannel
      webhookRepository: WebhookRepository
      url: string
    },
  ) {
    this.id = deps.inner.id
    this.type = deps.inner.type
  }

  async notify(request: ApprovalRequest, approver: HumanProfile): Promise<void> {
    const deliveryId = `${this.type}_${request.id}`

    this.deps.webhookRepository.insert({
      id: deliveryId,
      url: this.deps.url,
      payload: {
        request_id: request.id,
        approver_id: approver.id,
        channel: this.type,
      },
      status: 'pending',
      attempts: 0,
      created_at: Date.now(),
      sent_at: null,
    })

    try {
      await this.deps.inner.notify(request, approver)
      this.deps.webhookRepository.markSent(deliveryId)
    } catch (error) {
      this.deps.webhookRepository.markFailed(
        deliveryId,
        error instanceof Error ? error.message : String(error),
      )
      throw error
    }
  }

  waitForResponse(request: ApprovalRequest, timeoutMs: number): Promise<ApprovalResponse | null> {
    return this.deps.inner.waitForResponse(request, timeoutMs)
  }

  cancel(requestId: string): void {
    this.deps.inner.cancel(requestId)
  }
}
