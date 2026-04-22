import { describe, expect, it } from 'vitest'
import { InMemoryBus } from 'fitalyagents'
import { publishUiDemoFlow } from './demo-publisher.js'

describe('demo-publisher', () => {
  it('publishes a complete UI demo flow', async () => {
    const bus = new InMemoryBus()
    const channels: string[] = []

    for (const channel of [
      'bus:TARGET_GROUP_CHANGED',
      'bus:SPEECH_FINAL',
      'bus:RESPONSE_START',
      'bus:AVATAR_SPEAK',
      'bus:RESPONSE_END',
      'bus:DRAFT_CREATED',
      'bus:DRAFT_CONFIRMED',
      'bus:TOOL_RESULT',
      'bus:ORDER_QUEUED_NO_APPROVER',
      'bus:APPROVAL_RESOLVED',
      'bus:UI_UPDATE',
    ]) {
      bus.subscribe(channel, () => {
        channels.push(channel)
      })
    }

    const summary = await publishUiDemoFlow({
      bus,
      storeId: 'store-test',
      stepDelayMs: 0,
    })

    expect(summary).toMatchObject({
      speakerId: 'speaker-demo-01',
      sessionId: 'session:speaker-demo-01',
      turnId: 'turn:session:speaker-demo-01:1',
    })
    expect(channels).toEqual([
      'bus:TARGET_GROUP_CHANGED',
      'bus:SPEECH_FINAL',
      'bus:RESPONSE_START',
      'bus:AVATAR_SPEAK',
      'bus:AVATAR_SPEAK',
      'bus:RESPONSE_END',
      'bus:UI_UPDATE',
      'bus:DRAFT_CREATED',
      'bus:UI_UPDATE',
      'bus:DRAFT_CONFIRMED',
      'bus:TOOL_RESULT',
      'bus:TOOL_RESULT',
      'bus:ORDER_QUEUED_NO_APPROVER',
      'bus:UI_UPDATE',
      'bus:APPROVAL_RESOLVED',
      'bus:TOOL_RESULT',
    ])
  })
})
